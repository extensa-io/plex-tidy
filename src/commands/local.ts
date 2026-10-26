import type { Command } from 'commander';
import { applyPlan, approvedEntries, movesFor, preflight, requireNoProblems } from '../apply/apply.ts';
import { reconcileJournal } from '../apply/reconcile.ts';
import type { CliContext, ModeCommand } from '../cli-types.ts';
import { loadConfig, type Config } from '../config.ts';
import { requireEnv } from '../env.ts';
import { AppError } from '../errors.ts';
import { createAnthropicTitleModel } from '../llm/anthropic.ts';
import type { TitleModel } from '../llm/model-client.ts';
import { loadParseCache } from '../llm/title-parser.ts';
import { parseLocal } from '../parse/local.ts';
import { buildPlan } from '../plan/build.ts';
import { planSchema } from '../plan/schemas.ts';
import { summarizePlan } from '../plan/status.ts';
import { resolveFileSchema } from '../resolve/schemas.ts';
import { resolveLocal } from '../resolve/local.ts';
import { createTerminalIO } from '../review/prompts.ts';
import { runReview, type ReviewIO } from '../review/review.ts';
import { scanRoot, summarizeScan } from '../scan/scan.ts';
import { scanSchema } from '../scan/schemas.ts';
import { readJsonFile, writeJsonFile } from '../state/json-file.ts';
import { openJournal } from '../state/journal.ts';
import { normalizeRoot } from '../state/paths.ts';
import type { Mode } from '../state/schemas.ts';
import { markUndone, planUndo, undoRenames } from '../undo/undo.ts';
import { addRunOptions, createRunContext, pathExists, requireDirectory, requireState, type RunContext } from './shared.ts';

/** What the local commands need from outside, so tests can replace the model, the terminal, and config.json. */
export interface LocalDeps {
  loadConfig: () => Promise<Config>;
  createTitleModel: (run: RunContext) => TitleModel;
  createReviewIO: () => ReviewIO;
}

const defaultDeps: LocalDeps = {
  loadConfig: () => loadConfig(),
  createTitleModel: (run) =>
    createAnthropicTitleModel({ apiKey: requireEnv('ANTHROPIC_API_KEY'), model: run.config.models.parse }),
  createReviewIO: createTerminalIO,
};

type Action = (run: RunContext) => Promise<void>;

export function createLocalCommands(deps: LocalDeps = defaultDeps): ModeCommand[] {
  const modeCommand = (name: string, description: string, withYes: boolean, action: Action): ModeCommand => ({
    name,
    description,
    modes: ['local'],
    register: (command: Command, mode: Mode, cli: CliContext) => {
      addRunOptions(command, withYes).action(async () => {
        await action(await createRunContext(command, mode, cli, deps.loadConfig));
      });
    },
  });

  const scanCommand = modeCommand('scan', 'list video files and subtitle files under the root', false, async (run) => {
    const scan = await scanRoot(run.root);
    await writeJsonFile(run.paths.scan, scanSchema, scan);
    const summary = summarizeScan(scan);
    run.logger.info(`scanned ${summary.files} video files and ${summary.sidecars} subtitle files`);
    run.logger.info(`${summary.untitled} files have no title in the file name`);
  });

  const parseCommand = modeCommand('parse', 'ask the model for a title for each file', false, async (run) => {
    const scan = await requireState(run.paths.scan, scanSchema, 'scan');
    const model = deps.createTitleModel(run);
    const cache = await loadParseCache(run.caches.parse);

    const result = await parseLocal(scan, { model, cache, batchSize: run.config.parseBatchSize });
    await writeJsonFile(run.paths.resolve, resolveFileSchema, {
      schemaVersion: 1,
      scanId: scan.scanId,
      entries: result.entries,
    });

    const { stats, outcomes } = result;
    run.logger.info(`parsed ${scan.files.length} files: ${stats.requested} sent (${stats.cached} from cache, ${stats.batches} requests)`);
    run.logger.info(
      `titles: ${outcomes.valid} valid, ${outcomes.invalid} failed the word check, ${outcomes['no-result']} with no result, ${outcomes['no-source']} with nothing to read`,
    );
    if (stats.refusedBatches + stats.failedBatches + stats.invalidBatches > 0) {
      run.logger.warn(
        `requests: ${stats.refusedBatches} refused, ${stats.failedBatches} failed, ${stats.invalidBatches} invalid; those files use the rules-only cleaner`,
      );
    }
    run.logger.info(`tokens: ${stats.inputTokens} in, ${stats.outputTokens} out`);
  });

  const resolveCommand = modeCommand('resolve', 'choose a title for each file', false, async (run) => {
    const scan = await requireState(run.paths.scan, scanSchema, 'scan');
    const parsed = await requireState(run.paths.resolve, resolveFileSchema, 'parse');
    if (parsed.scanId !== scan.scanId) {
      throw new AppError('STAGE_STALE', 'The parse results are from an older scan. Run parse again.');
    }

    const files = new Map(scan.files.map((file) => [file.id, file]));
    const counts = { high: 0, low: 0, none: 0 };
    const entries = parsed.entries.map((entry) => {
      const file = files.get(entry.id);
      if (file === undefined) {
        throw new AppError('STAGE_STALE', 'The parse results do not match the scan. Run parse again.');
      }
      const resolution = resolveLocal(file, entry.parse);
      counts[resolution.title === null ? 'none' : resolution.confidence] += 1;
      return { ...entry, resolution };
    });
    await writeJsonFile(run.paths.resolve, resolveFileSchema, { ...parsed, entries });
    run.logger.info(`resolved ${entries.length} files: ${counts.high} high confidence, ${counts.low} low confidence, ${counts.none} with no title`);
  });

  const planCommand = modeCommand('plan', 'write the list of renames', false, async (run) => {
    const scan = await requireState(run.paths.scan, scanSchema, 'scan');
    const resolved = await requireState(run.paths.resolve, resolveFileSchema, 'parse and resolve');
    const previous = await readJsonFile(run.paths.plan, planSchema);

    const plan = await buildPlan(scan, resolved, { exists: pathExists, previous });
    await writeJsonFile(run.paths.plan, planSchema, plan);
    logPlanSummary(run, plan);
  });

  const reviewCommand = modeCommand('review', 'go through the proposed names and decide', false, async (run) => {
    const plan = await requireState(run.paths.plan, planSchema, 'plan');
    const scan = await requireState(run.paths.scan, scanSchema, 'scan');
    const files = new Map(scan.files.map((file) => [file.id, file]));

    const summary = await runReview(plan, {
      io: deps.createReviewIO(),
      files,
      exists: pathExists,
      save: (updated) => writeJsonFile(run.paths.plan, planSchema, updated),
    });
    run.logger.info(
      `review: ${summary.bulkApproved} approved in bulk, ${summary.accepted} accepted, ${summary.edited} edited, ${summary.skipped} skipped, ${summary.left} left`,
    );
  });

  const applyCommand = modeCommand('apply', 'rename the approved files (dry run unless --yes)', true, async (run) => {
    const plan = await requireState(run.paths.plan, planSchema, 'plan');
    requireSameRoot(run, plan.root);
    await requireDirectory(plan.root);

    const journal = openJournal(run.paths.journal);
    const reconciled = await reconcileJournal(journal, plan.root, pathExists, run.yes);
    logReconcile(run, reconciled);

    const problems = await preflight(plan, pathExists);
    for (const problem of problems) {
      run.logger.debug(`  ${problem.entryId}: ${problem.message}`);
    }
    requireNoProblems(problems);

    const moves = approvedEntries(plan).flatMap(movesFor);
    if (!run.yes) {
      run.logger.list('renames that would happen', moves.map((move) => `${move.from} -> ${move.to}`));
      run.logger.info('dry run: nothing was changed. Add --yes to rename.');
      return;
    }

    const { plan: updated, outcome } = await applyPlan(plan, {
      root: plan.root,
      journal,
      save: (current) => writeJsonFile(run.paths.plan, planSchema, current),
    });
    await writeJsonFile(run.paths.plan, planSchema, updated);
    run.logger.info(`applied ${outcome.applied} entries (${outcome.renames} renames); ${outcome.failed} failed`);
    if (outcome.failed > 0) {
      process.exitCode = 1;
    }
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


  return [
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

export const localCommands: readonly ModeCommand[] = createLocalCommands();

function logPlanSummary(run: RunContext, plan: Parameters<typeof summarizePlan>[0]): void {
  const summary = summarizePlan(plan);
  const counts = Object.entries(summary.byStatus)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  run.logger.info(`plan: ${summary.total} entries: ${counts}`);
  run.logger.info(`${summary.awaitingReview} wait for review; ${summary.collisions} collisions; ${summary.lowConfidence} low confidence`);
}

function logReconcile(run: RunContext, summary: Awaited<ReturnType<typeof reconcileJournal>>): void {
  const open = summary.completed + summary.notStarted + summary.unknown;
  if (open === 0) {
    return;
  }
  run.logger.warn(
    `journal check: ${summary.completed} renames finished before an interruption, ${summary.notStarted} never started, ${summary.unknown} need a manual look`,
  );
}

function requireSameRoot(run: RunContext, planRoot: string): void {
  if (normalizeRoot(planRoot) !== normalizeRoot(run.root)) {
    throw new AppError('OPTION_INVALID', 'The plan was made for a different root.');
  }
}
