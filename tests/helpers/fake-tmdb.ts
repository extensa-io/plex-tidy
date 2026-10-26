import type { TmdbClient } from '../../src/tmdb/client.ts';
import { titleSimilarity } from '../../src/resolve/scorer.ts';
import type { MovieDetails, MovieHit } from '../../src/tmdb/schemas.ts';

export interface FakeTmdb extends TmdbClient {
  /** Every search made, as `language:query:year`. */
  searches: string[];
  /** Every id whose details were asked for. */
  detailRequests: number[];
}

/**
 * A TMDB with a fixed catalog. An English search matches the English and
 * original titles. A Spanish search also matches the Spanish title and
 * returns it as the hit title.
 */
export function createFakeTmdb(catalog: readonly MovieDetails[], spanish: Readonly<Record<number, string>> = {}): FakeTmdb {
  const searches: string[] = [];
  const detailRequests: number[] = [];
  return {
    searches,
    detailRequests,
    searchMovies: ({ query, year, language = 'en-US' }) => {
      searches.push(`${language}:${query}:${year ?? ''}`);
      const hits: MovieHit[] = [];
      for (const movie of catalog) {
        const localized = language.startsWith('es') ? spanish[movie.id] : undefined;
        const titles = [movie.title, movie.originalTitle, ...(localized === undefined ? [] : [localized])];
        const matches = titles.some((title) => titleSimilarity(query, title) >= 0.7);
        if (matches && (year === null || year === undefined || movie.year === year)) {
          hits.push({
            id: movie.id,
            title: localized ?? movie.title,
            originalTitle: movie.originalTitle,
            year: movie.year,
            popularity: 1,
          });
        }
      }
      return Promise.resolve(hits);
    },
    movieDetails: (id) => {
      detailRequests.push(id);
      return Promise.resolve(catalog.find((movie) => movie.id === id));
    },
    save: () => Promise.resolve(),
    stats: () => ({ requests: searches.length + detailRequests.length, cacheHits: 0 }),
  };
}
