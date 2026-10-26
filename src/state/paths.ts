import { createHash } from 'node:crypto';
import { resolve, win32 } from 'node:path';
import type { Mode } from './schemas.ts';

const ROOT_ID_LENGTH = 12;

/**
 * Normalizes a library root so the same folder always yields the same id:
 * absolute, backslash separators, no trailing separator, lowercase (Windows
 * paths are case-insensitive).
 */
export function normalizeRoot(root: string): string {
  const absolute = win32.resolve(root);
  const { root: volumeRoot } = win32.parse(absolute);
  const trimmed = absolute.length > volumeRoot.length ? absolute.replace(/\\+$/, '') : absolute;
  return trimmed.toLowerCase();
}

export function rootId(root: string): string {
  return createHash('sha256').update(normalizeRoot(root)).digest('hex').slice(0, ROOT_ID_LENGTH);
}

export interface RootStatePaths {
  dir: string;
  scan: string;
  resolve: string;
  plan: string;
  journal: string;
}

export interface CachePaths {
  dir: string;
  parse: string;
  tmdb: string;
}

export function rootStatePaths(stateDir: string, mode: Mode, root: string): RootStatePaths {
  const dir = resolve(stateDir, mode, rootId(root));
  return {
    dir,
    scan: resolve(dir, 'scan.json'),
    resolve: resolve(dir, 'resolve.json'),
    plan: resolve(dir, 'plan.json'),
    journal: resolve(dir, 'journal.jsonl'),
  };
}

export function cachePaths(stateDir: string): CachePaths {
  const dir = resolve(stateDir, 'cache');
  return {
    dir,
    parse: resolve(dir, 'parse-cache.json'),
    tmdb: resolve(dir, 'tmdb-cache.json'),
  };
}
