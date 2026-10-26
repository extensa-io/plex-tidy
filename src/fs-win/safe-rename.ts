import { randomBytes } from 'node:crypto';
import { lstat, realpath, rename } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { AppError, nodeErrorCode } from '../errors.ts';
import { checkPathLength, isInsideRoot, sameVolume } from './path-checks.ts';
import { isSanitized } from './sanitize.ts';

export type SafeRenameResult = 'renamed' | 'unchanged';

/**
 * Renames a file or folder within one library root. Refuses, with an
 * `AppError`, a destination outside the root, on another volume, over the
 * path limit, with an illegal name, or that already exists. Never copies and
 * never overwrites.
 */
export async function safeRename(root: string, from: string, to: string): Promise<SafeRenameResult> {
  const source = resolve(from);
  const destination = resolve(to);

  if (source === destination) {
    return 'unchanged';
  }
  if (!isInsideRoot(root, source) || !isInsideRoot(root, destination)) {
    throw new AppError('PATH_OUTSIDE_ROOT', 'A rename source or destination is outside the library root.');
  }
  if (!sameVolume(source, destination)) {
    throw new AppError('CROSS_VOLUME', 'A rename would move a file to another volume.');
  }
  const length = checkPathLength(destination);
  if (!length.ok) {
    throw new AppError(
      'PATH_TOO_LONG',
      `A destination path is ${length.length} characters; the limit is ${length.limit}.`,
    );
  }
  if (!isSanitized(basename(destination))) {
    throw new AppError('NAME_INVALID', 'A destination name contains characters Windows does not allow.');
  }

  await requireExists(source, 'SOURCE_MISSING', 'A rename source does not exist.');
  await requireExists(dirname(destination), 'DESTINATION_PARENT_MISSING', 'A destination folder does not exist.');
  await requireRealPathsInsideRoot(root, source, dirname(destination));

  if (source.toLowerCase() === destination.toLowerCase()) {
    await renameCaseOnly(source, destination);
    return 'renamed';
  }

  // Node's rename replaces an existing file on Windows, so check first. This
  // leaves a short race window, which is acceptable for a single-user tool.
  if (await exists(destination)) {
    throw new AppError('DESTINATION_EXISTS', 'A destination already exists.');
  }
  await renameOrFail(source, destination);
  return 'renamed';
}

/** The filesystem is case-insensitive, so a case-only rename goes through a temporary name. */
async function renameCaseOnly(source: string, destination: string): Promise<void> {
  const temp = join(dirname(source), `.plex-tidy-${randomBytes(6).toString('hex')}.tmp`);
  if (await exists(temp)) {
    throw new AppError('DESTINATION_EXISTS', 'A temporary rename name is already in use.');
  }
  await renameOrFail(source, temp);
  try {
    await rename(temp, destination);
  } catch (error) {
    await rename(temp, source).catch(() => undefined);
    throw new AppError('RENAME_FAILED', 'A case-only rename failed.', { cause: error });
  }
}

/** Resolves junctions and symbolic links so a link cannot lead a rename outside the root. */
async function requireRealPathsInsideRoot(root: string, source: string, destinationDir: string): Promise<void> {
  let realRoot: string;
  let realSourceDir: string;
  let realDestinationDir: string;
  try {
    realRoot = await realpath(root);
    realSourceDir = await realpath(dirname(source));
    realDestinationDir = await realpath(destinationDir);
  } catch (error) {
    throw new AppError('RENAME_FAILED', 'A rename path could not be resolved.', { cause: error });
  }
  const insideOrRoot = (path: string) => path.toLowerCase() === realRoot.toLowerCase() || isInsideRoot(realRoot, path);
  if (!insideOrRoot(realSourceDir) || !insideOrRoot(realDestinationDir)) {
    throw new AppError('PATH_OUTSIDE_ROOT', 'A rename path leads outside the library root through a link.');
  }
}

async function renameOrFail(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (nodeErrorCode(error) === 'EXDEV') {
      throw new AppError('CROSS_VOLUME', 'A rename would move a file to another volume.', { cause: error });
    }
    throw new AppError('RENAME_FAILED', 'A rename failed.', { cause: error });
  }
}

async function requireExists(
  path: string,
  code: 'SOURCE_MISSING' | 'DESTINATION_PARENT_MISSING',
  message: string,
): Promise<void> {
  if (!(await exists(path))) {
    throw new AppError(code, message);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      return false;
    }
    throw new AppError('RENAME_FAILED', 'A rename path could not be checked.', { cause: error });
  }
}
