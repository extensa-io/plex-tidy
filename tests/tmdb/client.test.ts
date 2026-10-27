import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTmdbClient } from '../../src/tmdb/client.ts';
import { useTempDirs } from '../helpers/temp-dir.ts';

const makeTempDir = useTempDirs();

interface Call {
  url: URL;
  headers: Record<string, string>;
}

function stubFetch(respond: (url: URL, attempt: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const attempts = new Map<string, number>();
  const impl = (input: URL | string | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const attempt = (attempts.get(url.href) ?? 0) + 1;
    attempts.set(url.href, attempt);
    return Promise.resolve(respond(url, attempt));
  };
  return { calls, fetch: impl };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const details = {
  id: 7,
  title: 'Sample Film',
  original_title: 'Sample Original',
  release_date: '2010-05-01',
  runtime: 101,
  overview: ' A plot. ',
  genres: [{ id: 1, name: 'Drama' }],
  credits: {
    cast: [
      { name: 'Second Actor', order: 1 },
      { name: 'First Actor', order: 0 },
    ],
    crew: [
      { name: 'Sample Director', job: 'Director' },
      { name: 'Sample Editor', job: 'Editor' },
    ],
  },
};

const noSleep = () => Promise.resolve();

describe('TMDB client', () => {
  it('sends the bearer token and the search parameters', async () => {
    const { calls, fetch } = stubFetch(() => json({ results: [{ id: 7, title: 'Sample Film', original_title: 'Sample Film', release_date: '2010-05-01', popularity: 3 }] }));
    const client = await createTmdbClient({ token: 'header.payload.signature', concurrency: 2, fetch });

    const hits = await client.searchMovies({ query: 'Sample Film', year: 2010, language: 'es-ES' });

    expect(hits).toEqual([{ id: 7, title: 'Sample Film', originalTitle: 'Sample Film', year: 2010, popularity: 3 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.authorization).toBe('Bearer header.payload.signature');
    expect(calls[0]?.url.pathname).toBe('/3/search/movie');
    expect(Object.fromEntries(calls[0]?.url.searchParams.entries() ?? [])).toMatchObject({
      query: 'Sample Film',
      year: '2010',
      language: 'es-ES',
      include_adult: 'false',
    });
  });

  it('keeps a hit that has no release date', async () => {
    const { fetch } = stubFetch(() => json({ results: [{ id: 9, title: 'Undated', original_title: 'Undated', release_date: '' }] }));
    const client = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch });
    expect((await client.searchMovies({ query: 'Undated' }))[0]).toMatchObject({ id: 9, year: null });
  });

  it('reduces the details to what the tool keeps', async () => {
    const { calls, fetch } = stubFetch(() => json(details));
    const client = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch });

    expect(await client.movieDetails(7)).toEqual({
      id: 7,
      title: 'Sample Film',
      originalTitle: 'Sample Original',
      releaseDate: '2010-05-01',
      year: 2010,
      runtimeMinutes: 101,
      overview: 'A plot.',
      genres: ['Drama'],
      directors: ['Sample Director'],
      cast: ['First Actor', 'Second Actor'],
      altTitles: [],
    });
    expect(calls[0]?.url.searchParams.get('append_to_response')).toBe('credits');
  });

  it('returns undefined for a movie TMDB does not have, and remembers it', async () => {
    const { calls, fetch } = stubFetch(() => json({ status_code: 34 }, 404));
    const client = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch });
    expect(await client.movieDetails(1)).toBeUndefined();
    expect(await client.movieDetails(1)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('retries after a rate limit and waits as long as TMDB asks', async () => {
    const waits: number[] = [];
    const { calls, fetch } = stubFetch((_url, attempt) => (attempt === 1 ? json({}, 429, { 'retry-after': '2' }) : json(details)));
    const client = await createTmdbClient({
      token: 'a.b.c',
      concurrency: 1,
      fetch,
      sleep: (milliseconds) => {
        waits.push(milliseconds);
        return Promise.resolve();
      },
    });
    expect((await client.movieDetails(7))?.id).toBe(7);
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });

  it('gives up after repeated server errors with a message that names no secret', async () => {
    const { fetch } = stubFetch(() => json({}, 503));
    const client = await createTmdbClient({ token: 'secret.token.value', concurrency: 1, fetch, sleep: noSleep });
    await expect(client.movieDetails(7)).rejects.toMatchObject({ code: 'TMDB_FAILED', message: expect.not.stringContaining('secret') as unknown });
  });

  it('reports a refused token', async () => {
    const { fetch } = stubFetch(() => json({}, 401));
    const client = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch, sleep: noSleep });
    await expect(client.searchMovies({ query: 'x' })).rejects.toMatchObject({ code: 'TMDB_FAILED' });
  });

  it('rejects a response in an unexpected shape', async () => {
    const { fetch } = stubFetch(() => json({ results: 'nope' }));
    const client = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch });
    await expect(client.searchMovies({ query: 'x' })).rejects.toMatchObject({ code: 'TMDB_FAILED' });
  });

  it('never has more requests in flight than the concurrency allows', async () => {
    let active = 0;
    let peak = 0;
    const { fetch } = stubFetch(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return json(details);
    });
    const client = await createTmdbClient({ token: 'a.b.c', concurrency: 2, fetch });
    await Promise.all([1, 2, 3, 4, 5, 6].map((id) => client.movieDetails(id)));
    expect(peak).toBe(2);
  });

  it('keeps answers in the cache file, and a new client reads them without a request', async () => {
    const cacheFile = join(await makeTempDir(), 'tmdb-cache.json');
    const first = stubFetch(() => json(details));
    const client = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch: first.fetch, cacheFile });
    await client.movieDetails(7);
    await client.save();

    const second = stubFetch(() => json({}, 500));
    const again = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch: second.fetch, cacheFile });
    expect((await again.movieDetails(7))?.title).toBe('Sample Film');
    expect(second.calls).toHaveLength(0);
    expect(again.stats()).toEqual({ requests: 0, cacheHits: 1 });
  });

  describe('TV', () => {
    const show = {
      id: 5,
      name: 'Sample Show',
      original_name: 'Sample Original',
      first_air_date: '2005-03-02',
      overview: ' A plot. ',
      genres: [{ id: 1, name: 'Drama' }],
      number_of_episodes: 20,
      seasons: [
        { season_number: 0, episode_count: 2 },
        { season_number: 1, episode_count: 10 },
        { season_number: 2, episode_count: 8 },
      ],
    };

    it('searches shows with the first air year', async () => {
      const { calls, fetch } = stubFetch(() =>
        json({ results: [{ id: 5, name: 'Sample Show', original_name: 'Sample Show', first_air_date: '2005-03-02', popularity: 4 }] }),
      );
      const client = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch });

      expect(await client.searchShows({ query: 'Sample Show', year: 2005 })).toEqual([
        { id: 5, name: 'Sample Show', originalName: 'Sample Show', year: 2005, popularity: 4 },
      ]);
      expect(calls[0]?.url.pathname).toBe('/3/search/tv');
      expect(Object.fromEntries(calls[0]?.url.searchParams.entries() ?? [])).toMatchObject({
        query: 'Sample Show',
        first_air_date_year: '2005',
        include_adult: 'false',
      });
    });

    it('reduces the show details to what the tool keeps', async () => {
      const { fetch } = stubFetch(() => json(show));
      const client = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch });
      expect(await client.showDetails(5)).toEqual({
        id: 5,
        name: 'Sample Show',
        originalName: 'Sample Original',
        firstAirDate: '2005-03-02',
        year: 2005,
        overview: 'A plot.',
        genres: ['Drama'],
        seasons: [
          { season: 0, episodes: 2 },
          { season: 1, episodes: 10 },
          { season: 2, episodes: 8 },
        ],
        episodeCount: 20,
        altNames: [],
      });
    });

    it('lists the episodes of a season in aired order', async () => {
      const { calls, fetch } = stubFetch(() =>
        json({
          episodes: [
            { episode_number: 2, name: 'Second', air_date: '2005-03-09', overview: 'Two.' },
            { episode_number: 1, name: ' First ', air_date: '', overview: null },
          ],
        }),
      );
      const client = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch });
      expect(await client.seasonEpisodes(5, 1)).toEqual([
        { number: 1, name: 'First', airDate: null, overview: '' },
        { number: 2, name: 'Second', airDate: '2005-03-09', overview: 'Two.' },
      ]);
      expect(calls[0]?.url.pathname).toBe('/3/tv/5/season/1');
    });

    it('returns undefined for a show or a season TMDB does not have, and remembers it', async () => {
      const { calls, fetch } = stubFetch(() => json({ status_code: 34 }, 404));
      const client = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch });
      expect(await client.showDetails(1)).toBeUndefined();
      expect(await client.seasonEpisodes(1, 9)).toBeUndefined();
      expect(await client.seasonEpisodes(1, 9)).toBeUndefined();
      expect(calls).toHaveLength(2);
    });

    it('keeps TV answers in the cache file, and still reads a cache written before TV support', async () => {
      const cacheFile = join(await makeTempDir(), 'tmdb-cache.json');
      const first = stubFetch(() => json(show));
      const client = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch: first.fetch, cacheFile });
      await client.showDetails(5);
      await client.save();

      const second = stubFetch(() => json({}, 500));
      const again = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch: second.fetch, cacheFile });
      expect((await again.showDetails(5))?.name).toBe('Sample Show');
      expect(second.calls).toHaveLength(0);

      const oldFile = join(await makeTempDir(), 'old-cache.json');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(oldFile, JSON.stringify({ schemaVersion: 1, searches: {}, movies: {} }));
      const old = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch: first.fetch, cacheFile: oldFile });
      expect((await old.showDetails(5))?.id).toBe(5);
    });
  });

  it('asks again when a cached answer is too old', async () => {
    const cacheFile = join(await makeTempDir(), 'tmdb-cache.json');
    const first = stubFetch(() => json(details));
    const client = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch: first.fetch, cacheFile, now: () => new Date('2026-01-01T00:00:00Z') });
    await client.movieDetails(7);
    await client.save();

    const second = stubFetch(() => json(details));
    const later = await createTmdbClient({ token: 'a.b.c', concurrency: 1, fetch: second.fetch, cacheFile, now: () => new Date('2026-03-01T00:00:00Z') });
    await later.movieDetails(7);
    expect(second.calls).toHaveLength(1);
  });
});
