import { applyPlan, approvedEntries, movesFor, preflight, requireNoProblems, type Move } from '../apply/apply.ts';
import { reconcileJournal, type ReconcileSummary } from '../apply/reconcile.ts';
import { AppError } from '../errors.ts';
import type { TitleModel } from '../llm/model-client.ts';
import { loadParseCache } from '../llm/title-parser.ts';
import { parseVideos } from '../parse/videos.ts';
import { buildPlan } from '../plan/build.ts';
import { planSchema, type Plan } from '../plan/schemas.ts';
import { summarizePlan } from '../plan/status.ts';
import { resolveVideos } from '../resolve/videos.ts';
import { resolveFileSchema } from '../resolve/schemas.ts';
import { runReview, type ReviewIO, type ReviewSummary } from '../review/review.ts';
import { scanRoot, summarizeScan } from '../scan/scan.ts';
import { scanSchema } from '../scan/schemas.ts';
import { readJsonFile, writeJsonFile } from '../state/json-file.ts';
import { openJournal, type Journal } from '../state/journal.ts';
import { normalizeRoot } from '../state/paths.ts';
import { pathExists, requireDirectory, requireState, type RunContext } from './shared.ts';

export async function scanStage(run: RunContext): Promise<void> {
  const scan = await scanRoot(run.root);
  await writeJsonFile(run.paths.scan, scanSchema, scan);
  const summary = summarizeScan(scan);
  run.logger.info(`scanned ${summary.files} video files and ${summary.sidecars} subtitle files`);
  run.logger.info(`${summary.untitled} files have no title in the file name`);
}

export async function parseStage(run: RunContext, model: TitleModel): Promise<void> {
  const scan = await requireState(run.paths.scan, scanSchema, 'scan');
  const cache = await loadParseCache(run.caches.parse);

  const result = await parseVideos(scan, { model, cache, batchSize: run.config.parseBatchSize });
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
}

export async function resolveStage(run: RunContext): Promise<void> {
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
    const resolution = resolveVideos(file, entry.parse);
    counts[resolution.title === null ? 'none' : resolution.confidence] += 1;
    return { ...entry, resolution };
  });
  await writeJsonFile(run.paths.resolve, resolveFileSchema, { ...parsed, entries });
  run.logger.info(`resolved ${entries.length} files: ${counts.high} high confidence, ${counts.low} low confidence, ${counts.none} with no title`);
}

export async function planStage(run: RunContext): Promise<Plan> {
  const scan = await requireState(run.paths.scan, scanSchema, 'scan');
  const resolved = await requireState(run.paths.resolve, resolveFileSchema, 'parse and resolve');
  const previous = await readJsonFile(run.paths.plan, planSchema);

  const plan = await buildPlan(scan, resolved, { exists: pathExists, previous });
  await writeJsonFile(run.paths.plan, planSchema, plan);
  logPlanSummary(run, plan);
  return plan;
}

export async function reviewStage(run: RunContext, io: ReviewIO): Promise<ReviewSummary> {
  const plan = await requireState(run.paths.plan, planSchema, 'plan');
  const scan = await requireState(run.paths.scan, scanSchema, 'scan');
  const files = new Map(scan.files.map((file) => [file.id, file]));

  const summary = await runReview(plan, {
    io,
    files,
    exists: pathExists,
    save: (updated) => writeJsonFile(run.paths.plan, planSchema, updated),
  });
  run.logger.info(
    `review: ${summary.bulkApproved} approved in bulk, ${summary.accepted} accepted, ${summary.edited} edited, ${summary.skipped} skipped, ${summary.left} left`,
  );
  return summary;
}

export interface ApplyPrep {
  plan: Plan;
  journal: Journal;
  moves: Move[];
}

/**
 * Loads the plan and checks every approved rename. Writes nothing, and
 * throws before any change when a single rename has a problem.
 */
export async function prepareApply(run: RunContext): Promise<ApplyPrep> {
  const plan = await requireState(run.paths.plan, planSchema, 'plan');
  if (normalizeRoot(plan.root) !== normalizeRoot(run.root)) {
    throw new AppError('OPTION_INVALID', 'The plan was made for a different root.');
  }
  await requireDirectory(plan.root);

  const journal = openJournal(run.paths.journal);
  logReconcile(run, await reconcileJournal(journal, plan.root, pathExists, false));

  const problems = await preflight(plan, pathExists);
  for (const problem of problems) {
    run.logger.debug(`  ${problem.entryId}: ${problem.message}`);
  }
  requireNoProblems(problems);
  return { plan, journal, moves: approvedEntries(plan).flatMap(movesFor) };
}

/** Renames the approved files. The caller has already got the owner's consent. */
export async function executeApply(run: RunContext, prep: ApplyPrep): Promise<void> {
  await reconcileJournal(prep.journal, prep.plan.root, pathExists, true);
  const { plan: updated, outcome } = await applyPlan(prep.plan, {
    root: prep.plan.root,
    journal: prep.journal,
    save: (current) => writeJsonFile(run.paths.plan, planSchema, current),
  });
  await writeJsonFile(run.paths.plan, planSchema, updated);
  run.logger.info(`applied ${outcome.applied} entries (${outcome.renames} renames); ${outcome.failed} failed`);
  if (outcome.failed > 0) {
    process.exitCode = 1;
  }
}

export function logPlanSummary(run: RunContext, plan: Plan): void {
  const summary = summarizePlan(plan);
  const counts = Object.entries(summary.byStatus)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
  run.logger.info(`plan: ${summary.total} entries: ${counts}`);
  run.logger.info(`${summary.awaitingReview} wait for review; ${summary.collisions} collisions; ${summary.lowConfidence} low confidence`);
}

export function logReconcile(run: RunContext, summary: ReconcileSummary): void {
  if (summary.completed + summary.notStarted + summary.unknown === 0) {
    return;
  }
  run.logger.warn(
    `journal check: ${summary.completed} renames finished before an interruption, ${summary.notStarted} never started, ${summary.unknown} need a manual look`,
  );
}
