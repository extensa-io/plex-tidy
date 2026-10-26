import { applyPlan, approvedEntries, movesFor, preflight, requireNoProblems, type Move } from '../apply/apply.ts';
import { rm } from 'node:fs/promises';
import { composeCheckers, reconcileJournal, renameChecker, type ReconcileSummary } from '../apply/reconcile.ts';
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
import { tagChecker, type Backends } from '../tag/backends.ts';
import type { CopyPhase } from '../tag/backend.ts';
import { countCandidates, findLeftoverCopies, findLeftoverWorkDirs, planTagging, runTagging } from '../tag/tagger.ts';
import { normalizeRoot } from '../state/paths.ts';
import { pathExists, requireDirectory, requireState, type RunContext } from './shared.ts';

export async function scanStage(run: RunContext): Promise<void> {
  const task = run.progress('scanning (video files found)');
  const scan = await scanRoot(run.root, { onFile: (count) => { task.update(count); } });
  task.done();
  await writeJsonFile(run.paths.scan, scanSchema, scan);
  const summary = summarizeScan(scan);
  run.logger.info(`scanned ${summary.files} video files and ${summary.sidecars} subtitle files`);
  if (run.mode === 'videos') {
    run.logger.info(`${summary.untitled} files have no title in the file name`);
  }
}

export async function parseStage(run: RunContext, model: TitleModel): Promise<void> {
  const scan = await requireState(run.paths.scan, scanSchema, 'scan');
  const cache = await loadParseCache(run.caches.parse);

  const task = run.progress('asking the model (requests)');
  const result = await parseVideos(scan, {
    model,
    cache,
    batchSize: run.config.parseBatchSize,
    onBatch: (done, total) => { task.update(done, total); },
  });
  task.done();
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

  const task = run.progress('checking names against the disk');
  const plan = await buildPlan(scan, resolved, {
    exists: pathExists,
    previous,
    onProgress: (done, total) => { task.update(done, total); },
  });
  task.done();
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
export async function prepareApply(run: RunContext, backends: Backends): Promise<ApplyPrep> {
  const plan = await requireState(run.paths.plan, planSchema, 'plan');
  if (normalizeRoot(plan.root) !== normalizeRoot(run.root)) {
    throw new AppError('OPTION_INVALID', 'The plan was made for a different root.');
  }
  await requireDirectory(plan.root);

  const journal = openJournal(run.paths.journal);
  logReconcile(run, await reconcileJournal(journal, journalCheck(plan.root, backends), false));

  const task = run.progress('checking renames');
  const problems = await preflight(plan, pathExists, (done, total) => { task.update(done, total); });
  task.done();
  for (const problem of problems) {
    run.logger.debug(`  ${problem.entryId}: ${problem.message}`);
  }
  requireNoProblems(problems);
  return { plan, journal, moves: approvedEntries(plan).flatMap(movesFor) };
}

/** Renames the approved files. The caller has already got the owner's consent. */
export async function executeApply(run: RunContext, prep: ApplyPrep, backends: Backends): Promise<void> {
  await reconcileJournal(prep.journal, journalCheck(prep.plan.root, backends), true);
  const task = run.progress('renaming');
  const { plan: updated, outcome } = await applyPlan(prep.plan, {
    root: prep.plan.root,
    journal: prep.journal,
    save: (current) => writeJsonFile(run.paths.plan, planSchema, current),
    onProgress: (done, total) => { task.update(done, total); },
  });
  task.done();
  await writeJsonFile(run.paths.plan, planSchema, updated);
  run.logger.info(`applied ${outcome.applied} entries (${outcome.renames} renames); ${outcome.failed} failed`);
  if (outcome.failed > 0) {
    process.exitCode = 1;
  }
}

/** Checks unfinished journal lines of every kind against the real files. */
export function journalCheck(root: string, backends: Backends) {
  return composeCheckers(renameChecker(root, pathExists), tagChecker(root, backends));
}

/**
 * Writes the titles into the renamed files. A dry run reads the files and
 * reports; it changes nothing, not even the plan.
 */
export async function tagStage(run: RunContext, backends: Backends): Promise<void> {
  const plan = await requireState(run.paths.plan, planSchema, 'plan');
  if (normalizeRoot(plan.root) !== normalizeRoot(run.root)) {
    throw new AppError('OPTION_INVALID', 'The plan was made for a different root.');
  }
  await requireDirectory(plan.root);

  const journal = openJournal(run.paths.journal);
  logReconcile(run, await reconcileJournal(journal, journalCheck(plan.root, backends), run.yes));

  const leftovers = [...(await findLeftoverCopies(plan)), ...(await findLeftoverWorkDirs())];
  if (leftovers.length > 0) {
    if (run.yes) {
      await Promise.all(leftovers.map((copy) => rm(copy, { recursive: true, force: true })));
      run.logger.info(`removed ${leftovers.length} temporary copies left by an interrupted run`);
    } else {
      run.logger.info(`${leftovers.length} temporary copies left by an interrupted run; --yes removes them`);
    }
  }

  const reading = run.progress('reading tags');
  const candidates = await planTagging(plan, backends, (done, total) => { reading.update(done, total); });
  reading.done();
  if (candidates.length === 0) {
    run.logger.info('nothing to tag: tagging applies to files that were renamed with apply');
    return;
  }
  const counts = countCandidates(candidates);
  run.logger.info(
    `tag: ${counts.write} to write, ${counts.unchanged} already correct, ${counts.unsupported} rename-only, ${counts.unreadable} could not be read`,
  );
  for (const [reason, count] of Object.entries(counts.unsupportedReasons)) {
    run.logger.info(`rename-only: ${count} files, because ${reason}`);
  }
  for (const candidate of candidates.filter((item) => item.action === 'unreadable')) {
    run.logger.debug(`  ${candidate.entry.id}: ${candidate.reason ?? 'unreadable'}`);
  }

  if (!run.yes) {
    run.logger.list(
      'files that would be tagged',
      candidates.filter((item) => item.action === 'write').map((item) => item.entry.target),
    );
    run.logger.info('dry run: nothing was changed. Add --yes to tag.');
    return;
  }

  const writing = run.progress('tagging');
  // The last size seen for the file being copied, to work out the copy speed.
  let sample: { at: number; bytes: number; phase: CopyPhase } | undefined;
  const describeCopy = (copied: number, total: number, phase: CopyPhase): string => {
    const now = Date.now();
    const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));
    const speed =
      sample?.phase === phase && now > sample.at && copied >= sample.bytes
        ? `, ${((copied - sample.bytes) / (1024 * 1024) / ((now - sample.at) / 1000)).toFixed(1)} MB/s`
        : '';
    sample = { at: now, bytes: copied, phase };
    if (phase === 'building') {
      return 'writing the tags';
    }
    const action = phase === 'downloading' ? 'downloading' : 'uploading';
    return `${action} ${megabytes(Math.min(copied, total))} of ${megabytes(total)} MB${speed}`;
  };
  const { outcome } = await runTagging(plan, candidates, {
    root: plan.root,
    journal,
    backends,
    save: (current) => writeJsonFile(run.paths.plan, planSchema, current),
    onProgress: (done, total) => {
      writing.update(done, total);
      writing.detail(undefined);
      sample = undefined;
    },
    onCopyProgress: (copied, total, phase) => {
      writing.detail(describeCopy(copied, total, phase));
    },
  });
  writing.done();
  run.logger.info(
    `tagged ${outcome.tagged} files; ${outcome.unchanged} already correct, ${outcome.skipped} rename-only, ${outcome.failed} failed`,
  );
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
  const { tags } = summary;
  if (summary.byStatus.applied > 0) {
    run.logger.info(
      `tags: ${tags.untagged} untagged, ${tags.tagged} tagged, ${tags['tag-skipped']} rename-only, ${tags['tag-failed']} failed`,
    );
  }
}

export function logReconcile(run: RunContext, summary: ReconcileSummary): void {
  if (summary.completed + summary.notStarted + summary.unknown === 0) {
    return;
  }
  run.logger.warn(
    `journal check: ${summary.completed} renames finished before an interruption, ${summary.notStarted} never started, ${summary.unknown} need a manual look`,
  );
}
