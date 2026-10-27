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

/** One hit of a TV show search. */
export const showSearchHitSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().default(''),
  original_name: z.string().default(''),
  first_air_date: releaseDate,
  popularity: z.number().default(0),
});

export const showSearchResponseSchema = z.object({
  results: z.array(showSearchHitSchema),
});

/** The TV show details response. */
export const showDetailsResponseSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().default(''),
  original_name: z.string().default(''),
  first_air_date: releaseDate,
  overview: z.string().nullish(),
  genres: z.array(z.object({ name: z.string() })).default([]),
  number_of_episodes: z.number().nullish(),
  seasons: z.array(z.object({ season_number: z.number().int(), episode_count: z.number().nullish() })).default([]),
});

export const seasonResponseSchema = z.object({
  episodes: z
    .array(
      z.object({
        episode_number: z.number().int(),
        name: z.string().default(''),
        air_date: releaseDate,
        overview: z.string().nullish(),
      }),
    )
    .default([]),
});

/** A TV search hit reduced to what ranking needs. */
export const showHitSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  originalName: z.string(),
  year: z.number().int().nullable(),
  popularity: z.number(),
});
export type ShowHit = z.infer<typeof showHitSchema>;

/** What the tool keeps of a TV show. */
export const showDetailsSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  originalName: z.string().min(1),
  /** `YYYY-MM-DD`, or null when TMDB has no first air date. */
  firstAirDate: z.string().nullable(),
  year: z.number().int().nullable(),
  overview: z.string(),
  genres: z.array(z.string()),
  /** The season numbers TMDB lists, with their episode counts. */
  seasons: z.array(z.object({ season: z.number().int(), episodes: z.number().int() })),
  episodeCount: z.number().int().nullable(),
  /** Other names that a search matched. Used by the scorer. */
  altNames: z.array(z.string()).default([]),
});
export type ShowDetails = z.infer<typeof showDetailsSchema>;

/** One episode of a season listing, in aired order. */
export const episodeInfoSchema = z.object({
  number: z.number().int(),
  name: z.string(),
  airDate: z.string().nullable(),
  overview: z.string(),
});
export type EpisodeInfo = z.infer<typeof episodeInfoSchema>;

export function toShowHit(raw: z.infer<typeof showSearchHitSchema>): ShowHit {
  return {
    id: raw.id,
    name: raw.name,
    originalName: raw.original_name,
    year: yearOf(raw.first_air_date),
    popularity: raw.popularity,
  };
}

export function toShowDetails(raw: z.infer<typeof showDetailsResponseSchema>): ShowDetails | undefined {
  const name = raw.name.trim() || raw.original_name.trim();
  if (name === '') {
    return undefined;
  }
  const firstAirDate = raw.first_air_date === undefined || raw.first_air_date === null || raw.first_air_date === '' ? null : raw.first_air_date;
  return {
    id: raw.id,
    name,
    originalName: raw.original_name.trim() || name,
    firstAirDate,
    year: yearOf(firstAirDate),
    overview: raw.overview?.trim() ?? '',
    genres: raw.genres.map((genre) => genre.name.trim()).filter((genre) => genre !== ''),
    seasons: raw.seasons.map((season) => ({ season: season.season_number, episodes: Math.max(0, Math.round(season.episode_count ?? 0)) })),
    episodeCount: raw.number_of_episodes === undefined || raw.number_of_episodes === null ? null : Math.round(raw.number_of_episodes),
    altNames: [],
  };
}

export function toEpisodes(raw: z.infer<typeof seasonResponseSchema>): EpisodeInfo[] {
  return raw.episodes
    .map((episode) => ({
      number: episode.episode_number,
      name: episode.name.trim(),
      airDate: episode.air_date === undefined || episode.air_date === null || episode.air_date === '' ? null : episode.air_date,
      overview: episode.overview?.trim() ?? '',
    }))
    .sort((a, b) => a.number - b.number);
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
  // The TV tables default to empty, so a cache file written before TV support still reads.
  showSearches: z
    .record(z.string(), z.object({ cachedAt: z.iso.datetime(), hits: z.array(showHitSchema) }))
    .default({}),
  /** `null` means TMDB has no show with that id. */
  shows: z
    .record(z.string(), z.object({ cachedAt: z.iso.datetime(), details: showDetailsSchema.nullable() }))
    .default({}),
  /** Keyed by `<show id>/<season>`. `null` means TMDB has no such season. */
  seasons: z
    .record(z.string(), z.object({ cachedAt: z.iso.datetime(), episodes: z.array(episodeInfoSchema).nullable() }))
    .default({}),
});
export type TmdbCacheFile = z.infer<typeof tmdbCacheSchema>;
