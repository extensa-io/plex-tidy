import { win32 } from 'node:path';

/**
 * Windows MAX_PATH is 260 including the terminating null character, so the
 * longest usable path is 259 characters. The tool refuses longer paths
 * instead of enabling long-path support.
 */
export const MAX_PATH_LENGTH = 259;

export type PathLengthCheck = { ok: true; length: number } | { ok: false; length: number; limit: number };

export function checkPathLength(path: string): PathLengthCheck {
  const { length } = win32.resolve(path);
  return length <= MAX_PATH_LENGTH ? { ok: true, length } : { ok: false, length, limit: MAX_PATH_LENGTH };
}

/** The volume a path lives on: `U:\` for a drive, `\\server\share\` for a UNC path. Uppercase. */
export function volumeOf(path: string): string {
  return win32.parse(win32.resolve(path)).root.toUpperCase();
}

export function sameVolume(a: string, b: string): boolean {
  return volumeOf(a) === volumeOf(b);
}

/** True when `target` is strictly inside `root`. The root itself is not inside. */
export function isInsideRoot(root: string, target: string): boolean {
  const relative = win32.relative(win32.resolve(root), win32.resolve(target));
  return relative !== '' && relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative);
}
