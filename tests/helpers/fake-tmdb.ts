import type { TmdbClient } from '../../src/tmdb/client.ts';
import { titleSimilarity } from '../../src/resolve/scorer.ts';
import type { EpisodeInfo, MovieDetails, MovieHit, ShowDetails, ShowHit } from '../../src/tmdb/schemas.ts';

export interface FakeTmdb extends TmdbClient {
  /** Every search made, as `language:query:year`. */
  searches: string[];
  /** Every id whose details were asked for. */
  detailRequests: number[];
  /** Every show search made, as `query:year`. */
  showSearchRequests: string[];
  /** Every season listing asked for, as `show/season`. */
  seasonRequests: string[];
}

export interface FakeTv {
  shows: readonly ShowDetails[];
  episodes: (showId: number, season: number) => EpisodeInfo[] | undefined;
}

/**
 * A TMDB with a fixed catalog. An English search matches the English and
 * original titles. A Spanish search also matches the Spanish title and
 * returns it as the hit title.
 */
export function createFakeTmdb(
  catalog: readonly MovieDetails[],
  spanish: Readonly<Record<number, string>> = {},
  tv: FakeTv = { shows: [], episodes: () => undefined },
): FakeTmdb {
  const searches: string[] = [];
  const detailRequests: number[] = [];
  const showSearchRequests: string[] = [];
  const seasonRequests: string[] = [];
  return {
    searches,
    detailRequests,
    showSearchRequests,
    seasonRequests,
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
    searchShows: ({ query, year }) => {
      showSearchRequests.push(`${query}:${year ?? ''}`);
      const hits: ShowHit[] = tv.shows
        .filter((show) => titleSimilarity(query, show.name) >= 0.7 && (year === null || year === undefined || show.year === year))
        .map((show) => ({ id: show.id, name: show.name, originalName: show.originalName, year: show.year, popularity: 1 }));
      return Promise.resolve(hits);
    },
    showDetails: (id) => Promise.resolve(tv.shows.find((show) => show.id === id)),
    seasonEpisodes: (showId, season) => {
      seasonRequests.push(`${showId}/${season}`);
      return Promise.resolve(tv.episodes(showId, season));
    },
    save: () => Promise.resolve(),
    stats: () => ({ requests: searches.length + detailRequests.length + showSearchRequests.length + seasonRequests.length, cacheHits: 0 }),
  };
}
