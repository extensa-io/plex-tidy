import { statfs } from 'node:fs/promises';
import { AppError } from '../errors.ts';

/** Room kept free beyond the size of the file being copied. */
export const SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

/** Free bytes on the volume that holds `directory`, or `null` when the system does not say. */
export type FreeBytes = (directory: string) => Promise<number | null>;

export const freeBytes: FreeBytes = async (directory) => {
  try {
    const stats = await statfs(directory);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
};

/**
 * An ExifTool rewrite writes a full copy of the file next to the original.
 * Refuses when the volume lacks room for the copy plus a margin.
 */
export async function ensureFreeSpace(directory: string, fileSize: number, free: FreeBytes = freeBytes): Promise<void> {
  const available = await free(directory);
  const needed = fileSize + SPACE_MARGIN_BYTES;
  if (available !== null && available < needed) {
    throw new AppError(
      'TAG_NO_SPACE',
      `Not enough free space for a temporary copy: needs ${megabytes(needed)} MB, has ${megabytes(available)} MB.`,
    );
  }
}

function megabytes(bytes: number): number {
  return Math.ceil(bytes / (1024 * 1024));
}
