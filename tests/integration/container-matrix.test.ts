import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containerFor, containerMatrix } from '../../src/tag/containers.ts';
import { createExifBackend } from '../../src/tag/exif.ts';
import { createMkvBackend } from '../../src/tag/mkv.ts';
import type { TagBackend } from '../../src/tag/backend.ts';
import { realBackendDeps, findRealTools, makeSample } from '../helpers/real-tools.ts';
import { useTempDirs } from '../helpers/temp-dir.ts';

const tools = await findRealTools();
const makeTempDir = useTempDirs();

const backends: Record<string, TagBackend> = {
  mkvpropedit: createMkvBackend(realBackendDeps),
  exiftool: createExifBackend(realBackendDeps),
};

// Not a real title. The accents check that names and values survive the tool arguments.
const title = 'Prueba Ñandú Título';

describe.skipIf(tools === undefined)('container support matrix, with the real tools', () => {
  it.each(Object.keys(containerMatrix))('%s: a title write and read-back match the matrix', async (extension) => {
    if (tools === undefined) {
      return;
    }
    const dir = await makeTempDir();
    const file = join(dir, `Película de Prueba${extension}`);
    await makeSample(tools, file);
    const before = await readFile(file);

    const support = containerFor(file);
    if (support.writer === null) {
      // Rename-only containers: the exiftool attempt must fail and leave the file untouched.
      await expect(backends.exiftool?.write(file, { title, fields: {} })).rejects.toBeDefined();
      expect(await readFile(file)).toEqual(before);
      expect(support.reason).toMatch(/cannot write/);
      return;
    }

    const backend = backends[support.writer];
    expect(backend).toBeDefined();
    expect((await backend?.read(file, []))?.title).toBeNull();

    await backend?.write(file, { title, fields: {} });
    expect((await backend?.read(file, []))?.title).toBe(title);

    // Undo: the previous title was none, so writing a null title removes it.
    await backend?.write(file, { title: null, fields: {} });
    expect((await backend?.read(file, []))?.title).toBeNull();
  });

  it('leaves no temporary file next to a tagged mp4', async () => {
    if (tools === undefined) {
      return;
    }
    const dir = await makeTempDir();
    const file = join(dir, 'sample.mp4');
    await makeSample(tools, file);
    await backends.exiftool?.write(file, { title, fields: {} });
    expect(await readdir(dir)).toEqual(['sample.mp4']);
  });
});
