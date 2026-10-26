import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cachePaths, normalizeRoot, rootId, rootStatePaths } from '../../src/state/paths.ts';

describe('normalizeRoot and rootId', () => {
  it('gives the same id for spellings of one folder', () => {
    const ids = new Set(['U:\\Videos', 'u:\\videos\\', 'U:/Videos/', 'U:\\Videos\\Sub\\..'].map(rootId));
    expect(ids.size).toBe(1);
  });

  it('keeps the separator of a drive root', () => {
    expect(normalizeRoot('U:\\')).toBe('u:\\');
  });

  it('gives different ids for different folders', () => {
    expect(rootId('U:\\Videos')).not.toBe(rootId('U:\\Videos Old'));
  });

  it('is a short hex string', () => {
    expect(rootId('U:\\Videos')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('state paths', () => {
  it('partitions root state by mode and root id', () => {
    const paths = rootStatePaths('state', 'videos', 'U:\\Videos');
    const dir = resolve('state', 'videos', rootId('U:\\Videos'));
    expect(paths).toEqual({
      dir,
      scan: join(dir, 'scan.json'),
      resolve: join(dir, 'resolve.json'),
      plan: join(dir, 'plan.json'),
      journal: join(dir, 'journal.jsonl'),
    });
  });

  it('keeps one root apart from another and one mode apart from another', () => {
    expect(rootStatePaths('state', 'videos', 'U:\\A').dir).not.toBe(rootStatePaths('state', 'videos', 'U:\\B').dir);
    expect(rootStatePaths('state', 'videos', 'U:\\A').dir).not.toBe(rootStatePaths('state', 'movies', 'U:\\A').dir);
  });

  it('puts shared caches under cache', () => {
    const dir = resolve('state', 'cache');
    expect(cachePaths('state')).toEqual({
      dir,
      parse: join(dir, 'parse-cache.json'),
      tmdb: join(dir, 'tmdb-cache.json'),
    });
  });
});
