import pLimit from 'p-limit';
import { AppError } from '../errors.ts';
import { readJsonFile, writeJsonFile } from '../state/json-file.ts';
import {
  TMDB_CACHE_SCHEMA_VERSION,
  detailsResponseSchema,
  searchResponseSchema,
  tmdbCacheSchema,
  toDetails,
  toHit,
  type MovieDetails,
  type MovieHit,
  type TmdbCacheFile,
} from './schemas.ts';

const BASE_URL = 'https://api.themoviedb.org/3';
const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_TTL_MS = 7 * DAY_MS;
const DETAILS_TTL_MS = 30 * DAY_MS;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
const MAX_RETRY_WAIT_MS = 10_000;

export interface SearchQuery {
  query: string;
  year?: number | null;
  /** A TMDB language code such as `en-US` or `es-ES`. */
  language?: string;
}

/** What the pipeline needs from TMDB. Tests replace it with a stub. */
export interface TmdbClient {
  searchMovies(query: SearchQuery): Promise<MovieHit[]>;
  /** Returns undefined when TMDB has no movie with this id. */
  movieDetails(id: number): Promise<MovieDetails | undefined>;
  /** Writes the cache to disk when something changed. */
  save(): Promise<void>;
  stats(): TmdbStats;
}

export interface TmdbStats {
  requests: number;
  cacheHits: number;
}

export interface TmdbClientOptions {
  token: string;
  /** Maximum requests in flight at once. */
  concurrency: number;
  /** The cache file, `state/cache/tmdb-cache.json`. Left out for a client that does not persist. */
  cacheFile?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function createTmdbClient(options: TmdbClientOptions): Promise<TmdbClient> {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const limit = pLimit(options.concurrency);
  const stored = options.cacheFile === undefined ? undefined : await readJsonFile(options.cacheFile, tmdbCacheSchema);
  const cache: TmdbCacheFile = stored ?? { schemaVersion: TMDB_CACHE_SCHEMA_VERSION, searches: {}, movies: {} };
  const stats: TmdbStats = { requests: 0, cacheHits: 0 };
  let dirty = false;

  const fresh = (cachedAt: string, ttl: number): boolean => now().getTime() - new Date(cachedAt).getTime() < ttl;

  /** One GET with retries on rate limits and server errors. Returns the parsed JSON, or undefined for a 404. */
  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [name, value] of Object.entries(params)) {
      url.searchParams.set(name, value);
    }
    for (let attempt = 1; ; attempt += 1) {
      let response: Response;
      try {
        stats.requests += 1;
        response = await doFetch(url, {
          headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json' },
        });
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new AppError('TMDB_FAILED', 'TMDB could not be reached. Check the network and try again.', { cause: error });
        }
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
        continue;
      }
      if (response.status === 404) {
        return undefined;
      }
      if (response.status === 401) {
        throw new AppError('TMDB_FAILED', 'TMDB refused the token. Check TMDB_READ_ACCESS_TOKEN in .env.');
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new AppError('TMDB_FAILED', `TMDB kept answering with status ${response.status}. Try again later.`);
        }
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : RETRY_BASE_MS * 2 ** (attempt - 1);
        await sleep(Math.min(wait, MAX_RETRY_WAIT_MS));
        continue;
      }
      if (!response.ok) {
        throw new AppError('TMDB_FAILED', `TMDB answered with status ${response.status}.`);
      }
      try {
        return await response.json();
      } catch (error) {
        throw new AppError('TMDB_FAILED', 'TMDB returned a response that is not JSON.', { cause: error });
      }
    }
  }

  return {
    searchMovies: ({ query, year, language = 'en-US' }) => {
      const key = JSON.stringify([query.toLowerCase(), year ?? null, language]);
      const hit = cache.searches[key];
      if (hit !== undefined && fresh(hit.cachedAt, SEARCH_TTL_MS)) {
        stats.cacheHits += 1;
        return Promise.resolve(hit.hits);
      }
      return limit(async () => {
        const raw = await get('/search/movie', {
          query,
          language,
          include_adult: 'false',
          page: '1',
          ...(year === null || year === undefined ? {} : { year: String(year) }),
        });
        const parsed = searchResponseSchema.safeParse(raw);
        if (!parsed.success) {
          throw new AppError('TMDB_FAILED', 'TMDB returned a search response in an unexpected shape.', { cause: parsed.error });
        }
        const hits = parsed.data.results.map(toHit);
        cache.searches[key] = { cachedAt: now().toISOString(), hits };
        dirty = true;
        return hits;
      });
    },

    movieDetails: (id) => {
      const key = String(id);
      const hit = cache.movies[key];
      if (hit !== undefined && fresh(hit.cachedAt, DETAILS_TTL_MS)) {
        stats.cacheHits += 1;
        return Promise.resolve(hit.details ?? undefined);
      }
      return limit(async () => {
        const raw = await get(`/movie/${id}`, { language: 'en-US', append_to_response: 'credits' });
        let details: MovieDetails | undefined;
        if (raw !== undefined) {
          const parsed = detailsResponseSchema.safeParse(raw);
          if (!parsed.success) {
            throw new AppError('TMDB_FAILED', 'TMDB returned a movie in an unexpected shape.', { cause: parsed.error });
          }
          details = toDetails(parsed.data);
        }
        cache.movies[key] = { cachedAt: now().toISOString(), details: details ?? null };
        dirty = true;
        return details;
      });
    },

    save: async () => {
      if (options.cacheFile !== undefined && dirty) {
        await writeJsonFile(options.cacheFile, tmdbCacheSchema, cache);
        dirty = false;
      }
    },

    stats: () => ({ ...stats }),
  };
}
