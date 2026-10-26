import type { ParseCacheEntry } from '../llm/schemas.ts';
import {
  proposeMovieFields,
  type MovieParseCache,
  type MovieParseModel,
  type MovieProposalStats,
} from '../llm/movie-parser.ts';
import type { MovieParse, MovieResolveEntry } from '../resolve/movie-schemas.ts';
import type { Scan } from '../scan/schemas.ts';
import { cleanText } from './cleaner.ts';
import { isOrderedSubset } from './validator.ts';

const FIRST_FILM_YEAR = 1888;
/** A film announced for next year can carry that year. */
const YEARS_AHEAD = 2;

interface PatternRule {
  /** Names the kind of name the rule reads, so a reader can tell what it accepts. */
  name: string;
  pattern: RegExp;
}

/** Applied in order. A name that matches no rule goes to the model. */
export const moviePatternRules: readonly PatternRule[] = [
  {
    name: 'title-year-tmdb-id-edition',
    // Title (2010) {tmdb-123} {edition-Extended}: the shape this tool writes.
    pattern: /^(?<title>.+?)(?:\s*\((?<year>\d{4})\))?\s*\{tmdb-(?<id>\d+)\}(?:\s*\{edition-(?<edition>[^{}]+)\})?$/,
  },
  {
    name: 'title-year-edition',
    // Title (2010) and Title (2010) {edition-Extended}.
    pattern: /^(?<title>.+?)\s*\((?<year>\d{4})\)(?:\s*\{edition-(?<edition>[^{}]+)\})?$/,
  },
];

function plausibleYear(year: number, now: Date): boolean {
  return year >= FIRST_FILM_YEAR && year <= now.getFullYear() + YEARS_AHEAD;
}

function blankToNull(text: string | undefined): string | null {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function emptyParse(): MovieParse {
  return { via: 'none', outcome: 'no-result', title: null, year: null, edition: null, language: null, part: null, tmdbId: null };
}

/** Reads a name that already has the clean shape. Returns undefined for any other name. */
export function parseByPattern(stem: string, now: Date = new Date()): MovieParse | undefined {
  const name = stem.trim();
  for (const rule of moviePatternRules) {
    const groups = rule.pattern.exec(name)?.groups;
    const title = groups?.title?.trim();
    if (groups === undefined || title === undefined || !/[\p{L}\p{N}]/u.test(title) || /[{}]/.test(title)) {
      continue;
    }
    const year = groups.year === undefined ? null : Number(groups.year);
    if (year !== null && !plausibleYear(year, now)) {
      continue;
    }
    const id = groups.id === undefined ? null : Number(groups.id);
    return {
      via: id === null ? 'pattern' : 'tmdb-id',
      outcome: 'valid',
      title,
      year,
      edition: blankToNull(groups.edition),
      language: null,
      part: null,
      tmdbId: id !== null && id > 0 ? id : null,
    };
  }
  return undefined;
}

/**
 * Checks the model's answer against the name. A field that is not literally in
 * the name is dropped. A title that fails the word check makes the whole answer invalid.
 */
export function validateModelAnswer(stem: string, answer: ParseCacheEntry, now: Date = new Date()): MovieParse {
  const title = answer.title?.trim() ?? '';
  if (title === '') {
    return { ...emptyParse(), via: 'model', outcome: 'no-result' };
  }
  if (!isOrderedSubset(title, stem)) {
    return { ...emptyParse(), via: 'model', outcome: 'invalid' };
  }
  const year = answer.year ?? null;
  const edition = answer.edition?.trim() ?? '';
  const part = answer.part?.trim() ?? '';
  const language = answer.language?.trim().toLowerCase() ?? '';
  // The model sometimes keeps a release tag such as "dvd9" in the title. The cleaner removes it.
  const cleaned = cleanText(title);
  return {
    via: 'model',
    outcome: 'valid',
    title: cleaned !== '' && isOrderedSubset(cleaned, stem) ? cleaned : title,
    year: year !== null && plausibleYear(year, now) && stem.includes(String(year)) ? year : null,
    edition: edition !== '' && isOrderedSubset(edition, stem) ? edition : null,
    language: /^[a-z]{2}$/.test(language) ? language : null,
    part: part !== '' && isOrderedSubset(part, stem) ? part : null,
    tmdbId: null,
  };
}

const BRACKETED_YEAR = /[([](?<year>(?:19|20)\d{2})[)\]]/g;
const BARE_YEAR = /(?<![0-9])(?<year>(?:19|20)\d{2})(?![0-9])/g;

function lastYear(text: string, pattern: RegExp, now: Date): number | null {
  const years = [...text.matchAll(pattern)]
    .map((match) => Number(match.groups?.year))
    .filter((year) => plausibleYear(year, now));
  return years.at(-1) ?? null;
}

/**
 * A release year written in a folder name, nearest folder first. A year in
 * brackets wins over a bare one, and a bare year that starts the name is
 * ignored because it is more likely part of a title. This reads folder names on
 * this machine only; they are never sent to the model.
 */
export function yearFromFolders(folders: readonly string[], now: Date = new Date()): number | null {
  for (const folder of folders) {
    const bracketed = lastYear(folder, BRACKETED_YEAR, now);
    if (bracketed !== null) {
      return bracketed;
    }
  }
  for (const folder of folders) {
    const bare = lastYear(folder.replace(/^(?:19|20)\d{2}(?![0-9])/, ''), BARE_YEAR, now);
    if (bare !== null) {
      return bare;
    }
  }
  return null;
}

/** A title read from a folder name: its list number, year, and release tags removed. Local only. */
export function titleFromFolder(folder: string): string | null {
  const withoutNumber = folder.replace(/^\d{1,3}[\s._)-]+(?=\p{L})/u, '');
  const cleaned = cleanText(withoutNumber);
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : null;
}

export interface ParseMoviesOptions {
  model: MovieParseModel;
  cache: MovieParseCache;
  batchSize: number;
  now?: Date;
  onBatch?: (done: number, total: number) => void;
}

export interface ParseMoviesResult {
  entries: MovieResolveEntry[];
  stats: MovieProposalStats;
  /** Files read by a pattern, with and without a TMDB id. */
  byPattern: number;
  byTmdbId: number;
}

/** Reads every file name. Clean names use the patterns; the rest go to the model in batches. */
export async function parseMovies(scan: Scan, options: ParseMoviesOptions): Promise<ParseMoviesResult> {
  const parses = new Map<string, MovieParse>();
  const forModel: { key: string; name: string }[] = [];
  let byPattern = 0;
  let byTmdbId = 0;

  for (const file of scan.files) {
    const parsed = parseByPattern(file.stem, options.now);
    if (parsed === undefined) {
      forModel.push({ key: file.id, name: file.stem });
    } else {
      parses.set(file.id, parsed);
      if (parsed.via === 'tmdb-id') {
        byTmdbId += 1;
      } else {
        byPattern += 1;
      }
    }
  }

  const proposals = await proposeMovieFields(forModel, {
    model: options.model,
    cache: options.cache,
    batchSize: options.batchSize,
    ...(options.onBatch === undefined ? {} : { onBatch: options.onBatch }),
  });
  for (const { key, name } of forModel) {
    const answer = proposals.answers.get(key);
    parses.set(
      key,
      answer === undefined ? { ...emptyParse(), via: 'model', outcome: 'no-answer' } : validateModelAnswer(name, answer, options.now),
    );
  }

  return {
    entries: scan.files.map((file) => ({
      id: file.id,
      parse: parses.get(file.id) ?? emptyParse(),
      probe: null,
      candidates: [],
      resolution: null,
    })),
    stats: proposals.stats,
    byPattern,
    byTmdbId,
  };
}
