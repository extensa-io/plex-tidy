import { lstat } from 'node:fs/promises';
import { AppError, nodeErrorCode } from '../errors.ts';

/** True when a file, folder, or link exists at `path`. Does not follow links. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      return false;
    }
    throw new AppError('RENAME_FAILED', 'A path could not be checked.', { cause: error });
  }
}
