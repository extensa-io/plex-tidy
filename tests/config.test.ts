import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseConfig } from '../src/config.ts';
import { AppError } from '../src/errors.ts';
import { useTempDirs } from './helpers/temp-dir.ts';

const makeTempDir = useTempDirs();

const minimal = { models: { parse: 'parse-model', judge: 'judge-model' } };

describe('parseConfig', () => {
  it('applies defaults', () => {
    expect(parseConfig(minimal)).toEqual({
      stateDir: './state',
      models: { parse: 'parse-model', judge: 'judge-model' },
      autoApplyThreshold: 0.9,
      tmdbConcurrency: 4,
      parseBatchSize: 50,
      tools: {},
    });
  });

  it('accepts tool path overrides', () => {
    const config = parseConfig({ ...minimal, tools: { exiftool: 'C:\\Tools\\exiftool.exe' } });
    expect(config.tools.exiftool).toBe('C:\\Tools\\exiftool.exe');
  });

  it.each([
    ['a missing models block', {}],
    ['an empty model name', { models: { parse: '', judge: 'judge-model' } }],
    ['a batch size below 50', { ...minimal, parseBatchSize: 40 }],
    ['a batch size above 100', { ...minimal, parseBatchSize: 101 }],
    ['a threshold above 1', { ...minimal, autoApplyThreshold: 1.5 }],
    ['a fractional concurrency', { ...minimal, tmdbConcurrency: 2.5 }],
    ['an unknown key', { ...minimal, libraryRoot: 'U:\\Videos' }],
    ['an unknown tool', { ...minimal, tools: { mediainfo: 'C:\\Tools\\mediainfo.exe' } }],
    ['a value that is not an object', 'not an object'],
  ])('rejects %s with a CONFIG_INVALID AppError', (_label, raw) => {
    expect(() => parseConfig(raw)).toThrow(AppError);
    expect(() => parseConfig(raw)).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });
});

describe('loadConfig', () => {
  it('reads and validates a config file', async () => {
    const file = join(await makeTempDir(), 'config.json');
    await writeFile(file, JSON.stringify(minimal));
    await expect(loadConfig(file)).resolves.toMatchObject({ parseBatchSize: 50 });
  });

  it('reports a missing file with a hint', async () => {
    const promise = loadConfig(join(await makeTempDir(), 'config.json'));
    await expect(promise).rejects.toMatchObject({ code: 'CONFIG_MISSING' });
    await expect(promise).rejects.toThrow(/config\.example\.json/);
  });

  it('reports a file that is not valid JSON', async () => {
    const file = join(await makeTempDir(), 'config.json');
    await writeFile(file, '{ "models": ');
    await expect(loadConfig(file)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});
