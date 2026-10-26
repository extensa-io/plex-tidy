import type { Command } from 'commander';
import { z } from 'zod';
import { reconcileJournal } from '../apply/reconcile.ts';
import type { CliContext, ModeCommand } from '../cli-types.ts';
import { loadConfig, type Config } from '../config.ts';
import { AppError } from '../errors.ts';
import { requireEnv } from '../env.ts';
import { createAnthropicTitleModel } from '../llm/anthropic.ts';
import type { TitleModel } from '../llm/model-client.ts';
import { planSchema } from '../plan/schemas.ts';
import { resolveFileSchema } from '../resolve/schemas.ts';
import { createTerminalIO } from '../review/prompts.ts';
import type { ReviewIO } from '../review/review.ts';
import { scanSchema } from '../scan/schemas.ts';
import { readJsonFile, writeJsonFile } from '../state/json-file.ts';
import { openJournal } from '../state/journal.ts';
import type { Mode } from '../state/schemas.ts';
import { createBackends, type Backends } from '../tag/backends.ts';
import { createToolLocator, realRunner } from '../tag/runner.ts';
import { markUndone, planUndo, undoSteps } from '../undo/undo.ts';
import { guidedRun } from './guided.ts';
import { addRunOptions, createRunContext, requireDirectory, requireState, type RunContext } from './shared.ts';
import {
  executeApply,
  journalCheck,
  logPlanSummary,
  logReconcile,
  parseStage,
  planStage,
  prepareApply,
  resolveStage,
  reviewStage,
  scanStage,
  tagStage,
} from './stages.ts';

/** What the videos commands need from outside, so tests can replace the model, the terminal, and config.json. */
export interface VideosDeps {
  loadConfig: () => Promise<Config>;
  createTitleModel: (run: RunContext) => TitleModel;
  createReviewIO: () => ReviewIO;
  /** The tag writers. They find their tools only when first used. */
  createBackends: (run: RunContext) => Backends;
}

const defaultDeps: VideosDeps = {
  loadConfig: () => loadConfig(),
  createTitleModel: (run) =>
    createAnthropicTitleModel({ apiKey: requireEnv('ANTHROPIC_API_KEY'), model: run.config.models.parse }),
  createReviewIO: createTerminalIO,
  createBackends: (run) => createBackends({ runner: realRunner, locate: createToolLocator(run.config.tools) }),
};

type Action = (run: RunContext, command: Command) => Promise<void>;

const undoOnlySchema = z.enum(['rename', 'tag']).optional();

export function createVideosCommands(deps: VideosDeps = defaultDeps): ModeCommand[] {
  const modeCommand = (
    name: string,
    description: string,
    withYes: boolean,
    action: Action,
    addOptions?: (command: Command) => void,
  ): ModeCommand => ({
    name,
    description,
    modes: ['videos'],
    register: (command: Command, mode: Mode, cli: CliContext) => {
      addRunOptions(command, withYes);
      addOptions?.(command);
      command.action(async () => {
        await action(await createRunContext(command, mode, cli, deps.loadConfig), command);
      });
    },
  });

  const scanCommand = modeCommand('scan', 'list video files and subtitle files under the root', false, scanStage);

  const parseCommand = modeCommand('parse', 'ask the model for a title for each file', false, async (run) => {
    await requireState(run.paths.scan, scanSchema, 'scan');
    await parseStage(run, deps.createTitleModel(run));
  });

  const resolveCommand = modeCommand('resolve', 'choose a title for each file', false, resolveStage);

  const planCommand = modeCommand('plan', 'write the list of renames', false, async (run) => {
    await planStage(run);
  });

  const reviewCommand = modeCommand('review', 'go through the proposed names and decide', false, async (run) => {
    await reviewStage(run, deps.createReviewIO());
  });

  const applyCommand = modeCommand('apply', 'rename the approved files (dry run unless --yes)', true, async (run) => {
    const backends = deps.createBackends(run);
    const prep = await prepareApply(run, backends);
    if (!run.yes) {
      run.logger.list('renames that would happen', prep.moves.map((move) => `${move.from} -> ${move.to}`));
      run.logger.info('dry run: nothing was changed. Add --yes to rename.');
      return;
    }
    await executeApply(run, prep, backends);
  });

  const tagCommand = modeCommand(
    'tag',
    'write the titles into the renamed files (dry run unless --yes)',
    true,
    async (run) => {
      await tagStage(run, deps.createBackends(run));
    },
  );

  const undoCommand = modeCommand(
    'undo',
    'put the original names and tags back (dry run unless --yes)',
    true,
    async (run, command) => {
      const only = undoOnlySchema.safeParse(command.opts<{ only?: unknown }>().only);
      if (!only.success) {
        throw new AppError('OPTION_INVALID', '--only must be rename or tag.');
      }
      await requireDirectory(run.root);
      const backends = deps.createBackends(run);
      const journal = openJournal(run.paths.journal);
      logReconcile(run, await reconcileJournal(journal, journalCheck(run.root, backends), run.yes));

      const steps = await planUndo(journal, only.data);
      if (!run.yes) {
        run.logger.list(
          'operations that would be reversed',
          steps.map((step) => (step.kind === 'rename' ? `rename ${step.from} -> ${step.to}` : `tags of ${step.path}`)),
        );
        run.logger.info('dry run: nothing was changed. Add --yes to undo.');
        return;
      }

      const task = run.progress('undoing');
      const outcome = await undoSteps(steps, {
        root: run.root,
        journal,
        backends,
        onProgress: (done, total) => { task.update(done, total); },
      });
      task.done();
      const plan = await readJsonFile(run.paths.plan, planSchema);
      if (plan !== undefined) {
        await writeJsonFile(run.paths.plan, planSchema, markUndone(plan, outcome.restoredRenames, outcome.restoredTags));
      }
      run.logger.info(`undid ${outcome.restored} operations; ${outcome.failed} could not be undone`);
      if (outcome.failed > 0) {
        process.exitCode = 1;
      }
    },
    (command) => {
      command.option('--only <kind>', 'undo only renames (rename) or only tags (tag)');
    },
  );

  const statusCommand = modeCommand('status', 'show what stage the root is at', false, async (run) => {
    const [scan, resolved, plan] = await Promise.all([
      readJsonFile(run.paths.scan, scanSchema),
      readJsonFile(run.paths.resolve, resolveFileSchema),
      readJsonFile(run.paths.plan, planSchema),
    ]);
    const stage = (done: boolean) => (done ? 'done' : 'not done');
    run.logger.info(
      `scan: ${stage(scan !== undefined)}; parse and resolve: ${stage(resolved?.entries.some((entry) => entry.resolution !== null) ?? false)}; plan: ${stage(plan !== undefined)}`,
    );
    if (plan !== undefined) {
      logPlanSummary(run, plan);
    }
    const open = await openJournal(run.paths.journal).unmatchedIntents();
    if (open.length > 0) {
      run.logger.warn(`${open.length} journal intents have no done record; apply or undo will check them`);
    }
  });

  const runCommand = modeCommand('run', 'prepare, review, and rename, asking before each step', false, async (run) => {
    await guidedRun(run, {
      io: deps.createReviewIO(),
      createTitleModel: deps.createTitleModel,
      createBackends: deps.createBackends,
    });
  });

  return [
    runCommand,
    scanCommand,
    parseCommand,
    resolveCommand,
    planCommand,
    reviewCommand,
    applyCommand,
    tagCommand,
    undoCommand,
    statusCommand,
  ];
}

export const videosCommands: readonly ModeCommand[] = createVideosCommands();
