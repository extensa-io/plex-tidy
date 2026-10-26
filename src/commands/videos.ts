import type { Command } from 'commander';
import { reconcileJournal } from '../apply/reconcile.ts';
import type { CliContext, ModeCommand } from '../cli-types.ts';
import { loadConfig, type Config } from '../config.ts';
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
import { markUndone, planUndo, undoRenames } from '../undo/undo.ts';
import { guidedRun } from './guided.ts';
import { addRunOptions, createRunContext, pathExists, requireDirectory, requireState, type RunContext } from './shared.ts';
import {
  executeApply,
  logPlanSummary,
  logReconcile,
  parseStage,
  planStage,
  prepareApply,
  resolveStage,
  reviewStage,
  scanStage,
} from './stages.ts';

/** What the videos commands need from outside, so tests can replace the model, the terminal, and config.json. */
export interface VideosDeps {
  loadConfig: () => Promise<Config>;
  createTitleModel: (run: RunContext) => TitleModel;
  createReviewIO: () => ReviewIO;
}

const defaultDeps: VideosDeps = {
  loadConfig: () => loadConfig(),
  createTitleModel: (run) =>
    createAnthropicTitleModel({ apiKey: requireEnv('ANTHROPIC_API_KEY'), model: run.config.models.parse }),
  createReviewIO: createTerminalIO,
};

type Action = (run: RunContext) => Promise<void>;

export function createVideosCommands(deps: VideosDeps = defaultDeps): ModeCommand[] {
  const modeCommand = (name: string, description: string, withYes: boolean, action: Action): ModeCommand => ({
    name,
    description,
    modes: ['videos'],
    register: (command: Command, mode: Mode, cli: CliContext) => {
      addRunOptions(command, withYes).action(async () => {
        await action(await createRunContext(command, mode, cli, deps.loadConfig));
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
    const prep = await prepareApply(run);
    if (!run.yes) {
      run.logger.list('renames that would happen', prep.moves.map((move) => `${move.from} -> ${move.to}`));
      run.logger.info('dry run: nothing was changed. Add --yes to rename.');
      return;
    }
    await executeApply(run, prep);
  });

  const undoCommand = modeCommand('undo', 'put the original names back (dry run unless --yes)', true, async (run) => {
    await requireDirectory(run.root);
    const journal = openJournal(run.paths.journal);
    logReconcile(run, await reconcileJournal(journal, run.root, pathExists, run.yes));

    const steps = await planUndo(journal);
    if (!run.yes) {
      run.logger.list('renames that would be reversed', steps.map((step) => `${step.from} -> ${step.to}`));
      run.logger.info('dry run: nothing was changed. Add --yes to undo.');
      return;
    }

    const outcome = await undoRenames(steps, run.root, journal);
    const plan = await readJsonFile(run.paths.plan, planSchema);
    if (plan !== undefined) {
      await writeJsonFile(run.paths.plan, planSchema, markUndone(plan, outcome.restoredEntries));
    }
    run.logger.info(`undid ${outcome.restored} renames; ${outcome.failed} could not be undone`);
    if (outcome.failed > 0) {
      process.exitCode = 1;
    }
  });

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
    await guidedRun(run, { io: deps.createReviewIO(), createTitleModel: deps.createTitleModel });
  });

  return [
    runCommand,
    scanCommand,
    parseCommand,
    resolveCommand,
    planCommand,
    reviewCommand,
    applyCommand,
    undoCommand,
    statusCommand,
  ];
}

export const videosCommands: readonly ModeCommand[] = createVideosCommands();
