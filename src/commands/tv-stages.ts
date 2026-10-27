import { AppError } from '../errors.ts';
import { loadMovieParseCache } from '../llm/movie-parser.ts';
import type { ShowJudge } from '../llm/tv-judge.ts';
import type { TvParseModel } from '../llm/tv-parser.ts';
import { parseTv, toResolveEntries } from '../parse/tv.ts';
import { planSchema } from '../plan/schemas.ts';
import { buildTvPlan } from '../plan/tv.ts';
import { groupEpisodes, judgeShows, matchShows, resolveEpisodes } from '../resolve/tv.ts';
import { TV_RESOLVE_SCHEMA_VERSION, tvResolveFileSchema, type TvResolveEntry } from '../resolve/tv-schemas.ts';
import type { ReviewIO } from '../review/review.ts';
import { runTvReview, type TvReviewSummary } from '../review/tv-review.ts';
import { scanSchema } from '../scan/schemas.ts';
import { readJsonFile, writeJsonFile } from '../state/json-file.ts';
import type { TmdbClient } from '../tmdb/client.ts';
import { pathExists, requireState, type RunContext } from './shared.ts';
import { logPlanSummary } from './stages.ts';

export async function parseTvStage(run: RunContext, model: TvParseModel): Promise<void> {
  const scan = await requireState(run.paths.scan, scanSchema, 'scan');
  const cache = await loadMovieParseCache(run.caches.parse);

  const task = run.progress('asking the model (requests)');
  const result = await parseTv(scan, {
    model,
    cache,
    batchSize: run.config.parseBatchSize,
    onBatch: (done, total) => {
      task.update(done, total);
    },
  });
  task.done();

  const grouping = groupEpisodes(scan, result.parses);
  const entries = toResolveEntries(scan, result.parses, (id) => grouping.keyOf.get(id) ?? '');
  await writeJsonFile(run.paths.resolve, tvResolveFileSchema, {
    schemaVersion: TV_RESOLVE_SCHEMA_VERSION,
    scanId: scan.scanId,
    shows: grouping.groups,
    entries,
  });

  const { stats } = result;
  run.logger.info(
    `parsed ${scan.files.length} names: ${result.byRules} by rules, ${stats.requested} sent to the model (${stats.cached} from cache, ${stats.batches} requests)`,
  );
  const withEpisode = entries.filter((entry) => entry.parse.episode !== null).length;
  run.logger.info(`${withEpisode} names have an episode number, ${entries.length - withEpisode} do not; ${grouping.groups.length} shows found`);
  if (stats.refusedBatches + stats.failedBatches + stats.invalidBatches > 0) {
    run.logger.warn(`requests: ${stats.refusedBatches} refused, ${stats.failedBatches} failed, ${stats.invalidBatches} invalid; those files wait for review`);
  }
  if (stats.firstError !== undefined) {
    run.logger.warn(`model error: ${stats.firstError}`);
  }
  run.logger.info(`tokens: ${stats.inputTokens} in, ${stats.outputTokens} out`);
}

export interface ResolveTvDeps {
  tmdb: TmdbClient;
  /** Left out when there is no key for the model. Shows that need the judge then go to review. */
  judge: ShowJudge | undefined;
}

export async function resolveTvStage(run: RunContext, deps: ResolveTvDeps): Promise<void> {
  const scan = await requireState(run.paths.scan, scanSchema, 'scan');
  const parsed = await requireState(run.paths.resolve, tvResolveFileSchema, 'parse');
  if (parsed.scanId !== scan.scanId) {
    throw new AppError('STAGE_STALE', 'The parse results are from an older scan. Run parse again.');
  }
  const save = (value: Pick<typeof parsed, 'shows' | 'entries'>): Promise<void> =>
    writeJsonFile(run.paths.resolve, tvResolveFileSchema, { ...parsed, ...value });

  // A new resolve starts over, but keeps the shows and the season and episode numbers chosen in review.
  let shows = parsed.shows.map((group) => (group.resolution?.via === 'manual' ? group : { ...group, candidates: [], resolution: null }));
  let entries: TvResolveEntry[] = parsed.entries;

  const searching = run.progress('searching TMDB');
  const matched = await matchShows(shows, {
    tmdb: deps.tmdb,
    threshold: run.config.autoApplyThreshold,
    onProgress: (done, total) => {
      searching.update(done, total);
    },
  });
  searching.done();
  shows = matched.groups;
  await deps.tmdb.save();
  await save({ shows, entries });

  const names = new Map(scan.files.map((file) => [file.id, file.stem]));
  const judging = run.progress('asking the judge (requests)');
  const judged = await judgeShows(shows, {
    judge: deps.judge,
    names,
    onProgress: (done, total) => {
      judging.update(done, total);
    },
  });
  judging.done();
  shows = judged.groups;
  await save({ shows, entries });

  const listing = run.progress('reading season listings');
  entries = await resolveEpisodes(scan, shows, entries, {
    tmdb: deps.tmdb,
    onProgress: (done, total) => {
      listing.update(done, total);
    },
  });
  listing.done();
  await deps.tmdb.save();
  await save({ shows, entries });

  const via = (name: string): number => shows.filter((group) => group.resolution?.via === name).length;
  run.logger.info(
    `resolved ${shows.length} shows: ${via('score') + via('tmdb-id') + via('manual')} matched, ${via('judge')} picked by the judge, ${shows.filter((group) => group.resolution?.via === 'none' && group.candidates.length > 0).length} need a choice, ${shows.filter((group) => group.resolution?.via === 'none' && group.candidates.length === 0).length} unmatched`,
  );
  const found = entries.filter((entry) => entry.episode?.found === true).length;
  const assumed = entries.filter((entry) => entry.episode?.seasonSource === 'assumed').length;
  const conflicts = entries.filter((entry) => entry.episode?.conflict === true).length;
  run.logger.info(
    `episodes: ${found} of ${entries.length} found in the TMDB listings; ${assumed} with an assumed season, ${conflicts} where the name and the Season folder disagree`,
  );
  const tmdbStats = deps.tmdb.stats();
  run.logger.info(`TMDB: ${tmdbStats.requests} requests, ${tmdbStats.cacheHits} answered from the cache`);
  if (judged.stats.calls > 0) {
    run.logger.info(
      `judge: ${judged.stats.calls} calls, ${judged.stats.picked} picks, ${judged.stats.abstained} abstained, ${judged.stats.rejected} rejected; tokens: ${judged.stats.inputTokens} in, ${judged.stats.outputTokens} out`,
    );
    if (judged.stats.firstError !== undefined) {
      run.logger.warn(`judge error: ${judged.stats.firstError}`);
    }
  } else if (deps.judge === undefined && matched.open > 0) {
    run.logger.warn(`${matched.open} shows need the judge, but there is no model available; they go to review`);
  }
}

export async function planTvStage(run: RunContext): Promise<void> {
  const scan = await requireState(run.paths.scan, scanSchema, 'scan');
  const resolved = await requireState(run.paths.resolve, tvResolveFileSchema, 'parse and resolve');
  const previous = await readJsonFile(run.paths.plan, planSchema);

  const task = run.progress('checking names against the disk');
  const plan = await buildTvPlan(scan, resolved, {
    exists: pathExists,
    previous,
    onProgress: (done, total) => {
      task.update(done, total);
    },
  });
  task.done();
  await writeJsonFile(run.paths.plan, planSchema, plan);
  logPlanSummary(run, plan);
}

export async function reviewTvStage(run: RunContext, io: ReviewIO, tmdb: TmdbClient): Promise<TvReviewSummary> {
  const plan = await requireState(run.paths.plan, planSchema, 'plan');
  const scan = await requireState(run.paths.scan, scanSchema, 'scan');
  const resolved = await requireState(run.paths.resolve, tvResolveFileSchema, 'parse and resolve');

  const summary = await runTvReview(plan, resolved, {
    io,
    tmdb,
    scan,
    exists: pathExists,
    saveResolved: (value) => writeJsonFile(run.paths.resolve, tvResolveFileSchema, value),
    savePlan: (value) => writeJsonFile(run.paths.plan, planSchema, value),
  });
  await tmdb.save();
  run.logger.info(
    `review: ${summary.shows} shows chosen, ${summary.accepted} accepted, ${summary.edited} edited, ${summary.skipped} skipped, ${summary.left} left`,
  );
  return summary;
}
