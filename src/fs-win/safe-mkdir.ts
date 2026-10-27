import { mkdir, realpath, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { AppError, nodeErrorCode } from '../errors.ts';
import { pathExists } from './exists.ts';
import { checkPathLength, isInsideRoot, sameVolume } from './path-checks.ts';
import { isSanitized } from './sanitize.ts';

export type SafeMkdirResult = 'created' | 'exists';

/**
 * Creates one folder inside a library root. The parent must exist. Refuses a
 * path outside the root, on another volume, over the path limit, with an
 * illegal name, or one that already exists as a file. A folder that already
 * exists is left alone and reported as `exists`.
 */
export async function safeMkdir(root: string, path: string): Promise<SafeMkdirResult> {
  const target = resolve(path);
  if (!isInsideRoot(root, target)) {
    throw new AppError('PATH_OUTSIDE_ROOT', 'A folder to create is outside the library root.');
  }
  if (!sameVolume(root, target)) {
    throw new AppError('CROSS_VOLUME', 'A folder to create is on another volume.');
  }
  const length = checkPathLength(target);
  if (!length.ok) {
    throw new AppError('PATH_TOO_LONG', `A folder path is ${length.length} characters; the limit is ${length.limit}.`);
  }
  if (!isSanitized(basename(target))) {
    throw new AppError('NAME_INVALID', 'A folder name contains characters Windows does not allow.');
  }

  if (await pathExists(target)) {
    if ((await stat(target)).isDirectory()) {
      return 'exists';
    }
    throw new AppError('DESTINATION_EXISTS', 'A file has the name of a folder to create.');
  }
  if (!(await pathExists(dirname(target)))) {
    throw new AppError('DESTINATION_PARENT_MISSING', 'The parent of a folder to create does not exist.');
  }
  try {
    const realRoot = await realpath(root);
    const realParent = await realpath(dirname(target));
    if (realParent.toLowerCase() !== realRoot.toLowerCase() && !isInsideRoot(realRoot, realParent)) {
      throw new AppError('PATH_OUTSIDE_ROOT', 'A folder to create leads outside the library root through a link.');
    }
    await mkdir(target);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('MKDIR_FAILED', 'A folder could not be created.', { cause: error });
  }
  return 'created';
}

/** Removes a folder only when it is empty. Returns false, and leaves it, when it holds anything. */
export async function removeEmptyFolder(root: string, path: string): Promise<boolean> {
  const target = resolve(path);
  if (!isInsideRoot(root, target)) {
    throw new AppError('PATH_OUTSIDE_ROOT', 'A folder to remove is outside the library root.');
  }
  try {
    await rmdir(target);
    return true;
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT') {
      return false;
    }
    throw new AppError('MKDIR_FAILED', 'A folder could not be removed.', { cause: error });
  }
}
