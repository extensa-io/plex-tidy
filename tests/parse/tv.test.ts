import { describe, expect, it } from 'vitest';
import { memoryMovieParseCache } from '../../src/llm/movie-parser.ts';
import {
  parseEpisodeName,
  parseTv,
  seasonOfFolder,
  showFolderHints,
  splitEpisodeFolders,
  validateTvAnswer,
} from '../../src/parse/tv.ts';
import { settleSeason } from '../../src/resolve/tv.ts';
import type { Scan } from '../../src/scan/schemas.ts';
import { createStubTvModel } from '../helpers/tv-harness.ts';

const now = new Date('2026-06-01T00:00:00Z');

describe('parseEpisodeName', () => {
  it.each([
    ['show.name.s01e10.720p.bluray.x264-GRP', { rule: 's01e02', season: 1, episode: 10, episodeEnd: null, show: 'Show Name', episodeTitle: null }],
    ['Show Name S02E05 The Title', { rule: 's01e02', season: 2, episode: 5, episodeEnd: null, show: 'Show Name', episodeTitle: 'The Title' }],
    ['Show Name - s03e07 - Another Title', { rule: 's01e02', season: 3, episode: 7, episodeEnd: null, show: 'Show Name', episodeTitle: 'Another Title' }],
    ['Show Name - 2x06 - Guest Name', { rule: '2x06', season: 2, episode: 6, episodeEnd: null, show: 'Show Name', episodeTitle: 'Guest Name' }],
    ['Show Name Season 4 Episode 12', { rule: 'season-2-episode-6', season: 4, episode: 12, episodeEnd: null, show: 'Show Name', episodeTitle: null }],
  ])('reads %s', (stem, expected) => {
    expect(parseEpisodeName(stem, now)).toMatchObject({ via: 'rules', outcome: 'valid', ...expected });
  });

  it.each([
    ['Show s01e01e02', 1, 2],
    ['Show S01E01-E02 Title', 1, 2],
    ['Show s01e01-02', 1, 2],
    ['Show 1x03-04', 3, 4],
    ['Show s02e05e06e07', 5, 7],
  ])('reads %s as several episodes', (stem, episode, episodeEnd) => {
    expect(parseEpisodeName(stem, now)).toMatchObject({ episode, episodeEnd });
  });

  it('does not take a resolution or a size for another episode', () => {
    expect(parseEpisodeName('Show s01e10.720p', now)).toMatchObject({ episode: 10, episodeEnd: null });
    expect(parseEpisodeName('Show s01e10-1080p', now)).toMatchObject({ episode: 10, episodeEnd: null });
    expect(parseEpisodeName('Show 1920x1080 sample', now)).toBeUndefined();
  });

  it.each([
    ['11.-.The.Great.Change.1886-1915', '11-dash-title', 11, 'The Great Change 1886-1915'],
    ['11 - The Great Change', '11-dash-title', 11, 'The Great Change'],
    ['Broadcaster Series - 11 - The Worship of Nature', 'show-dash-11-dash-title', 11, 'The Worship of Nature'],
    ['Show Name episode 5 Title', 'episode-11', 5, 'Title'],
  ])('reads the episode-only name %s with no season', (stem, rule, episode, title) => {
    const parsed = parseEpisodeName(stem, now);
    expect(parsed).toMatchObject({ rule, season: null, episode });
    expect(parsed?.episodeTitle).toBe(title);
  });

  it('takes the show from the text before the numbers, without release tags', () => {
    expect(parseEpisodeName('aaf-wwii.in.hd.s01e10.720p.bluray', now)?.show).toBe('Aaf-Wwii in Hd');
    expect(parseEpisodeName('Broadcaster Series - 11 - The Worship of Nature', now)?.show).toBe('Broadcaster Series');
  });

  it('reads a year in the show name', () => {
    expect(parseEpisodeName('Show Name 2010 s01e01', now)).toMatchObject({ year: 2010 });
  });

  it.each(['Just A Title', 'Show Name part two', '1080p', '2012'])('leaves %s to the model', (stem) => {
    expect(parseEpisodeName(stem, now)).toBeUndefined();
  });
});

describe('Season folders', () => {
  it.each([
    ['Season 2', 2],
    ['Season 02', 2],
    ['season_3', 3],
    ['Series 4', 4],
    ['S05', 5],
    ['Specials', 0],
    ['Saison 6', 6],
  ])('reads %s as season %i', (name, season) => {
    expect(seasonOfFolder(name)).toBe(season);
  });

  it.each(['Season', 'Seasons 1-3', 'The Season Finale', 'Sample Show'])('does not read %s as a season', (name) => {
    expect(seasonOfFolder(name)).toBeUndefined();
  });

  it('splits the folders of a file into the show folder and the season', () => {
    expect(splitEpisodeFolders(['Season 2', 'Sample Show'])).toEqual({ showDir: 'Sample Show', showFolder: 'Sample Show', folderSeason: 2 });
    expect(splitEpisodeFolders(['Sample Show'])).toEqual({ showDir: 'Sample Show', showFolder: 'Sample Show', folderSeason: null });
    expect(splitEpisodeFolders(['Season 1', 'Sample Show', 'Category'])).toEqual({
      showDir: 'Category\\Sample Show',
      showFolder: 'Sample Show',
      folderSeason: 1,
    });
    expect(splitEpisodeFolders([])).toEqual({ showDir: '', showFolder: null, folderSeason: null });
    expect(splitEpisodeFolders(['Season 1'])).toEqual({ showDir: '', showFolder: null, folderSeason: 1 });
  });
});

describe('settleSeason', () => {
  it('uses the season in the name and reports no conflict when the folder agrees', () => {
    expect(settleSeason({ season: 2, episode: 1 }, 2)).toEqual({ season: 2, seasonSource: 'name', conflict: false });
  });

  it('flags a conflict when the name and the Season folder disagree', () => {
    expect(settleSeason({ season: 1, episode: 2 }, 3)).toEqual({ season: 1, seasonSource: 'name', conflict: true });
  });

  it('takes the season from the folder when the name has none', () => {
    expect(settleSeason({ season: null, episode: 6 }, 2)).toEqual({ season: 2, seasonSource: 'folder', conflict: false });
  });

  it('treats an episode with no season anywhere as season 1, and says so', () => {
    expect(settleSeason({ season: null, episode: 11 }, null)).toEqual({ season: 1, seasonSource: 'assumed', conflict: false });
  });

  it('has no season for a file with no episode number', () => {
    expect(settleSeason({ season: null, episode: null }, null).season).toBeNull();
  });
});

describe('showFolderHints', () => {
  it.each([
    ['Sample Show', { title: 'Sample Show', year: null, tmdbId: null }],
    ['Sample Show (2010)', { title: 'Sample Show', year: 2010, tmdbId: null }],
    ['Sample Show (2010) {tmdb-123}', { title: 'Sample Show', year: 2010, tmdbId: 123 }],
    ['Sample.Show.2010.1080p.BluRay', { title: 'Sample Show', year: null, tmdbId: null }],
    ['Sample Show [2012]', { title: 'Sample Show', year: 2012, tmdbId: null }],
  ])('reads %s', (name, expected) => {
    expect(showFolderHints(name, now)).toEqual(expected);
  });
});

describe('validateTvAnswer', () => {
  const answer = { title: null, show: 'Sample Show', year: null, season: 1, episode: 5, episodeEnd: null, episodeTitle: 'The Title' };

  it('keeps an answer whose words and numbers are in the name', () => {
    expect(validateTvAnswer('Sample Show season 1 part 5 The Title', answer, now)).toMatchObject({
      outcome: 'valid',
      show: 'Sample Show',
      season: 1,
      episode: 5,
      episodeTitle: 'The Title',
    });
  });

  it('drops a number that is not written in the name, and never guesses a season', () => {
    const result = validateTvAnswer('Sample Show part 5', answer, now);
    expect(result).toMatchObject({ season: null, episode: 5 });
  });

  it('has no episode when the episode number is not in the name', () => {
    expect(validateTvAnswer('Sample Show', answer, now)).toMatchObject({ outcome: 'no-result', episode: null });
  });

  it('drops a show or a title with words that are not in the name', () => {
    const result = validateTvAnswer('Sample part 5', { ...answer, show: 'Sample Show Extra' }, now);
    expect(result.show).toBeNull();
  });

  it('drops an end episode that is not after the first', () => {
    expect(validateTvAnswer('Sample part 5 6', { ...answer, episodeEnd: 5 }, now).episodeEnd).toBeNull();
    expect(validateTvAnswer('Sample part 5 6', { ...answer, episodeEnd: 6 }, now).episodeEnd).toBe(6);
  });
});

describe('parseTv', () => {
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
    const model = createStubTvModel();
    const files = scan(['Model Show part 2']);
    const options = { model, cache, batchSize: 50, now };

    await parseTv(files, options);
    const second = await parseTv(files, options);
    expect(model.batches).toHaveLength(1);
    expect(second.stats).toMatchObject({ requested: 1, cached: 1, batches: 0 });
    expect(second.parses.get('Model Show part 2')).toMatchObject({ show: 'Model Show', episode: 2 });
  });

  it('keeps the rules for names with numbers and sends only the rest', async () => {
    const model = createStubTvModel();
    const result = await parseTv(scan(['Show s01e02', 'Show 2x03', 'Model Show part 2']), {
      model,
      cache: memoryMovieParseCache(),
      batchSize: 50,
      now,
    });
    expect(model.batches.flat().map((item) => item.name)).toEqual(['Model Show part 2']);
    expect(result.byRules).toBe(2);
  });

  it('marks a refused batch as no answer', async () => {
    const result = await parseTv(scan(['Model Show part 2']), {
      model: createStubTvModel('refused'),
      cache: memoryMovieParseCache(),
      batchSize: 50,
      now,
    });
    expect(result.parses.get('Model Show part 2')).toMatchObject({ via: 'model', outcome: 'no-answer', episode: null });
    expect(result.stats.refusedBatches).toBe(1);
  });
});
