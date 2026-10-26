import { describe, expect, it } from 'vitest';
import { movesFor } from '../../src/apply/apply.ts';
import { applyChosenMovie, movieFileInfos, movieNames, movieTagRecord } from '../../src/plan/movies.ts';
import type { Plan, PlanEntry } from '../../src/plan/schemas.ts';
import type { Scan, ScanFile } from '../../src/scan/schemas.ts';
import { tagRecordSchema } from '../../src/tag/schemas.ts';
import { catalog } from '../fixtures/movies-corpus.ts';

const root = 'D:\\Library';

function file(path: string, sidecars: string[] = []): ScanFile {
  const parts = path.split('\\');
  const name = parts.at(-1) ?? path;
  const dot = name.lastIndexOf('.');
  return {
    id: path.toLowerCase(),
    path,
    stem: name.slice(0, dot),
    ext: name.slice(dot),
    folders: parts.slice(0, -1).reverse(),
    sidecars: sidecars.map((sidecarPath) => ({ path: sidecarPath, suffix: sidecarPath.slice(sidecarPath.lastIndexOf('\\') + 1 + name.slice(0, dot).length) })),
    titled: true,
    untitledReason: null,
  };
}

const scanOf = (...files: ScanFile[]): Scan => ({
  schemaVersion: 1,
  scanId: '00000000-0000-4000-8000-000000000000',
  root,
  scannedAt: '2026-01-01T00:00:00.000Z',
  files,
});

const alpha = catalog[0];
if (alpha === undefined) {
  throw new Error('the corpus has no first movie');
}

describe('movieNames', () => {
  it('writes Title (Year) {tmdb-id} for the folder and the file', () => {
    expect(movieNames(alpha, null)).toEqual({
      folder: 'Sample Film Alpha (2010) {tmdb-101}',
      file: 'Sample Film Alpha (2010) {tmdb-101}',
    });
  });

  it('adds the edition to the file name only', () => {
    expect(movieNames(alpha, 'Extended Cut')).toEqual({
      folder: 'Sample Film Alpha (2010) {tmdb-101}',
      file: 'Sample Film Alpha (2010) {tmdb-101} {edition-Extended Cut}',
    });
  });

  it('uses the original title, not the English one', () => {
    const names = movieNames({ id: 5, title: 'English Name', originalTitle: 'Nombre Original', year: 2001 }, null);
    expect(names?.folder).toBe('Nombre Original (2001) {tmdb-5}');
  });

  it('leaves out the year when TMDB has none', () => {
    expect(movieNames({ id: 5, title: 'Undated', originalTitle: 'Undated', year: null }, null)?.folder).toBe('Undated {tmdb-5}');
  });

  it('makes the title and the edition legal on Windows', () => {
    const names = movieNames({ id: 6, title: 'x', originalTitle: 'What: A "Title"? <Yes>/No|Maybe*', year: 2000 }, 'Cut: {Final}');
    expect(names).toEqual({
      folder: 'What - A Title Yes-No-Maybe (2000) {tmdb-6}',
      file: 'What - A Title Yes-No-Maybe (2000) {tmdb-6} {edition-Cut - Final}',
    });
  });

  it('avoids a reserved device name and a trailing dot', () => {
    expect(movieNames({ id: 7, title: 'Mr.', originalTitle: 'Mr.', year: null }, null)?.folder).toBe('Mr {tmdb-7}');
  });

  it('falls back to the English title, and gives up when no legal title is left', () => {
    expect(movieNames({ id: 8, title: 'Fallback', originalTitle: '???', year: 2000 }, null)?.folder).toBe('Fallback (2000) {tmdb-8}');
    expect(movieNames({ id: 9, title: '???', originalTitle: '***', year: 2000 }, null)).toBeUndefined();
  });
});

describe('movieTagRecord', () => {
  it('fills every field TMDB has, and passes the record schema', () => {
    const record = movieTagRecord(alpha);
    expect(tagRecordSchema.safeParse(record).success).toBe(true);
    expect(record).toEqual({
      title: 'Sample Film Alpha',
      originalTitle: 'Sample Film Alpha',
      dateReleased: '2010-05-01',
      synopsis: 'A synthetic plot for Sample Film Alpha.',
      genre: ['Drama'],
      director: ['Sample Director'],
      actor: ['Actor One', 'Actor Two'],
      tmdb: 'movie/101',
    });
  });

  it('leaves out what TMDB does not have', () => {
    const record = movieTagRecord({ ...alpha, releaseDate: null, overview: '', genres: [], directors: [], cast: [] });
    expect(record).toEqual({ title: 'Sample Film Alpha', originalTitle: 'Sample Film Alpha', tmdb: 'movie/101' });
  });
});

describe('movieFileInfos', () => {
  it('renames a folder that holds one video', () => {
    const infos = movieFileInfos(scanOf(file('Old Folder\\a.mkv')));
    expect(infos.get('old folder\\a.mkv')?.renameFolder).toBe(true);
  });

  it('keeps a folder with two videos', () => {
    const infos = movieFileInfos(scanOf(file('Shared\\a.mkv'), file('Shared\\b.mkv')));
    expect([...infos.values()].map((info) => info.renameFolder)).toEqual([false, false]);
  });

  it('keeps a folder that has a video in a subfolder', () => {
    const infos = movieFileInfos(scanOf(file('Movie\\a.mkv'), file('Movie\\Extras\\b.mkv')));
    expect(infos.get('movie\\a.mkv')?.renameFolder).toBe(false);
    expect(infos.get('movie\\extras\\b.mkv')?.renameFolder).toBe(true);
  });

  it('never renames the root', () => {
    expect(movieFileInfos(scanOf(file('a.mkv'))).get('a.mkv')?.renameFolder).toBe(false);
  });

  it('does not mistake a folder with a similar name for a parent', () => {
    const infos = movieFileInfos(scanOf(file('Movie\\a.mkv'), file('Movie 2\\b.mkv')));
    expect([...infos.values()].map((info) => info.renameFolder)).toEqual([true, true]);
  });
});

describe('applyChosenMovie', () => {
  const info = movieFileInfos(scanOf(file('Old\\a.mkv', ['Old\\a.en.srt']))).get('old\\a.mkv');
  const entry: PlanEntry = {
    id: 'old\\a.mkv',
    source: 'Old\\a.mkv',
    target: 'Old\\a.mkv',
    sidecars: [{ source: 'Old\\a.en.srt', target: 'Old\\a.en.srt' }],
    folder: null,
    tagRecord: null,
    title: null,
    titleSource: 'none',
    confidence: 'low',
    reason: 'no match was chosen',
    status: 'pending',
    tagStatus: 'untagged',
    tagReason: null,
    collision: false,
  };
  const planWith = (...others: PlanEntry[]): Plan => ({
    schemaVersion: 1,
    scanId: '00000000-0000-4000-8000-000000000000',
    root,
    builtAt: '2026-01-01T00:00:00.000Z',
    entries: [entry, ...others],
  });
  const never = () => Promise.resolve(false);

  it('approves the chosen movie with its folder, file, sidecar, and tag record', async () => {
    if (info === undefined) {
      throw new Error('no file info');
    }
    const result = await applyChosenMovie(planWith(), entry, info, alpha, 'Extended', never);
    expect(result).toMatchObject({
      ok: true,
      entry: {
        status: 'approved',
        titleSource: 'manual',
        title: 'Sample Film Alpha',
        target: 'Sample Film Alpha (2010) {tmdb-101}\\Sample Film Alpha (2010) {tmdb-101} {edition-Extended}.mkv',
        folder: { source: 'Old', target: 'Sample Film Alpha (2010) {tmdb-101}' },
      },
    });
    if (!result.ok) {
      return;
    }
    expect(movesFor(result.entry).map((move) => `${move.from} -> ${move.to}`)).toEqual([
      'Old\\a.mkv -> Old\\Sample Film Alpha (2010) {tmdb-101} {edition-Extended}.mkv',
      'Old\\a.en.srt -> Old\\Sample Film Alpha (2010) {tmdb-101} {edition-Extended}.en.srt',
      'Old -> Sample Film Alpha (2010) {tmdb-101}',
    ]);
  });

  it('refuses a name that already exists on disk', async () => {
    if (info === undefined) {
      throw new Error('no file info');
    }
    const result = await applyChosenMovie(planWith(), entry, info, alpha, null, () => Promise.resolve(true));
    expect(result).toMatchObject({ ok: false });
  });

  it('refuses a name that another entry in the plan already uses', async () => {
    if (info === undefined) {
      throw new Error('no file info');
    }
    const other: PlanEntry = {
      ...entry,
      id: 'other',
      source: 'Other\\b.mkv',
      target: 'Sample Film Alpha (2010) {tmdb-101}\\Sample Film Alpha (2010) {tmdb-101}.mkv',
      sidecars: [],
      folder: { source: 'Other', target: 'Sample Film Alpha (2010) {tmdb-101}' },
      status: 'approved',
    };
    const result = await applyChosenMovie(planWith(other), entry, info, alpha, null, never);
    expect(result).toEqual({ ok: false, message: 'Another entry in the plan already uses that name.' });
  });

  it('refuses a path over the length limit', async () => {
    if (info === undefined) {
      throw new Error('no file info');
    }
    const long = { ...alpha, originalTitle: 'x'.repeat(200) };
    const result = await applyChosenMovie(planWith(), entry, info, long, null, never);
    expect(result.ok).toBe(false);
  });
});
