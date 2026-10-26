import type { MovieDetails } from '../tmdb/schemas.ts';

/** Initial weights: the title counts most, then the year, then the length. Tuned on real runs. */
export const SCORE_WEIGHTS = { title: 0.6, year: 0.25, runtime: 0.15 } as const;

/** A part of the score that has no data on one side counts as half. */
const UNKNOWN = 0.5;
const RUNTIME_EXACT_MINUTES = 2;

/** What the file says about itself. */
export interface FileFacts {
  title: string;
  year: number | null;
  /** From the probe, rounded to minutes. */
  runtimeMinutes: number | null;
}

/** What the scorer needs to know about a candidate. */
export type CandidateFacts = Pick<MovieDetails, 'title' | 'originalTitle' | 'altTitles' | 'year' | 'runtimeMinutes'>;

export interface Score {
  /** From 0 to 1. */
  score: number;
  reason: string;
}

/** Lowercase, no accents, `&` as `and`, punctuation as spaces. */
export function normalizeTitle(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, (previous[column - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** From 0 to 1, after normalizing both titles. */
export function titleSimilarity(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  const longest = Math.max(left.length, right.length);
  if (longest === 0) {
    return 0;
  }
  return 1 - editDistance(left, right) / longest;
}

function yearPart(file: number | null, movie: number | null): { value: number; text: string } {
  if (file === null) {
    return { value: UNKNOWN, text: 'no year in the name' };
  }
  if (movie === null) {
    return { value: UNKNOWN, text: 'TMDB has no year' };
  }
  const difference = Math.abs(file - movie);
  if (difference === 0) {
    return { value: 1, text: 'year matches' };
  }
  return { value: difference === 1 ? 0.6 : 0, text: `year differs by ${difference}` };
}

function runtimePart(file: number | null, movie: number | null): { value: number; text: string } {
  if (file === null || movie === null) {
    return { value: UNKNOWN, text: 'length unknown' };
  }
  const difference = Math.abs(file - movie);
  const value =
    difference <= RUNTIME_EXACT_MINUTES ? 1 : difference <= 5 ? 0.5 : difference <= 10 ? 0.25 : 0;
  return { value, text: difference === 0 ? 'length matches' : `length differs by ${difference} min` };
}

/** Scores one candidate against one file. The title is compared with every title the candidate has. */
export function scoreCandidate(file: FileFacts, movie: CandidateFacts): Score {
  const titles = [movie.title, movie.originalTitle, ...movie.altTitles];
  const similarity = Math.max(...titles.map((title) => titleSimilarity(file.title, title)));
  const year = yearPart(file.year, movie.year);
  const runtime = runtimePart(file.runtimeMinutes, movie.runtimeMinutes);

  const score =
    SCORE_WEIGHTS.title * similarity + SCORE_WEIGHTS.year * year.value + SCORE_WEIGHTS.runtime * runtime.value;
  return {
    score: Math.round(score * 1000) / 1000,
    reason: `title ${Math.round(similarity * 100)}%, ${year.text}, ${runtime.text}`,
  };
}
