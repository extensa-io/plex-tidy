import { describe, expect, it } from 'vitest';
import { memoryMovieParseCache } from '../../src/llm/movie-parser.ts';
import { parseByPattern, parseMovies, titleFromFolder, validateModelAnswer, yearFromFolders } from '../../src/parse/movies.ts';
import type { Scan } from '../../src/scan/schemas.ts';
import { createStubMovieModel } from '../helpers/movies-harness.ts';

const now = new Date('2026-06-01T00:00:00Z');

describe('parseByPattern', () => {
  it.each([
    ['Sample Film (2010)', { title: 'Sample Film', year: 2010, edition: null, tmdbId: null, via: 'pattern' }],
    ['Sample Film (2010) {edition-Extended}', { title: 'Sample Film', year: 2010, edition: 'Extended', tmdbId: null, via: 'pattern' }],
    ['Sample Film (2010) {tmdb-101}', { title: 'Sample Film', year: 2010, edition: null, tmdbId: 101, via: 'tmdb-id' }],
    [
      'Sample Film (2010) {tmdb-101} {edition-Directors Cut}',
      { title: 'Sample Film', year: 2010, edition: 'Directors Cut', tmdbId: 101, via: 'tmdb-id' },
    ],
    ['Sample Film {tmdb-101}', { title: 'Sample Film', year: null, edition: null, tmdbId: 101, via: 'tmdb-id' }],
    ['Blade Sample 2049 (2017)', { title: 'Blade Sample 2049', year: 2017, edition: null, tmdbId: null, via: 'pattern' }],
  ])('reads %s', (stem, expected) => {
    expect(parseByPattern(stem, now)).toMatchObject({ ...expected, outcome: 'valid' });
  });

  it.each([
    'Sample.Film.2010.1080p.BluRay',
    'Sample Film 2010',
    'Sample Film (2010) 1080p',
    '(2010)',
    'Sample Film (1500)',
    'Sample Film (2099)',
    '{tmdb-101}',
  ])('leaves %s to the model', (stem) => {
    expect(parseByPattern(stem, now)).toBeUndefined();
  });
});

describe('validateModelAnswer', () => {
  const answer = { title: 'Sample Film', year: 2010, edition: null, language: null, part: null };

  it('keeps an answer whose words and year are in the name', () => {
    expect(validateModelAnswer('Sample.Film.2010.1080p', answer, now)).toMatchObject({
      outcome: 'valid',
      title: 'Sample Film',
      year: 2010,
    });
  });

  it('rejects a title with words that are not in the name', () => {
    expect(validateModelAnswer('Sample.Film.2010', { ...answer, title: 'Sample Film Extra' }, now)).toMatchObject({
      outcome: 'invalid',
      title: null,
    });
  });

  it('rejects a title with the words out of order', () => {
    expect(validateModelAnswer('Film Sample', { ...answer, year: null }, now).outcome).toBe('invalid');
  });

  it('drops a year that is not written in the name', () => {
    expect(validateModelAnswer('Sample Film', answer, now).year).toBeNull();
  });

  it('drops a year that is not a film year', () => {
    expect(validateModelAnswer('Sample Film 1200', { ...answer, year: 1200 }, now).year).toBeNull();
  });

  it('drops an edition and a part that are not in the name', () => {
    const result = validateModelAnswer('Sample Film 2010', { ...answer, edition: 'Extended', part: 'Part 2' }, now);
    expect(result).toMatchObject({ outcome: 'valid', edition: null, part: null });
  });

  it('keeps an edition and a part that are in the name', () => {
    const result = validateModelAnswer('Sample Film 2010 Extended Part 2', { ...answer, edition: 'Extended', part: 'Part 2' }, now);
    expect(result).toMatchObject({ edition: 'Extended', part: 'Part 2' });
  });

  it('accepts a two letter language code and drops anything else', () => {
    expect(validateModelAnswer('Sample Film', { ...answer, language: 'ES' }, now).language).toBe('es');
    expect(validateModelAnswer('Sample Film', { ...answer, language: 'Spanish' }, now).language).toBeNull();
  });

  it('treats a null title as no result', () => {
    expect(validateModelAnswer('2010', { ...answer, title: null }, now).outcome).toBe('no-result');
  });
});

describe('a release tag the model left in the title', () => {
  it('is removed, and the title still passes the word check', () => {
    const result = validateModelAnswer('sample.remake.dvd9.720p.bluray.x264', { title: 'sample remake dvd9', year: null, edition: null, language: null, part: null }, now);
    expect(result).toMatchObject({ outcome: 'valid', title: 'Sample Remake' });
  });

  it('keeps the model title when cleaning would leave nothing from the name', () => {
    const result = validateModelAnswer('1080p', { title: '1080p', year: null, edition: null, language: null, part: null }, now);
    expect(result.title).toBe('1080p');
  });
});

describe('yearFromFolders', () => {
  it.each([
    [['21.Sample.Remake.(2006)'], 2006],
    [['Sample Film [2010] 1080p'], 2010],
    [['Sample.Film.2010.1080p'], 2010],
    [['Sample Film'], null],
    // A bare year at the start is more likely part of a title.
    [['2001 A Sample Odyssey'], null],
    // A bracketed year wins over a bare one, and the nearest folder wins.
    [['Sample Film 1999 (2010)'], 2010],
    [['Sample (2005)', 'Collection (1999)'], 2005],
    [['Collection', 'Sample.2007.mkv'], 2007],
    [['Sample (2099)'], null],
  ])('reads %j as %s', (folders, expected) => {
    expect(yearFromFolders(folders, now)).toBe(expected);
  });
});

describe('titleFromFolder', () => {
  it.each([
    ['21.Sample.Remake.(2006)', 'Sample Remake'],
    ['Sample Film (2010)', 'Sample Film'],
    ['03 - Sample Film', 'Sample Film'],
    ['Sample.Film.2010.1080p.BluRay.x264-GRP', 'Sample Film'],
  ])('reads %s as %s', (folder, expected) => {
    expect(titleFromFolder(folder)).toBe(expected);
  });

  it('returns nothing for a folder with no letters or digits', () => {
    expect(titleFromFolder('---')).toBeNull();
  });
});

describe('parseMovies', () => {
  const file = (stem: string) => ({
    id: stem,
    path: `${stem}.mkv`,
    stem,
    ext: '.mkv',
    folders: [],
    sidecars: [],
    titled: true,
    untitledReason: null,
  });
  const scan = (stems: string[]): Scan => ({
    schemaVersion: 1,
    scanId: '00000000-0000-4000-8000-000000000000',
    root: 'C:\\root',
    scannedAt: '2026-01-01T00:00:00.000Z',
    files: stems.map(file),
  });

  it('reads the second run from the cache and sends nothing', async () => {
    const cache = memoryMovieParseCache();
    const model = createStubMovieModel();
    const files = scan(['Sample.Remake.2012.720p']);
    const options = { model, cache, batchSize: 50, now };

    await parseMovies(files, options);
    const second = await parseMovies(files, options);
    expect(model.batches).toHaveLength(1);
    expect(second.stats).toMatchObject({ requested: 1, cached: 1, batches: 0 });
    expect(second.entries[0]?.parse).toMatchObject({ title: 'Sample Remake', year: 2012 });
  });

  it('batches the names that need the model', async () => {
    const model = createStubMovieModel();
    const stems = Array.from({ length: 120 }, (_, index) => `sample.name.${index}.1080p`);
    const result = await parseMovies(scan(stems), { model, cache: memoryMovieParseCache(), batchSize: 50, now });
    expect(model.batches.map((batch) => batch.length).sort((a, b) => a - b)).toEqual([20, 50, 50]);
    expect(result.stats.batches).toBe(3);
  });

  it('marks a refused batch as no answer', async () => {
    const result = await parseMovies(scan(['Sample.Remake.2012.720p']), {
      model: createStubMovieModel('refused'),
      cache: memoryMovieParseCache(),
      batchSize: 50,
      now,
    });
    expect(result.entries[0]?.parse).toMatchObject({ via: 'model', outcome: 'no-answer', title: null });
    expect(result.stats.refusedBatches).toBe(1);
  });
});
