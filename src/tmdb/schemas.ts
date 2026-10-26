import { z } from 'zod';
import { versionedSchema } from '../state/schemas.ts';

/** `YYYY-MM-DD`, or an empty string when TMDB has no date. */
const releaseDate = z.string().nullish();

/** One hit of a movie search. Every field TMDB may leave out is optional. */
export const searchHitSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().default(''),
  original_title: z.string().default(''),
  release_date: releaseDate,
  popularity: z.number().default(0),
});

export const searchResponseSchema = z.object({
  results: z.array(searchHitSchema),
});

const personSchema = z.object({
  name: z.string().default(''),
  job: z.string().optional(),
  order: z.number().optional(),
});

/** The movie details response with credits appended. */
export const detailsResponseSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().default(''),
  original_title: z.string().default(''),
  release_date: releaseDate,
  runtime: z.number().nullish(),
  overview: z.string().nullish(),
  genres: z.array(z.object({ name: z.string() })).default([]),
  credits: z
    .object({
      cast: z.array(personSchema).default([]),
      crew: z.array(personSchema).default([]),
    })
    .optional(),
});

/** Number of cast members written into the tag record. */
export const MAX_ACTORS = 10;

/** What the tool keeps of a movie. Stored in state files, so it is a strict shape. */
export const movieDetailsSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  originalTitle: z.string().min(1),
  /** `YYYY-MM-DD`, or null when TMDB has no release date. */
  releaseDate: z.string().nullable(),
  year: z.number().int().nullable(),
  runtimeMinutes: z.number().int().nullable(),
  overview: z.string(),
  genres: z.array(z.string()),
  directors: z.array(z.string()),
  cast: z.array(z.string()),
  /** Other titles that a search matched, such as the Spanish title. Used by the scorer. */
  altTitles: z.array(z.string()).default([]),
});
export type MovieDetails = z.infer<typeof movieDetailsSchema>;

/** A search hit reduced to what ranking needs. */
export const movieHitSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  originalTitle: z.string(),
  year: z.number().int().nullable(),
  popularity: z.number(),
});
export type MovieHit = z.infer<typeof movieHitSchema>;

export function yearOf(date: string | null | undefined): number | null {
  const match = /^(\d{4})-/.exec(date ?? '');
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function toHit(raw: z.infer<typeof searchHitSchema>): MovieHit {
  return {
    id: raw.id,
    title: raw.title,
    originalTitle: raw.original_title,
    year: yearOf(raw.release_date),
    popularity: raw.popularity,
  };
}

export function toDetails(raw: z.infer<typeof detailsResponseSchema>): MovieDetails | undefined {
  const title = raw.title.trim() || raw.original_title.trim();
  const originalTitle = raw.original_title.trim() || title;
  if (title === '') {
    return undefined;
  }
  const crew = raw.credits?.crew ?? [];
  const cast = [...(raw.credits?.cast ?? [])].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  return {
    id: raw.id,
    title,
    originalTitle,
    releaseDate: raw.release_date === undefined || raw.release_date === null || raw.release_date === '' ? null : raw.release_date,
    year: yearOf(raw.release_date),
    runtimeMinutes: raw.runtime !== undefined && raw.runtime !== null && raw.runtime > 0 ? Math.round(raw.runtime) : null,
    overview: raw.overview?.trim() ?? '',
    genres: raw.genres.map((genre) => genre.name.trim()).filter((name) => name !== ''),
    directors: unique(crew.filter((person) => person.job === 'Director').map((person) => person.name.trim())),
    cast: unique(cast.map((person) => person.name.trim())).slice(0, MAX_ACTORS),
    altTitles: [],
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}

export const TMDB_CACHE_SCHEMA_VERSION = 1;

export const tmdbCacheSchema = versionedSchema(TMDB_CACHE_SCHEMA_VERSION, {
  searches: z.record(
    z.string(),
    z.object({ cachedAt: z.iso.datetime(), hits: z.array(movieHitSchema) }),
  ),
  /** `null` means TMDB has no movie with that id. */
  movies: z.record(
    z.string(),
    z.object({ cachedAt: z.iso.datetime(), details: movieDetailsSchema.nullable() }),
  ),
});
export type TmdbCacheFile = z.infer<typeof tmdbCacheSchema>;
