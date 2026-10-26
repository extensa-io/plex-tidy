import pLimit from 'p-limit';
import type { JudgeCandidate, MovieJudge } from '../llm/movie-judge.ts';
import type { TokenUsage } from '../llm/model-client.ts';
import { titleFromFolder, yearFromFolders } from '../parse/movies.ts';
import type { TmdbClient } from '../tmdb/client.ts';
import type { MovieDetails, MovieHit } from '../tmdb/schemas.ts';
import type { MovieProbe, MovieResolveEntry, MovieResolution, ScoredCandidate } from './movie-schemas.ts';
import { scoreCandidate, titleSimilarity, type FileFacts } from './scorer.ts';

/** Candidates kept per file, and shown to the judge. */
export const MAX_CANDIDATES = 5;
/** Two candidates closer than this are too alike to pick one without help. */
export const AMBIGUITY_MARGIN = 0.05;
/** A first pass at or above this similarity needs no second search. */
const SPANISH_LANGUAGE = 'es';
const OVERVIEW_CHARS = 300;
const JUDGE_CONCURRENCY = 3;
const FILE_CONCURRENCY = 8;

export function runtimeMinutes(probe: MovieProbe | null): number | null {
  return probe?.durationSeconds === undefined || probe.durationSeconds === null ? null : Math.round(probe.durationSeconds / 60);
}

export interface ProbeFile {
  id: string;
  /** Absolute path. */
  path: string;
}

/** Reads the length and container title of each file. A file that cannot be read keeps a null probe. */
export async function probeEntries(
  entries: readonly MovieResolveEntry[],
  files: ReadonlyMap<string, ProbeFile>,
  probe: (path: string) => Promise<MovieProbe | null>,
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<MovieResolveEntry[]> {
  const limit = pLimit(concurrency);
  // A file that already has a probe keeps it, so a second resolve does not read the share again.
  const wanted = entries.filter((entry) => entry.probe === null);
  let done = 0;
  onProgress?.(0, wanted.length);
  const probes = new Map<string, MovieProbe | null>();
  await Promise.all(
    wanted.map((entry) =>
      limit(async () => {
        const file = files.get(entry.id);
        probes.set(entry.id, file === undefined ? null : await probe(file.path));
        done += 1;
        onProgress?.(done, wanted.length);
      }),
    ),
  );
  return entries.map((entry) => (probes.has(entry.id) ? { ...entry, probe: probes.get(entry.id) ?? null } : entry));
}

export interface MatchDeps {
  tmdb: TmdbClient;
  /** Folder names by entry id, nearest first. They are read on this machine only. */
  folders?: ReadonlyMap<string, readonly string[]>;
  /** Entries at or above this score are chosen without the judge. */
  threshold: number;
  onProgress?: (done: number, total: number) => void;
}

export interface MatchOutcome {
  entries: MovieResolveEntry[];
  /** Entries left for the judge. */
  open: number;
}

/**
 * Searches TMDB for each file and scores the candidates. An entry whose best
 * candidate reaches the threshold and stands clear of the rest is resolved
 * here. Entries with candidates that are not good enough stay open for the judge.
 */
export async function matchEntries(entries: readonly MovieResolveEntry[], deps: MatchDeps): Promise<MatchOutcome> {
  const limit = pLimit(FILE_CONCURRENCY);
  let done = 0;
  const work = entries.filter((entry) => entry.resolution === null);
  deps.onProgress?.(0, work.length);
  const results = new Map<string, MovieResolveEntry>();
  await Promise.all(
    work.map((entry) =>
      limit(async () => {
        results.set(entry.id, await matchOne(entry, deps));
        done += 1;
        deps.onProgress?.(done, work.length);
      }),
    ),
  );
  const merged = entries.map((entry) => results.get(entry.id) ?? entry);
  return { entries: merged, open: merged.filter((entry) => entry.resolution === null).length };
}

async function matchOne(entry: MovieResolveEntry, deps: MatchDeps): Promise<MovieResolveEntry> {
  const { parse } = entry;
  if (parse.tmdbId !== null) {
    return matchById(entry, parse.tmdbId, deps);
  }
  // A year in a folder name stands in for a year the file name does not have.
  const folders = deps.folders?.get(entry.id) ?? [];
  const yearFromFolder = parse.year === null ? yearFromFolders(folders) : null;
  const year = parse.year ?? yearFromFolder;

  // Titles to try, in order. The first one that finds a movie is used.
  const titles = searchTitles(parse.title ?? '', folders);
  if (titles.length === 0) {
    return withResolution(entry, [], none('the name has no title'));
  }
  let candidates: ScoredCandidate[] = [];
  for (const title of titles) {
    candidates = await findCandidates({ title, year, runtimeMinutes: runtimeMinutes(entry.probe) }, parse.language, deps);
    if (candidates.length > 0) {
      break;
    }
  }

  if (candidates.length === 0) {
    return withResolution(entry, [], none('TMDB found no movie for this title'));
  }
  const [best, second] = candidates;
  if (best !== undefined && best.score >= deps.threshold && (second === undefined || best.score - second.score >= AMBIGUITY_MARGIN)) {
    return withResolution(entry, candidates, {
      chosenId: best.details.id,
      via: 'score',
      confidence: 'high',
      score: best.score,
      reason: yearFromFolder === null ? best.reason : `${best.reason} (the year comes from the folder name)`,
    });
  }
  return { ...entry, candidates };
}

/** Fewest words a shortened title may have. One word matches too many movies. */
const MIN_WORDS_AFTER_TRIMMING = 2;
const MAX_WORDS_TRIMMED = 3;

/**
 * The title from the file name, then the same title with trailing words
 * dropped one at a time (a leftover tag such as "hd" ends a title), then the
 * title read from the nearest folder name.
 */
export function searchTitles(title: string, folders: readonly string[]): string[] {
  const words = title.split(/\s+/).filter((word) => word !== '');
  const titles = [title];
  for (let kept = words.length - 1; kept >= Math.max(MIN_WORDS_AFTER_TRIMMING, words.length - MAX_WORDS_TRIMMED); kept -= 1) {
    titles.push(words.slice(0, kept).join(' '));
  }
  for (const folder of folders) {
    const fromFolder = titleFromFolder(folder);
    if (fromFolder !== null) {
      titles.push(fromFolder);
      break;
    }
  }
  const seen = new Set<string>();
  return titles.filter((candidate) => {
    const key = candidate.toLowerCase();
    if (key === '' || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** The searches for one title: English with the year, English without it, then Spanish. */
async function findCandidates(facts: FileFacts, language: string | null, deps: MatchDeps): Promise<ScoredCandidate[]> {
  // Every search adds to the same pool, so a later pass can only improve the candidates.
  const hits = new Map<number, MovieHit[]>();
  let candidates = await collect(facts, hits, { language: 'en-US', year: facts.year }, deps);
  const good = (): boolean => (candidates[0]?.score ?? 0) >= deps.threshold;
  if (!good() && facts.year !== null) {
    candidates = await collect(facts, hits, { language: 'en-US', year: null }, deps);
  }
  if (!good() && (language === SPANISH_LANGUAGE || candidates.length === 0)) {
    candidates = await collect(facts, hits, { language: 'es-ES', year: null }, deps);
  }
  return candidates;
}

async function matchById(entry: MovieResolveEntry, id: number, deps: MatchDeps): Promise<MovieResolveEntry> {
  const details = await deps.tmdb.movieDetails(id);
  if (details === undefined) {
    return withResolution(entry, [], none(`TMDB has no movie with id ${id}`));
  }
  return withResolution(entry, [{ details, score: 1, reason: 'the id is in the name' }], {
    chosenId: id,
    via: 'tmdb-id',
    confidence: 'high',
    score: null,
    reason: 'the id is in the name',
  });
}

interface SearchPlan {
  language: string;
  year: number | null;
}

/** Runs one search, adds its hits to `hits`, and returns the best scored candidates over all hits so far. */
async function collect(
  facts: FileFacts,
  hits: Map<number, MovieHit[]>,
  search: SearchPlan,
  deps: MatchDeps,
): Promise<ScoredCandidate[]> {
  const found = await deps.tmdb.searchMovies({ query: facts.title, year: search.year, language: search.language });
  for (const hit of found) {
    hits.set(hit.id, [...(hits.get(hit.id) ?? []), hit]);
  }

  // Rank by title and year first: the length is only known after the details are read.
  const ranked = [...hits.values()]
    .map((variants) => ({ variants, rank: preRank(facts, variants) }))
    .sort((a, b) => b.rank - a.rank || popularityOf(b.variants) - popularityOf(a.variants))
    .slice(0, MAX_CANDIDATES + 3)
    .map(({ variants }) => variants);

  const scored: ScoredCandidate[] = [];
  for (const variants of ranked) {
    const first = variants[0];
    const details = first === undefined ? undefined : await deps.tmdb.movieDetails(first.id);
    if (details === undefined) {
      continue;
    }
    const withAlternatives = addAlternativeTitles(details, variants);
    const { score, reason } = scoreCandidate(facts, withAlternatives);
    scored.push({ details: withAlternatives, score, reason });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

function preRank(facts: FileFacts, variants: readonly MovieHit[]): number {
  const similarity = Math.max(
    ...variants.flatMap((hit) => [titleSimilarity(facts.title, hit.title), titleSimilarity(facts.title, hit.originalTitle)]),
  );
  const sameYear = facts.year !== null && variants.some((hit) => hit.year === facts.year);
  return similarity + (sameYear ? 0.2 : 0);
}

function popularityOf(variants: readonly MovieHit[]): number {
  return Math.max(...variants.map((hit) => hit.popularity));
}

/** The titles a search matched that the details do not carry, such as a Spanish title. */
function addAlternativeTitles(details: MovieDetails, variants: readonly MovieHit[]): MovieDetails {
  const known = new Set([details.title, details.originalTitle, ...details.altTitles]);
  const extra = [...new Set(variants.flatMap((hit) => [hit.title, hit.originalTitle]))].filter(
    (title) => title !== '' && !known.has(title),
  );
  return extra.length === 0 ? details : { ...details, altTitles: [...details.altTitles, ...extra] };
}

function none(reason: string): MovieResolution {
  return { chosenId: null, via: 'none', confidence: 'low', score: null, reason };
}

function withResolution(entry: MovieResolveEntry, candidates: ScoredCandidate[], resolution: MovieResolution): MovieResolveEntry {
  return { ...entry, candidates, resolution };
}

export interface JudgeDeps {
  /** Left out when no model is available. */
  judge: MovieJudge | undefined;
  /** The base file name without extension, by entry id. */
  names: ReadonlyMap<string, string>;
  onProgress?: (done: number, total: number) => void;
}

export interface JudgeStats extends TokenUsage {
  calls: number;
  picked: number;
  abstained: number;
  /** Refusals, failures, invalid answers, and ids outside the candidate list. */
  rejected: number;
  /** The first API error message, so a failure that repeats is easy to see. */
  firstError?: string;
}

export interface JudgeResult {
  entries: MovieResolveEntry[];
  stats: JudgeStats;
}

function toJudgeCandidate(candidate: ScoredCandidate): JudgeCandidate {
  const { details } = candidate;
  return {
    id: details.id,
    title: details.title,
    originalTitle: details.originalTitle,
    year: details.year,
    runtimeMinutes: details.runtimeMinutes,
    overview: details.overview.slice(0, OVERVIEW_CHARS),
  };
}

/**
 * Asks the judge about every entry that is still open. A pick must be one of
 * the candidates. Abstaining, an unknown id, a refusal, or a failure leaves
 * the entry without a choice, so review decides.
 */
export async function judgeEntries(entries: readonly MovieResolveEntry[], deps: JudgeDeps): Promise<JudgeResult> {
  const stats: JudgeStats = { calls: 0, picked: 0, abstained: 0, rejected: 0, inputTokens: 0, outputTokens: 0 };
  const open = entries.filter((entry) => entry.resolution === null);
  const limit = pLimit(JUDGE_CONCURRENCY);
  const results = new Map<string, MovieResolution>();
  let done = 0;
  deps.onProgress?.(0, open.length);

  await Promise.all(
    open.map((entry) =>
      limit(async () => {
        results.set(entry.id, await judgeOne(entry, deps, stats));
        done += 1;
        deps.onProgress?.(done, open.length);
      }),
    ),
  );
  return { entries: entries.map((entry) => ({ ...entry, resolution: results.get(entry.id) ?? entry.resolution })), stats };
}

async function judgeOne(entry: MovieResolveEntry, deps: JudgeDeps, stats: JudgeStats): Promise<MovieResolution> {
  const best = entry.candidates[0];
  const belowNote = best === undefined ? '' : ` Best score ${best.score.toFixed(2)}: ${best.reason}.`;
  if (deps.judge === undefined) {
    return none(`no candidate is sure enough.${belowNote}`);
  }

  const outcome = await deps.judge.choose({
    fileName: deps.names.get(entry.id) ?? '',
    containerTitle: entry.probe?.title ?? null,
    durationMinutes: runtimeMinutes(entry.probe),
    candidates: entry.candidates.map(toJudgeCandidate),
  });
  stats.calls += 1;
  stats.inputTokens += outcome.usage.inputTokens;
  stats.outputTokens += outcome.usage.outputTokens;

  if (outcome.status !== 'ok') {
    stats.rejected += 1;
    if (outcome.detail !== undefined && stats.firstError === undefined) {
      stats.firstError = outcome.detail;
    }
    return none(`the judge gave no usable answer (${outcome.status}).${belowNote}`);
  }
  if (outcome.id === null) {
    stats.abstained += 1;
    return none(`the judge found no clear match.${belowNote}`);
  }
  const chosen = entry.candidates.find((candidate) => candidate.details.id === outcome.id);
  if (chosen === undefined) {
    stats.rejected += 1;
    return none(`the judge named a movie that is not a candidate.${belowNote}`);
  }
  stats.picked += 1;
  return {
    chosenId: chosen.details.id,
    via: 'judge',
    confidence: 'low',
    score: chosen.score,
    reason: `picked by the judge. ${chosen.reason}`,
  };
}
