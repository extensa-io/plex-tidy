import type { ParseCacheEntry } from '../llm/schemas.ts';
import type { MovieParseCache } from '../llm/movie-parser.ts';
import { proposeTvFields, type TvParseModel, type TvProposalStats } from '../llm/tv-parser.ts';
import type { TvParse, TvResolveEntry } from '../resolve/tv-schemas.ts';
import type { Scan } from '../scan/schemas.ts';
import { cleanText } from './cleaner.ts';
import { isOrderedSubset } from './validator.ts';

const FIRST_TV_YEAR = 1920;
const YEARS_AHEAD = 2;

/** A parse that found nothing. */
export function emptyTvParse(): TvParse {
  return { via: 'none', outcome: 'no-result', rule: null, show: null, year: null, season: null, episode: null, episodeEnd: null, episodeTitle: null };
}

function blankToNull(text: string | undefined): string | null {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** A name with dots and underscores read as spaces. Dashes stay, because they separate parts. */
function spaced(stem: string): string {
  return stem.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanedOrNull(text: string): string | null {
  const cleaned = cleanText(text.replace(/^[\s-]+|[\s-]+$/g, ''));
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : null;
}

function yearIn(text: string, now: Date): number | null {
  const years = [...text.matchAll(/(?<![0-9])((?:19|20)\d{2})(?![0-9])/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year >= FIRST_TV_YEAR && year <= now.getFullYear() + YEARS_AHEAD);
  return years.at(-1) ?? null;
}

/** After a first episode number, more numbers can follow: `e02`, `-e02`, or `-02`. Returns the last one. */
function lastEpisodeAfter(text: string): { end: number | null; length: number } {
  let rest = text;
  let consumed = 0;
  let end: number | null = null;
  for (;;) {
    const match = /^(?:[ -]?e(\d{1,3})|-(\d{1,3})(?![0-9pi]))/i.exec(rest);
    if (match === null) {
      return { end, length: consumed };
    }
    end = Number(match[1] ?? match[2]);
    consumed += match[0].length;
    rest = rest.slice(match[0].length);
  }
}

interface NumberMatch {
  season: number | null;
  episode: number;
  /** Where the numbering starts and stops in the spaced text. */
  start: number;
  stop: number;
}

interface Rule {
  /** Names the shape of name the rule reads, so a reader can tell what it accepts. */
  name: string;
  /** Finds the numbering in the spaced text. */
  find: (text: string) => NumberMatch | undefined;
}

function numbering(match: RegExpExecArray, season: number | null, episode: number): NumberMatch {
  return { season, episode, start: match.index, stop: match.index + match[0].length };
}

/** Applied in order. The first rule that finds numbers decides. */
export const tvNumberingRules: readonly Rule[] = [
  {
    name: 's01e02',
    find: (text) => {
      const match = /(?<![a-z0-9])s(\d{1,2})[ -]?e(\d{1,3})/i.exec(text);
      return match === null ? undefined : numbering(match, Number(match[1]), Number(match[2]));
    },
  },
  {
    name: '2x06',
    find: (text) => {
      const match = /(?<![a-z0-9])(\d{1,2})x(\d{1,3})(?![0-9a-z])/i.exec(text);
      return match === null ? undefined : numbering(match, Number(match[1]), Number(match[2]));
    },
  },
  {
    name: 'season-2-episode-6',
    find: (text) => {
      const match = /season[ -]?(\d{1,2})[ -]*(?:episode|ep|e)[ -]?(\d{1,3})(?![0-9])/i.exec(text);
      return match === null ? undefined : numbering(match, Number(match[1]), Number(match[2]));
    },
  },
  {
    name: 'show-dash-11-dash-title',
    // Show - 11 - Title: the number sits between two dashes.
    find: (text) => {
      const match = /^.+? - (\d{1,3}) - /.exec(text);
      return match?.[1] === undefined
        ? undefined
        : { season: null, episode: Number(match[1]), start: match[0].lastIndexOf(match[1]), stop: match[0].lastIndexOf(match[1]) + match[1].length };
    },
  },
  {
    name: '11-dash-title',
    // 11 - Title: the name starts with the number and a dash.
    find: (text) => {
      const match = /^(\d{1,3}) ?- ?(?=\S)/.exec(text);
      return match?.[1] === undefined ? undefined : { season: null, episode: Number(match[1]), start: 0, stop: match[1].length };
    },
  },
  {
    name: 'episode-11',
    find: (text) => {
      const match = /(?<![a-z])(?:episode|ep|e)[ -]?(\d{1,3})(?![0-9a-z])/i.exec(text);
      return match === null ? undefined : numbering(match, null, Number(match[1]));
    },
  },
];

/** Reads a file name that carries season and episode numbers. Returns undefined for any other name. */
export function parseEpisodeName(stem: string, now: Date = new Date()): TvParse | undefined {
  const text = spaced(stem);
  for (const rule of tvNumberingRules) {
    const found = rule.find(text);
    if (found === undefined) {
      continue;
    }
    const tail = lastEpisodeAfter(text.slice(found.stop));
    const before = text.slice(0, found.start);
    const after = text.slice(found.stop + tail.length);
    const episodeEnd = tail.end !== null && tail.end > found.episode ? tail.end : null;
    return {
      via: 'rules',
      outcome: 'valid',
      rule: rule.name,
      show: cleanedOrNull(before),
      year: yearIn(before, now),
      season: found.season,
      episode: found.episode,
      episodeEnd,
      episodeTitle: cleanedOrNull(after),
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Folders

const SEASON_FOLDER = /^(?:season|series|saison|temporada|staffel)[ ._-]*(\d{1,2})$/i;
const SHORT_SEASON_FOLDER = /^s(\d{1,2})$/i;
const SPECIALS_FOLDER = /^specials?$/i;

/** The season number a `Season N` style folder name stands for, or undefined if it is not one. */
export function seasonOfFolder(name: string): number | undefined {
  const trimmed = name.trim();
  if (SPECIALS_FOLDER.test(trimmed)) {
    return 0;
  }
  const match = SEASON_FOLDER.exec(trimmed) ?? SHORT_SEASON_FOLDER.exec(trimmed);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export interface EpisodeFolders {
  /** The show folder path relative to the root, or an empty string for a file directly in the root. */
  showDir: string;
  /** The name of the show folder, or null. */
  showFolder: string | null;
  /** The season from the `Season N` folder the file sits in, or null. */
  folderSeason: number | null;
}

/**
 * Splits the folders of a file (nearest first) into the show folder and the
 * season folder. The show folder is the nearest folder that is not a
 * `Season N` folder.
 */
export function splitEpisodeFolders(folders: readonly string[]): EpisodeFolders {
  let folderSeason: number | null = null;
  for (const [index, name] of folders.entries()) {
    const season = seasonOfFolder(name);
    if (season === undefined) {
      return { showDir: folders.slice(index).reverse().join('\\'), showFolder: name, folderSeason };
    }
    folderSeason ??= season;
  }
  return { showDir: '', showFolder: null, folderSeason };
}

export interface ShowFolderHints {
  title: string | null;
  year: number | null;
  tmdbId: number | null;
}

/** What a show folder name says: the title, a year in brackets, and a `{tmdb-<id>}` tag. */
export function showFolderHints(name: string, now: Date = new Date()): ShowFolderHints {
  const id = /\{tmdb-(\d+)\}/i.exec(name)?.[1];
  const bracketed = [...name.matchAll(/[([]((?:19|20)\d{2})[)\]]/g)].map((match) => Number(match[1])).at(-1);
  const year = bracketed !== undefined && bracketed >= FIRST_TV_YEAR && bracketed <= now.getFullYear() + YEARS_AHEAD ? bracketed : null;
  return {
    title: cleanedOrNull(cleanText(name.replace(/\{[^{}]*\}/g, ''))),
    year,
    tmdbId: id === undefined ? null : Number(id),
  };
}

// ---------------------------------------------------------------------------
// Model answers

function numberTokens(text: string): Set<number> {
  return new Set([...text.matchAll(/\d+/g)].map((match) => Number(match[0])));
}

/**
 * Checks the model's answer against the name. A title that is not in the name,
 * and a number that is not written in the name, are dropped.
 */
export function validateTvAnswer(stem: string, answer: ParseCacheEntry, now: Date = new Date()): TvParse {
  const numbers = numberTokens(stem);
  const present = (value: number | null | undefined): number | null =>
    value !== null && value !== undefined && value >= 0 && numbers.has(value) ? value : null;
  const show = blankToNull(answer.show ?? undefined);
  const episodeTitle = blankToNull(answer.episodeTitle ?? undefined);
  const year = present(answer.year);
  const episode = present(answer.episode);
  const parse: TvParse = {
    via: 'model',
    outcome: episode === null ? 'no-result' : 'valid',
    rule: null,
    show: show !== null && isOrderedSubset(show, stem) ? show : null,
    year: year !== null && year >= FIRST_TV_YEAR && year <= now.getFullYear() + YEARS_AHEAD ? year : null,
    season: present(answer.season),
    episode,
    episodeEnd: present(answer.episodeEnd),
    episodeTitle: episodeTitle !== null && isOrderedSubset(episodeTitle, stem) ? episodeTitle : null,
  };
  if (parse.episodeEnd !== null && episode !== null && parse.episodeEnd <= episode) {
    parse.episodeEnd = null;
  }
  return parse;
}

export interface ParseTvOptions {
  model: TvParseModel;
  cache: MovieParseCache;
  batchSize: number;
  now?: Date;
  onBatch?: (done: number, total: number) => void;
}

export interface ParseTvResult {
  /** The parse of every file, by file id. */
  parses: Map<string, TvParse>;
  stats: TvProposalStats;
  byRules: number;
}

/** Reads every file name. Names with numbers use the rules; the rest go to the model in batches. */
export async function parseTv(scan: Scan, options: ParseTvOptions): Promise<ParseTvResult> {
  const parses = new Map<string, TvParse>();
  const forModel: { key: string; name: string }[] = [];
  let byRules = 0;

  for (const file of scan.files) {
    const parsed = parseEpisodeName(file.stem, options.now);
    if (parsed === undefined) {
      forModel.push({ key: file.id, name: file.stem });
    } else {
      parses.set(file.id, parsed);
      byRules += 1;
    }
  }

  const proposals = await proposeTvFields(forModel, {
    model: options.model,
    cache: options.cache,
    batchSize: options.batchSize,
    ...(options.onBatch === undefined ? {} : { onBatch: options.onBatch }),
  });
  for (const { key, name } of forModel) {
    const answer = proposals.answers.get(key);
    parses.set(
      key,
      answer === undefined ? { ...emptyTvParse(), via: 'model', outcome: 'no-answer' } : validateTvAnswer(name, answer, options.now),
    );
  }
  return { parses, stats: proposals.stats, byRules };
}

/** Builds the resolve entries for a scan, once the groups are known. */
export function toResolveEntries(scan: Scan, parses: ReadonlyMap<string, TvParse>, groupKeyOf: (id: string) => string): TvResolveEntry[] {
  return scan.files.map((file) => ({
    id: file.id,
    groupKey: groupKeyOf(file.id),
    parse: parses.get(file.id) ?? emptyTvParse(),
    manual: null,
    episode: null,
  }));
}
