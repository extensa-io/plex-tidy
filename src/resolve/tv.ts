import pLimit from 'p-limit';
import type { TokenUsage } from '../llm/model-client.ts';
import type { ShowJudge, ShowJudgeCandidate } from '../llm/tv-judge.ts';
import { showFolderHints, splitEpisodeFolders } from '../parse/tv.ts';
import type { Scan, ScanFile } from '../scan/schemas.ts';
import type { TmdbClient } from '../tmdb/client.ts';
import type { EpisodeInfo, ShowDetails, ShowHit } from '../tmdb/schemas.ts';
import { titleSimilarity } from './scorer.ts';
import type {
  TvEpisodeResolution,
  TvParse,
  TvResolveEntry,
  TvShowCandidate,
  TvShowGroup,
  TvShowResolution,
} from './tv-schemas.ts';

/** Candidates kept per show, and shown to the judge. */
export const MAX_SHOW_CANDIDATES = 5;
/** Two candidates closer than this are too alike to pick one without help. */
export const SHOW_AMBIGUITY_MARGIN = 0.05;
/** Weights of the show score: the name counts most, then the first air year. */
export const SHOW_SCORE_WEIGHTS = { title: 0.8, year: 0.2 } as const;
const JUDGE_SAMPLE_FILES = 5;
const OVERVIEW_CHARS = 300;
const JUDGE_CONCURRENCY = 3;
const SHOW_CONCURRENCY = 4;

// ---------------------------------------------------------------------------
// Grouping

export interface Grouping {
  groups: TvShowGroup[];
  /** The group key of each file, by file id. */
  keyOf: ReadonlyMap<string, string>;
}

/** Key for files that sit directly in the root: they are grouped by the show named in their file names. */
function rootKey(show: string | null): string {
  return `\u0000${(show ?? '').toLowerCase()}`;
}

/**
 * Groups the episode files by show. Files that share a show folder are one
 * show. Files directly in the root are grouped by the show their names say.
 */
export function groupEpisodes(scan: Scan, parses: ReadonlyMap<string, TvParse>, now: Date = new Date()): Grouping {
  const groups = new Map<string, TvShowGroup>();
  const keyOf = new Map<string, string>();

  for (const file of scan.files) {
    const parse = parses.get(file.id);
    const { showDir, showFolder } = splitEpisodeFolders(file.folders);
    const key = showDir === '' ? rootKey(parse?.show ?? null) : showDir.toLowerCase();
    keyOf.set(file.id, key);

    let group = groups.get(key);
    if (group === undefined) {
      const hints = showFolder === null ? { title: parse?.show ?? null, year: parse?.year ?? null, tmdbId: null } : showFolderHints(showFolder, now);
      group = {
        key,
        dir: showDir,
        query: hints.title ?? parse?.show ?? null,
        year: hints.year ?? parse?.year ?? null,
        tmdbId: hints.tmdbId,
        fileIds: [],
        candidates: [],
        resolution: null,
      };
      groups.set(key, group);
    }
    group.fileIds.push(file.id);
  }
  return { groups: [...groups.values()], keyOf };
}

// ---------------------------------------------------------------------------
// Show scoring

export interface ShowFacts {
  title: string;
  year: number | null;
}

/** Scores a show against the title and first air year the library gives. A missing year contradicts nothing. */
export function scoreShow(facts: ShowFacts, show: Pick<ShowDetails, 'name' | 'originalName' | 'altNames' | 'year'>): { score: number; reason: string } {
  const names = [show.name, show.originalName, ...show.altNames];
  const similarity = Math.max(...names.map((name) => titleSimilarity(facts.title, name)));
  let year = 1;
  let yearText = 'no year in the folder name';
  if (facts.year !== null) {
    const difference = show.year === null ? null : Math.abs(facts.year - show.year);
    year = difference === null ? 0.5 : difference === 0 ? 1 : difference === 1 ? 0.6 : 0;
    yearText = difference === null ? 'TMDB has no year' : difference === 0 ? 'year matches' : `year differs by ${difference}`;
  }
  const score = SHOW_SCORE_WEIGHTS.title * similarity + SHOW_SCORE_WEIGHTS.year * year;
  return { score: Math.round(score * 1000) / 1000, reason: `name ${Math.round(similarity * 100)}%, ${yearText}` };
}

// ---------------------------------------------------------------------------
// Show matching

export interface MatchShowsDeps {
  tmdb: TmdbClient;
  /** A show at or above this score, clear of the rest, is chosen without the judge. */
  threshold: number;
  onProgress?: (done: number, total: number) => void;
}

function addAlternativeNames(details: ShowDetails, variants: readonly ShowHit[]): ShowDetails {
  const known = new Set([details.name, details.originalName, ...details.altNames]);
  const extra = [...new Set(variants.flatMap((hit) => [hit.name, hit.originalName]))].filter((name) => name !== '' && !known.has(name));
  return extra.length === 0 ? details : { ...details, altNames: [...details.altNames, ...extra] };
}

async function collectShows(facts: ShowFacts, hits: Map<number, ShowHit[]>, year: number | null, deps: MatchShowsDeps): Promise<TvShowCandidate[]> {
  for (const hit of await deps.tmdb.searchShows({ query: facts.title, year })) {
    hits.set(hit.id, [...(hits.get(hit.id) ?? []), hit]);
  }
  const ranked = [...hits.values()]
    .map((variants) => ({
      variants,
      rank: Math.max(...variants.flatMap((hit) => [titleSimilarity(facts.title, hit.name), titleSimilarity(facts.title, hit.originalName)])),
    }))
    .sort((a, b) => b.rank - a.rank || Math.max(...b.variants.map((hit) => hit.popularity)) - Math.max(...a.variants.map((hit) => hit.popularity)))
    .slice(0, MAX_SHOW_CANDIDATES + 3);

  const scored: TvShowCandidate[] = [];
  for (const { variants } of ranked) {
    const first = variants[0];
    const details = first === undefined ? undefined : await deps.tmdb.showDetails(first.id);
    if (details !== undefined) {
      const withNames = addAlternativeNames(details, variants);
      scored.push({ details: withNames, ...scoreShow(facts, withNames) });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_SHOW_CANDIDATES);
}

async function matchGroup(group: TvShowGroup, deps: MatchShowsDeps): Promise<TvShowGroup> {
  if (group.tmdbId !== null) {
    const details = await deps.tmdb.showDetails(group.tmdbId);
    if (details === undefined) {
      return { ...group, candidates: [], resolution: none(`TMDB has no show with id ${group.tmdbId}`) };
    }
    return {
      ...group,
      candidates: [{ details, score: 1, reason: 'the id is in the folder name' }],
      resolution: { chosenId: details.id, via: 'tmdb-id', confidence: 'high', score: null, reason: 'the id is in the folder name' },
    };
  }
  if (group.query === null) {
    return { ...group, resolution: none('the folder and file names give no show title') };
  }

  const facts: ShowFacts = { title: group.query, year: group.year };
  const hits = new Map<number, ShowHit[]>();
  let candidates = await collectShows(facts, hits, facts.year, deps);
  if ((candidates[0]?.score ?? 0) < deps.threshold && facts.year !== null) {
    candidates = await collectShows(facts, hits, null, deps);
  }
  if (candidates.length === 0) {
    return { ...group, candidates: [], resolution: none('TMDB found no show for this title') };
  }
  const [best, second] = candidates;
  if (best !== undefined && best.score >= deps.threshold && (second === undefined || best.score - second.score >= SHOW_AMBIGUITY_MARGIN)) {
    return {
      ...group,
      candidates,
      resolution: { chosenId: best.details.id, via: 'score', confidence: 'high', score: best.score, reason: best.reason },
    };
  }
  return { ...group, candidates, resolution: null };
}

function none(reason: string): TvShowResolution {
  return { chosenId: null, via: 'none', confidence: 'low', score: null, reason };
}

export interface MatchShowsOutcome {
  groups: TvShowGroup[];
  /** Groups left for the judge. */
  open: number;
}

/** Searches TMDB once for each show and scores the candidates. */
export async function matchShows(groups: readonly TvShowGroup[], deps: MatchShowsDeps): Promise<MatchShowsOutcome> {
  const limit = pLimit(SHOW_CONCURRENCY);
  const work = groups.filter((group) => group.resolution === null);
  let done = 0;
  deps.onProgress?.(0, work.length);
  const results = new Map<string, TvShowGroup>();
  await Promise.all(
    work.map((group) =>
      limit(async () => {
        results.set(group.key, await matchGroup(group, deps));
        done += 1;
        deps.onProgress?.(done, work.length);
      }),
    ),
  );
  const merged = groups.map((group) => results.get(group.key) ?? group);
  return { groups: merged, open: merged.filter((group) => group.resolution === null).length };
}

// ---------------------------------------------------------------------------
// Judge

export interface JudgeShowsDeps {
  judge: ShowJudge | undefined;
  /** The base file names without extension, by file id. */
  names: ReadonlyMap<string, string>;
  onProgress?: (done: number, total: number) => void;
}

export interface ShowJudgeStats extends TokenUsage {
  calls: number;
  picked: number;
  abstained: number;
  rejected: number;
  firstError?: string;
}

function toJudgeCandidate(candidate: TvShowCandidate): ShowJudgeCandidate {
  const { details } = candidate;
  return {
    id: details.id,
    name: details.name,
    originalName: details.originalName,
    year: details.year,
    seasons: details.seasons.filter((season) => season.season > 0).length,
    episodes: details.episodeCount,
    overview: details.overview.slice(0, OVERVIEW_CHARS),
  };
}

/** Asks the judge about every show that is still open. A pick must be one of the candidates. */
export async function judgeShows(groups: readonly TvShowGroup[], deps: JudgeShowsDeps): Promise<{ groups: TvShowGroup[]; stats: ShowJudgeStats }> {
  const stats: ShowJudgeStats = { calls: 0, picked: 0, abstained: 0, rejected: 0, inputTokens: 0, outputTokens: 0 };
  const open = groups.filter((group) => group.resolution === null);
  const limit = pLimit(JUDGE_CONCURRENCY);
  const results = new Map<string, TvShowResolution>();
  let done = 0;
  deps.onProgress?.(0, open.length);
  await Promise.all(
    open.map((group) =>
      limit(async () => {
        results.set(group.key, await judgeOne(group, deps, stats));
        done += 1;
        deps.onProgress?.(done, open.length);
      }),
    ),
  );
  return { groups: groups.map((group) => ({ ...group, resolution: results.get(group.key) ?? group.resolution })), stats };
}

async function judgeOne(group: TvShowGroup, deps: JudgeShowsDeps, stats: ShowJudgeStats): Promise<TvShowResolution> {
  const best = group.candidates[0];
  const note = best === undefined ? '' : ` Best score ${best.score.toFixed(2)}: ${best.reason}.`;
  if (deps.judge === undefined) {
    return none(`no candidate is sure enough.${note}`);
  }
  const names = group.fileIds.slice(0, JUDGE_SAMPLE_FILES).map((id) => deps.names.get(id) ?? '');
  const outcome = await deps.judge.choose({
    fileNames: names,
    episodeCount: group.fileIds.length,
    candidates: group.candidates.map(toJudgeCandidate),
  });
  stats.calls += 1;
  stats.inputTokens += outcome.usage.inputTokens;
  stats.outputTokens += outcome.usage.outputTokens;

  if (outcome.status !== 'ok') {
    stats.rejected += 1;
    if (outcome.detail !== undefined && stats.firstError === undefined) {
      stats.firstError = outcome.detail;
    }
    return none(`the judge gave no usable answer (${outcome.status}).${note}`);
  }
  if (outcome.id === null) {
    stats.abstained += 1;
    return none(`the judge found no clear match.${note}`);
  }
  const chosen = group.candidates.find((candidate) => candidate.details.id === outcome.id);
  if (chosen === undefined) {
    stats.rejected += 1;
    return none(`the judge named a show that is not a candidate.${note}`);
  }
  stats.picked += 1;
  return { chosenId: chosen.details.id, via: 'judge', confidence: 'low', score: chosen.score, reason: `picked by the judge. ${chosen.reason}` };
}

// ---------------------------------------------------------------------------
// Episodes

/** The season a file belongs to, and how that was decided. */
export function settleSeason(
  parse: Pick<TvParse, 'season' | 'episode'>,
  folderSeason: number | null,
): Pick<TvEpisodeResolution, 'season' | 'seasonSource' | 'conflict'> {
  if (parse.season !== null) {
    return { season: parse.season, seasonSource: 'name', conflict: folderSeason !== null && folderSeason !== parse.season };
  }
  if (folderSeason !== null) {
    return { season: folderSeason, seasonSource: 'folder', conflict: false };
  }
  // An episode number with no season at all is taken as season 1 and always flagged.
  return { season: parse.episode === null ? null : 1, seasonSource: 'assumed', conflict: false };
}

export interface ResolveEpisodesDeps {
  tmdb: TmdbClient;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Matches every episode file of the resolved shows against the TMDB season
 * listings, in aired order. The listing, not the file name, supplies the titles.
 */
export async function resolveEpisodes(
  scan: Scan,
  groups: readonly TvShowGroup[],
  entries: readonly TvResolveEntry[],
  deps: ResolveEpisodesDeps,
): Promise<TvResolveEntry[]> {
  const files = new Map<string, ScanFile>(scan.files.map((file) => [file.id, file]));
  const chosen = new Map(groups.map((group) => [group.key, group.resolution?.chosenId ?? null]));

  // The listings that are needed, once each.
  const wanted = new Map<string, { showId: number; season: number }>();
  const numbersOf = (entry: TvResolveEntry) => {
    const file = files.get(entry.id);
    const folderSeason = file === undefined ? null : splitEpisodeFolders(file.folders).folderSeason;
    const source = entry.manual === null ? entry.parse : { season: entry.manual.season, episode: entry.manual.episode, episodeEnd: entry.manual.episodeEnd };
    return { source, folderSeason };
  };
  for (const entry of entries) {
    const showId = chosen.get(entry.groupKey);
    const { source, folderSeason } = numbersOf(entry);
    const { season } = settleSeason(source, folderSeason);
    if (showId !== null && showId !== undefined && season !== null && source.episode !== null) {
      wanted.set(`${showId}/${season}`, { showId, season });
    }
  }

  const limit = pLimit(SHOW_CONCURRENCY);
  const listings = new Map<string, EpisodeInfo[] | undefined>();
  let done = 0;
  deps.onProgress?.(0, wanted.size);
  await Promise.all(
    [...wanted.entries()].map(([key, { showId, season }]) =>
      limit(async () => {
        listings.set(key, await deps.tmdb.seasonEpisodes(showId, season));
        done += 1;
        deps.onProgress?.(done, wanted.size);
      }),
    ),
  );

  return entries.map((entry) => {
    const showId = chosen.get(entry.groupKey);
    const { source, folderSeason } = numbersOf(entry);
    const settled = entry.manual === null ? settleSeason(source, folderSeason) : { season: entry.manual.season, seasonSource: 'manual' as const, conflict: false };
    return { ...entry, episode: episodeFor(source, settled, showId ?? null, listings) };
  });
}

function episodeFor(
  source: Pick<TvParse, 'episode' | 'episodeEnd'>,
  settled: Pick<TvEpisodeResolution, 'season' | 'seasonSource' | 'conflict'>,
  showId: number | null,
  listings: ReadonlyMap<string, EpisodeInfo[] | undefined>,
): TvEpisodeResolution {
  const base = { ...settled, episode: source.episode, episodeEnd: source.episodeEnd, found: false, titles: [] as string[], airDate: null, overview: '' };
  if (source.episode === null || settled.season === null) {
    return { ...base, reason: 'the name has no episode number' };
  }
  if (showId === null) {
    return { ...base, reason: 'the show is not chosen' };
  }
  const listing = listings.get(`${showId}/${settled.season}`);
  if (listing === undefined) {
    return { ...base, reason: `TMDB has no season ${settled.season} for this show` };
  }
  const last = source.episodeEnd ?? source.episode;
  const episodes: EpisodeInfo[] = [];
  for (let number = source.episode; number <= last; number += 1) {
    const found = listing.find((candidate) => candidate.number === number);
    if (found === undefined) {
      return { ...base, reason: `TMDB lists no episode ${number} in season ${settled.season}` };
    }
    episodes.push(found);
  }
  const first = episodes[0];
  return {
    ...base,
    found: true,
    titles: episodes.map((episode) => episode.name),
    airDate: first?.airDate ?? null,
    overview: first?.overview ?? '',
    reason: describeSeason(settled),
  };
}

function describeSeason(settled: Pick<TvEpisodeResolution, 'seasonSource' | 'conflict' | 'season'>): string {
  if (settled.seasonSource === 'assumed') {
    return 'the name has no season, so season 1 was assumed';
  }
  if (settled.conflict) {
    return 'the season in the file name differs from the Season folder';
  }
  return settled.seasonSource === 'folder' ? 'season taken from the Season folder' : 'matched by season and episode number';
}
