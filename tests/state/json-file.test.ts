import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readJsonFile, writeJsonFile } from '../../src/state/json-file.ts';
import { versionedSchema } from '../../src/state/schemas.ts';
import { useTempDirs } from '../helpers/temp-dir.ts';

const makeTempDir = useTempDirs();

const sampleSchema = versionedSchema(1, { items: z.array(z.string()) });

function systemError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

describe('writeJsonFile and readJsonFile', () => {
  it('writes and reads back a validated file', async () => {
    const file = join(await makeTempDir(), 'nested', 'sample.json');
    await writeJsonFile(file, sampleSchema, { schemaVersion: 1, items: ['one', 'two'] });

    expect(await readJsonFile(file, sampleSchema)).toEqual({ schemaVersion: 1, items: ['one', 'two'] });
    expect((await readFile(file, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('returns undefined for a missing file', async () => {
    expect(await readJsonFile(join(await makeTempDir(), 'missing.json'), sampleSchema)).toBeUndefined();
  });

  it('rejects a file that is not valid JSON', async () => {
    const file = join(await makeTempDir(), 'sample.json');
    await writeFile(file, '{ not json');
    await expect(readJsonFile(file, sampleSchema)).rejects.toMatchObject({ code: 'STATE_INVALID' });
  });

  it('rejects a file with the wrong schemaVersion', async () => {
    const file = join(await makeTempDir(), 'sample.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 2, items: [] }));
    await expect(readJsonFile(file, sampleSchema)).rejects.toMatchObject({ code: 'STATE_INVALID' });
  });

  it('refuses to write invalid data and leaves the previous file intact', async () => {
    const file = join(await makeTempDir(), 'sample.json');
    await writeJsonFile(file, sampleSchema, { schemaVersion: 1, items: ['kept'] });

    const invalid = { schemaVersion: 1, items: [42] } as unknown as z.input<typeof sampleSchema>;
    await expect(writeJsonFile(file, sampleSchema, invalid)).rejects.toMatchObject({ code: 'STATE_INVALID' });
    expect(await readJsonFile(file, sampleSchema)).toEqual({ schemaVersion: 1, items: ['kept'] });
  });

  it('leaves the previous file intact and removes the temporary file when the final rename fails', async () => {
    const dir = await makeTempDir();
    const file = join(dir, 'sample.json');
    await writeJsonFile(file, sampleSchema, { schemaVersion: 1, items: ['kept'] });

    const failingRename = () => Promise.reject(systemError('EIO'));
    await expect(
      writeJsonFile(file, sampleSchema, { schemaVersion: 1, items: ['lost'] }, { rename: failingRename }),
    ).rejects.toMatchObject({ code: 'STATE_WRITE_FAILED' });

    expect(await readJsonFile(file, sampleSchema)).toEqual({ schemaVersion: 1, items: ['kept'] });
    expect(await readdir(dir)).toEqual(['sample.json']);
  });

  it('retries a rename that fails with a transient Windows lock error', async () => {
    const file = join(await makeTempDir(), 'sample.json');
    let calls = 0;
    const flakyRename = async (from: string, to: string) => {
      calls += 1;
      if (calls === 1) {
        throw systemError('EPERM');
      }
      await rename(from, to);
    };

    await writeJsonFile(file, sampleSchema, { schemaVersion: 1, items: ['saved'] }, { rename: flakyRename });
    expect(calls).toBe(2);
    expect(await readJsonFile(file, sampleSchema)).toEqual({ schemaVersion: 1, items: ['saved'] });
  });
});
