import { win32 } from 'node:path';
import { AppError } from '../errors.ts';
import type { MovieJudge } from '../llm/movie-judge.ts';
import { loadMovieParseCache, type MovieParseModel } from '../llm/movie-parser.ts';
import { parseMovies } from '../parse/movies.ts';
import { buildMoviePlan, applyChosenMovie, movieFileInfos } from '../plan/movies.ts';
import { planSchema } from '../plan/schemas.ts';
import {
  MOVIE_RESOLVE_SCHEMA_VERSION,
  movieResolveFileSchema,
  type MovieProbe,
  type MovieResolveEntry,
} from '../resolve/movie-schemas.ts';
import { judgeEntries, matchEntries, probeEntries, type ProbeFile } from '../resolve/movies.ts';
import { runReview, type MovieOption, type ReviewIO, type ReviewSummary } from '../review/review.ts';
import { scanSchema } from '../scan/schemas.ts';
import { readJsonFile, writeJsonFile } from '../state/json-file.ts';
import type { TmdbClient } from '../tmdb/client.ts';
import type { MovieDetails } from '../tmdb/schemas.ts';
import { pathExists, requireState, type RunContext } from './shared.ts';
import { logPlanSummary } from './stages.ts';

/** Reads the length and container title of a video. Returns null when ffprobe cannot read the file. */
export type ProbeVideo = (absolutePath: string) => Promise<MovieProbe | null>;

const PROBE_CONCURRENCY = 4;

export async function parseMoviesStage(run: RunContext, model: MovieParseModel): Promise<void> {
  const scan = await requireState(run.paths.scan, scanSchema, 'scan');
  const cache = await loadMovieParseCache(run.caches.parse);

  const task = run.progress('asking the model (requests)');
  const result = await parseMovies(scan, {
    model,
    cache,
    batchSize: run.config.parseBatchSize,
    onBatch: (done, total) => {
      task.update(done, total);
    },
  });
  task.done();
  await writeJsonFile(run.paths.resolve, movieResolveFileSchema, {
    schemaVersion: MOVIE_RESOLVE_SCHEMA_VERSION,
    scanId: scan.scanId,
    entries: result.entries,
  });

  const { stats } = result;
  run.logger.info(
    `parsed ${scan.files.length} names: ${result.byTmdbId} with a TMDB id, ${result.byPattern} clean, ${stats.requested} sent to the model (${stats.cached} from cache, ${stats.batches} requests)`,
  );
  const outcomes = { valid: 0, invalid: 0, none: 0, missing: 0 };
  for (const entry of result.entries) {
    if (entry.parse.via === 'model') {
      const key = { valid: 'valid', invalid: 'invalid', 'no-result': 'none', 'no-answer': 'missing' } as const;
      outcomes[key[entry.parse.outcome]] += 1;
    }
  }
  run.logger.info(
    `model titles: ${outcomes.valid} valid, ${outcomes.invalid} failed the word check, ${outcomes.none} with no title, ${outcomes.missing} with no answer`,
  );
  if (stats.refusedBatches + stats.failedBatches + stats.invalidBatches > 0) {
    run.logger.warn(`requests: ${stats.refusedBatches} refused, ${stats.failedBatches} failed, ${stats.invalidBatches} invalid; those files are unmatched`);
  }
  if (stats.firstError !== undefined) {
    run.logger.warn(`model error: ${stats.firstError}`);
  }
  run.logger.info(`tokens: ${stats.inputTokens} in, ${stats.outputTokens} out`);
}

export interface ResolveMoviesDeps {
  tmdb: TmdbClient;
  /** Left out when there is no key for the model. Entries that need the judge then go to review. */
  judge: MovieJudge | undefined;
  probe: ProbeVideo;
}

export async function resolveMoviesStage(run: RunContext, deps: ResolveMoviesDeps): Promise<void> {
  const scan = await requireState(run.paths.scan, scanSchema, 'scan');
  const parsed = await requireState(run.paths.resolve, movieResolveFileSchema, 'parse');
  if (parsed.scanId !== scan.scanId) {
    throw new AppError('STAGE_STALE', 'The parse results are from an older scan. Run parse again.');
  }
  const save = (entries: MovieResolveEntry[]): Promise<void> =>
    writeJsonFile(run.paths.resolve, movieResolveFileSchema, { ...parsed, entries });

  // A new resolve starts from the parse results and the probes already read.
  let entries: MovieResolveEntry[] = parsed.entries.map((entry) => ({ ...entry, candidates: [], resolution: null }));

  const files = new Map<string, ProbeFile>(scan.files.map((file) => [file.id, { id: file.id, path: win32.join(scan.root, file.path) }]));
  const probing = run.progress('reading media info');
  entries = await probeEntries(entries, files, deps.probe, PROBE_CONCURRENCY, (done, total) => {
    probing.update(done, total);
  });
  probing.done();
  await save(entries);

  const searching = run.progress('searching TMDB');
  const matched = await matchEntries(entries, {
    tmdb: deps.tmdb,
    folders: new Map(scan.files.map((file) => [file.id, file.folders])),
    threshold: run.config.autoApplyThreshold,
    onProgress: (done, total) => {
      searching.update(done, total);
    },
  });
  searching.done();
  entries = matched.entries;
  await deps.tmdb.save();
  await save(entries);

  const names = new Map(scan.files.map((file) => [file.id, file.stem]));
  const judging = run.progress('asking the judge (requests)');
  const judged = await judgeEntries(entries, {
    judge: deps.judge,
    names,
    onProgress: (done, total) => {
      judging.update(done, total);
    },
  });
  judging.done();
  entries = judged.entries;
  await save(entries);

  const count = (predicate: (entry: MovieResolveEntry) => boolean): number => entries.filter(predicate).length;
  const chosenBy = (via: string): number => count((entry) => entry.resolution?.via === via);
  run.logger.info(
    `resolved ${entries.length} files: ${chosenBy('score') + chosenBy('tmdb-id')} matched, ${chosenBy('judge')} picked by the judge, ${count((entry) => entry.resolution?.via === 'none' && entry.candidates.length > 0)} need a choice, ${count((entry) => entry.resolution?.via === 'none' && entry.candidates.length === 0)} unmatched`,
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
    run.logger.warn(`${matched.open} files need the judge, but there is no model available; they go to review`);
  }
}

export async function planMoviesStage(run: RunContext): Promise<void> {
  const scan = await requireState(run.paths.scan, scanSchema, 'scan');
  const resolved = await requireState(run.paths.resolve, movieResolveFileSchema, 'parse and resolve');
  const previous = await readJsonFile(run.paths.plan, planSchema);

  const task = run.progress('checking names against the disk');
  const plan = await buildMoviePlan(scan, resolved, {
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

function describe(movie: MovieDetails, score?: number): string {
  const year = movie.year === null ? '' : ` (${movie.year})`;
  const minutes = movie.runtimeMinutes === null ? '' : `, ${movie.runtimeMinutes} min`;
  const scored = score === undefined ? '' : `, score ${score.toFixed(2)}`;
  return `${movie.title}${year}${minutes}${scored}`;
}

const SEARCH_RESULTS_SHOWN = 5;

export async function reviewMoviesStage(run: RunContext, io: ReviewIO, tmdb: TmdbClient): Promise<ReviewSummary> {
  const plan = await requireState(run.paths.plan, planSchema, 'plan');
  const scan = await requireState(run.paths.scan, scanSchema, 'scan');
  const resolved = await requireState(run.paths.resolve, movieResolveFileSchema, 'parse and resolve');
  const infos = movieFileInfos(scan);
  const entries = new Map(resolved.entries.map((entry) => [entry.id, entry]));

  // Movies seen so far, so that picking one needs no new request.
  const known = new Map<number, MovieDetails>();
  for (const entry of resolved.entries) {
    for (const candidate of entry.candidates) {
      known.set(candidate.details.id, candidate.details);
    }
  }
  const detailsOf = async (id: number): Promise<MovieDetails | undefined> => {
    const cached = known.get(id) ?? (await tmdb.movieDetails(id));
    if (cached !== undefined) {
      known.set(id, cached);
    }
    return cached;
  };

  const summary = await runReview(plan, {
    io,
    files: new Map(scan.files.map((file) => [file.id, file])),
    exists: pathExists,
    save: (updated) => writeJsonFile(run.paths.plan, planSchema, updated),
    movies: {
      optionsFor: (entryId): MovieOption[] =>
        (entries.get(entryId)?.candidates ?? []).map((candidate) => ({
          id: candidate.details.id,
          label: describe(candidate.details, candidate.score),
        })),
      search: async (query): Promise<MovieOption[]> => {
        const hits = (await tmdb.searchMovies({ query })).slice(0, SEARCH_RESULTS_SHOWN);
        const options: MovieOption[] = [];
        for (const hit of hits) {
          const details = await detailsOf(hit.id);
          if (details !== undefined) {
            options.push({ id: details.id, label: describe(details) });
          }
        }
        await tmdb.save();
        return options;
      },
      lookup: async (id): Promise<MovieOption | undefined> => {
        const details = await detailsOf(id);
        await tmdb.save();
        return details === undefined ? undefined : { id, label: describe(details) };
      },
      choose: async (current, entry, movieId) => {
        const info = infos.get(entry.id);
        const details = await detailsOf(movieId);
        if (info === undefined || details === undefined) {
          return { ok: false, message: 'That movie or file is no longer available. Run scan, parse, resolve, and plan again.' };
        }
        return applyChosenMovie(current, entry, info, details, entries.get(entry.id)?.parse.edition ?? null, pathExists);
      },
    },
  });
  run.logger.info(
    `review: ${summary.accepted} accepted, ${summary.edited} chosen, ${summary.skipped} skipped, ${summary.left} left`,
  );
  return summary;
}
