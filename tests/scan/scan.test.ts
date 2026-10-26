import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileId, scanRoot, summarizeScan } from '../../src/scan/scan.ts';
import { scanSchema } from '../../src/scan/schemas.ts';
import { libraryTree, libraryTreeCounts } from '../fixtures/local-corpus.ts';
import { useTempDirs } from '../helpers/temp-dir.ts';
import { createTree } from '../helpers/tree.ts';

const makeTempDir = useTempDirs();

describe('scanRoot', () => {
  it('reports the file, sidecar, and untitled counts of the fixture tree', async () => {
    const root = await makeTempDir();
    await createTree(root, libraryTree);
    const scan = await scanRoot(root);
    expect(summarizeScan(scan)).toEqual(libraryTreeCounts);
    expect(scanSchema.safeParse(scan).success).toBe(true);
  });

  it('ignores files that are neither videos nor subtitles', async () => {
    const root = await makeTempDir();
    await createTree(root, libraryTree);
    const scan = await scanRoot(root);
    expect(scan.files.some((file) => file.path.startsWith('Notes'))).toBe(false);
  });

  it('records folders nearest first and paths relative to the root', async () => {
    const root = await makeTempDir();
    await createTree(root, ['Outer\\Inner\\Sample Film.mkv', 'Top Level.mkv']);
    const scan = await scanRoot(root);
    const nested = scan.files.find((file) => file.stem === 'Sample Film');
    expect(nested).toMatchObject({ path: 'Outer\\Inner\\Sample Film.mkv', folders: ['Inner', 'Outer'], ext: '.mkv' });
    expect(scan.files.find((file) => file.stem === 'Top Level')?.folders).toEqual([]);
  });

  it('attaches sidecars with their language suffix', async () => {
    const root = await makeTempDir();
    await createTree(root, libraryTree);
    const scan = await scanRoot(root);
    const file = scan.files.find((entry) => entry.stem.startsWith('sample.film.one'));
    expect(file?.sidecars.map((sidecar) => sidecar.suffix)).toEqual(['.en.srt', '.es.forced.srt']);
  });

  it('gives a sidecar to the video with the longest matching stem', async () => {
    const root = await makeTempDir();
    await createTree(root, ['Sample.mkv', 'Sample.Extended.mkv', 'Sample.Extended.en.srt', 'Sample.en.srt']);
    const scan = await scanRoot(root);
    expect(scan.files.find((file) => file.stem === 'Sample')?.sidecars.map((s) => s.suffix)).toEqual(['.en.srt']);
    expect(scan.files.find((file) => file.stem === 'Sample.Extended')?.sidecars.map((s) => s.suffix)).toEqual(['.en.srt']);
  });

  it('matches extensions without regard to case', async () => {
    const root = await makeTempDir();
    await createTree(root, ['Sample Film.MKV', 'Sample Film.EN.SRT']);
    const scan = await scanRoot(root);
    expect(scan.files).toHaveLength(1);
    expect(scan.files[0]?.sidecars).toHaveLength(1);
  });

  it('gives each file a stable id that ignores case', () => {
    expect(fileId('Folder\\Sample.mkv')).toBe(fileId('folder\\SAMPLE.MKV'));
    expect(fileId('Folder\\Sample.mkv')).not.toBe(fileId('Folder\\Other.mkv'));
  });

  it('does not follow a junction that points outside the root', async () => {
    const base = await makeTempDir();
    const root = join(base, 'Library');
    const outside = join(base, 'Outside');
    await mkdir(root);
    await createTree(outside, ['Elsewhere\\Outside Film.mkv']);
    await createTree(root, ['Inside Film.mkv']);
    await symlink(outside, join(root, 'Linked'), 'junction');

    const scan = await scanRoot(root);
    expect(scan.files.map((file) => file.stem)).toEqual(['Inside Film']);
  });

  it('refuses a root that is missing or is a file', async () => {
    const root = await makeTempDir();
    await createTree(root, ['Sample Film.mkv']);
    await expect(scanRoot(join(root, 'missing'))).rejects.toMatchObject({ code: 'ROOT_INVALID' });
    await expect(scanRoot(join(root, 'Sample Film.mkv'))).rejects.toMatchObject({ code: 'ROOT_INVALID' });
  });
});
