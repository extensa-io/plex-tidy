import { readdir, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExifBackend } from '../../src/tag/exif.ts';
import { createMkvBackend } from '../../src/tag/mkv.ts';
import type { ToolRunner } from '../../src/tag/runner.ts';
import { realRunner } from '../../src/tag/runner.ts';
import { findRealTools, makeSample, realBackendDeps } from '../helpers/real-tools.ts';
import { useTempDirs } from '../helpers/temp-dir.ts';

const tools = await findRealTools();
const makeTempDir = useTempDirs();

const mkv = createMkvBackend(realBackendDeps);
const mkvFields = ['GENRE', 'DIRECTOR', 'ACTOR', 'SYNOPSIS', 'SEASON', 'TMDB', 'ENCODER'];

describe.skipIf(tools === undefined)('Matroska writer, with the real tools', () => {
  async function sample(): Promise<string> {
    const file = join(await makeTempDir(), 'Película.mkv');
    if (tools !== undefined) {
      await makeSample(tools, file);
    }
    return file;
  }

  it('writes a rich record, keeps the other global tag, and restores the previous values', async () => {
    const file = await sample();
    const before = await mkv.read(file, mkvFields);
    expect(before.fields.ENCODER).toHaveLength(1);
    expect(before.fields.GENRE).toEqual([]);

    const target = {
      title: 'Prueba Ñandú',
      fields: {
        GENRE: ['Drama', 'Comedy'],
        DIRECTOR: ['Sample Director'],
        ACTOR: ['Actor One', 'Actor Two'],
        SYNOPSIS: ['Fish & <chips> "quoted" with ñ'],
        SEASON: ['2'],
        TMDB: ['movie/603'],
      },
    };
    await mkv.write(file, target);

    const after = await mkv.read(file, mkvFields);
    expect(after.title).toBe('Prueba Ñandú');
    expect(after.fields).toMatchObject(target.fields);
    expect(after.fields.ENCODER).toEqual(before.fields.ENCODER);

    // Undo: the previous title was none and the previous fields were empty.
    await mkv.write(file, { title: before.title, fields: Object.fromEntries(Object.keys(target.fields).map((name) => [name, []])) });
    const restored = await mkv.read(file, mkvFields);
    expect(restored).toEqual(before);
  });

  it('changes only the fields it is given', async () => {
    const file = await sample();
    await mkv.write(file, { title: 'Sample', fields: { GENRE: ['Drama'], SEASON: ['1'] } });
    await mkv.write(file, { title: 'Sample', fields: { SEASON: ['3'] } });
    const after = await mkv.read(file, ['GENRE', 'SEASON']);
    expect(after.fields).toEqual({ GENRE: ['Drama'], SEASON: ['3'] });
  });

  it('puts the previous values back and reports a read-back mismatch', async () => {
    const file = await sample();
    // A runner that makes mkvpropedit write a different title than the one asked for.
    const tampering: ToolRunner = {
      run: (binary, args, options) =>
        realRunner.run(binary, args.map((arg) => (arg.startsWith('title=') ? 'title=Something Else' : arg)), options),
    };
    const failing = createMkvBackend({ ...realBackendDeps, runner: tampering });

    await expect(failing.write(file, { title: 'Wanted Title', fields: {} })).rejects.toMatchObject({ code: 'TAG_VERIFY_FAILED' });
    expect((await mkv.read(file, [])).title).toBeNull();
  });
});

describe.skipIf(tools === undefined)('ExifTool writer, with the real tools', () => {
  const exif = createExifBackend(realBackendDeps);
  const exifFields = ['ItemList:Genre', 'ItemList:Director', 'ItemList:LongDescription', 'ItemList:TVSeason', 'ItemList:Comment'];

  async function sample(extension = '.mp4'): Promise<{ dir: string; file: string }> {
    const dir = await makeTempDir();
    const file = join(dir, `Película${extension}`);
    if (tools !== undefined) {
      await makeSample(tools, file);
    }
    return { dir, file };
  }

  it.each(['.mp4', '.m4v', '.mov'])('writes a rich record to %s and restores the previous values', async (extension) => {
    const { dir, file } = await sample(extension);
    const before = await exif.read(file, exifFields);
    expect(before.title).toBeNull();

    const fields = {
      'ItemList:Genre': ['Drama, Comedy'],
      'ItemList:Director': ['Sample Director'],
      'ItemList:LongDescription': ['Fish & chips with ñ'],
      'ItemList:TVSeason': ['2'],
      'ItemList:Comment': ['movie/603'],
    };
    await exif.write(file, { title: 'Prueba Ñandú', fields });

    const after = await exif.read(file, exifFields);
    expect(after.title).toBe('Prueba Ñandú');
    expect(after.fields).toEqual(fields);

    await exif.write(file, { title: null, fields: Object.fromEntries(Object.keys(fields).map((name) => [name, []])) });
    expect(await exif.read(file, exifFields)).toEqual(before);
    expect(await readdir(dir)).toEqual([`Película${extension}`]);
  });

  it('never replaces the original before the copy is verified', async () => {
    const { dir, file } = await sample();
    const original = await readFile(file);
    const events: string[] = [];
    const backend = createExifBackend(realBackendDeps, {
      verify: async (copy) => {
        const nextToOriginal = dirname(copy) === dir;
        events.push(nextToOriginal ? 'verify the uploaded copy' : 'verify the copy on this machine');
        // At every check the original is still untouched.
        expect(await readFile(file)).toEqual(original);
        // The upload only exists next to the original after the local copy passed.
        expect((await readdir(dir)).length).toBe(nextToOriginal ? 2 : 1);
        expect(copy).not.toBe(file);
        return Promise.resolve();
      },
      replace: async (copy, target) => {
        events.push('replace');
        await rename(copy, target);
      },
    });

    await backend.write(file, { title: 'Sample Title', fields: {} });
    expect(events).toEqual(['verify the copy on this machine', 'verify the uploaded copy', 'replace']);
    expect((await backend.read(file, [])).title).toBe('Sample Title');
  });

  it('leaves the original untouched, replaces nothing, and removes the copy when verification fails', async () => {
    const { dir, file } = await sample();
    const original = await readFile(file);
    let replaced = false;
    const backend = createExifBackend(realBackendDeps, {
      verify: () => Promise.reject(new Error('forced failure')),
      replace: () => {
        replaced = true;
        return Promise.resolve();
      },
    });

    await expect(backend.write(file, { title: 'Sample Title', fields: {} })).rejects.toThrow('forced failure');
    expect(replaced).toBe(false);
    expect(await readFile(file)).toEqual(original);
    expect(await readdir(dir)).toEqual(['Película.mp4']);
  });

  it('reports the download and the upload, byte for byte, and the tag step between them', async () => {
    const { file } = await sample();
    const size = (await stat(file)).size;
    const seen: [string, number, number][] = [];
    const backend = createExifBackend(realBackendDeps);

    await backend.write(
      file,
      { title: 'Sample Title', fields: {} },
      { onCopyProgress: (copied, total, phase) => void seen.push([phase, copied, total]) },
    );

    expect(seen.map(([phase]) => phase)).toEqual(expect.arrayContaining(['downloading', 'building', 'uploading']));
    expect(seen.find(([phase]) => phase === 'downloading')).toEqual(['downloading', size, size]);
    const order = ['downloading', 'building', 'uploading'].map((name) => seen.findIndex(([phase]) => phase === name));
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    const upload = seen.filter(([phase]) => phase === 'uploading').at(-1);
    expect(upload?.[1]).toBe(upload?.[2]);
  });

  it('never gives ExifTool a path on the share, so a busy network cannot slow it down', async () => {
    const { dir, file } = await sample();
    const shareArgs: string[] = [];
    const spy: ToolRunner = {
      run: async (binary, args, options) => {
        // The write call is the one that changes tags. Its arg file lists every path ExifTool will touch.
        if (args[0] === '-@') {
          const text = await readFile(args[1] ?? '', 'utf8');
          if (text.includes('-overwrite_original')) {
            shareArgs.push(text);
          }
        }
        return realRunner.run(binary, args, options);
      },
    };
    const backend = createExifBackend({ ...realBackendDeps, runner: spy });

    await backend.write(file, { title: 'Sample Title', fields: {} });

    expect(shareArgs).toHaveLength(1);
    expect(shareArgs[0]).not.toContain(dir);
    expect(shareArgs[0]).toContain('plex-tidy-copy-');
  });

  it('refuses before writing anything when only this machine lacks space', async () => {
    const { dir, file } = await sample();
    const original = await readFile(file);
    const work = await makeTempDir();
    // Plenty of room next to the video, none in the temporary folder.
    const backend = createExifBackend(realBackendDeps, {
      tempDir: work,
      freeBytes: (directory) => Promise.resolve(directory === dir ? Number.MAX_SAFE_INTEGER : 0),
    });

    await expect(backend.write(file, { title: 'Sample Title', fields: {} })).rejects.toMatchObject({ code: 'TAG_NO_SPACE' });
    expect(await readFile(file)).toEqual(original);
    expect(await readdir(dir)).toEqual(['Película.mp4']);
    expect(await readdir(work)).toEqual([]);
  });

  it('refuses before writing anything when the volume lacks space', async () => {
    const { dir, file } = await sample();
    const original = await readFile(file);
    const backend = createExifBackend(realBackendDeps, { freeBytes: () => Promise.resolve(0) });

    await expect(backend.write(file, { title: 'Sample Title', fields: {} })).rejects.toMatchObject({ code: 'TAG_NO_SPACE' });
    expect(await readFile(file)).toEqual(original);
    expect(await readdir(dir)).toEqual(['Película.mp4']);
  });
});
