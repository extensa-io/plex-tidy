import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { AppError, nodeErrorCode } from '../errors.ts';
import { detectTitle } from '../parse/detector.ts';
import {
  SCAN_SCHEMA_VERSION,
  sidecarExtensions,
  videoExtensions,
  type Scan,
  type ScanFile,
  type Sidecar,
} from './schemas.ts';

const videoExtensionSet: ReadonlySet<string> = new Set(videoExtensions);
const sidecarExtensionSet: ReadonlySet<string> = new Set(sidecarExtensions);

/** A short stable id for a path relative to the root. Case-insensitive, like Windows. */
export function fileId(relativePath: string): string {
  return createHash('sha256').update(relativePath.toLowerCase()).digest('hex').slice(0, 12);
}

export async function scanRoot(root: string): Promise<Scan> {
  const absoluteRoot = win32.resolve(root);
  await requireDirectory(absoluteRoot);

  const files: ScanFile[] = [];
  await walk(absoluteRoot, [], files);
  files.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()) || a.path.localeCompare(b.path));

  return {
    schemaVersion: SCAN_SCHEMA_VERSION,
    scanId: randomUUID(),
    root: absoluteRoot,
    scannedAt: new Date().toISOString(),
    files,
  };
}

export interface ScanSummary {
  files: number;
  sidecars: number;
  untitled: number;
}

export function summarizeScan(scan: Scan): ScanSummary {
  return {
    files: scan.files.length,
    sidecars: scan.files.reduce((total, file) => total + file.sidecars.length, 0),
    untitled: scan.files.filter((file) => !file.titled).length,
  };
}

async function requireDirectory(path: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) {
      return;
    }
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new AppError('ROOT_INVALID', 'The root folder could not be read.', { cause: error });
    }
  }
  throw new AppError('ROOT_INVALID', 'The root folder does not exist or is not a folder.');
}

/** `relativeFolders` is the path from the root to `directory`, outermost first. */
async function walk(directory: string, relativeFolders: readonly string[], out: ScanFile[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new AppError('ROOT_INVALID', 'A folder under the root could not be read.', { cause: error });
  }

  const fileNames: string[] = [];
  for (const entry of entries) {
    // Links and junctions can lead outside the root, so the walk never follows them.
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      await walk(win32.join(directory, entry.name), [...relativeFolders, entry.name], out);
    } else if (entry.isFile()) {
      fileNames.push(entry.name);
    }
  }

  const videos = fileNames
    .filter((name) => videoExtensionSet.has(win32.extname(name).toLowerCase()))
    .map((name) => ({ name, stem: win32.parse(name).name, ext: win32.extname(name) }));
  const sidecarNames = fileNames.filter((name) => sidecarExtensionSet.has(win32.extname(name).toLowerCase()));

  for (const video of videos) {
    const relativePath = win32.join(...relativeFolders, video.name);
    const detection = detectTitle(video.stem);
    out.push({
      id: fileId(relativePath),
      path: relativePath,
      stem: video.stem,
      ext: video.ext,
      folders: [...relativeFolders].reverse(),
      sidecars: sidecarsFor(video.stem, videos, sidecarNames, relativeFolders),
      titled: detection.titled,
      untitledReason: detection.titled ? null : detection.reason,
    });
  }
}

/** A sidecar belongs to the video with the longest stem that it starts with, followed by a dot. */
function sidecarsFor(
  stem: string,
  videos: readonly { stem: string }[],
  sidecarNames: readonly string[],
  relativeFolders: readonly string[],
): Sidecar[] {
  const lowerStem = stem.toLowerCase();
  const sidecars: Sidecar[] = [];
  for (const name of sidecarNames) {
    const lowerName = name.toLowerCase();
    if (!lowerName.startsWith(`${lowerStem}.`)) {
      continue;
    }
    const hasLongerOwner = videos.some(
      (other) => other.stem.length > stem.length && lowerName.startsWith(`${other.stem.toLowerCase()}.`),
    );
    if (!hasLongerOwner) {
      sidecars.push({ path: win32.join(...relativeFolders, name), suffix: name.slice(stem.length) });
    }
  }
  return sidecars.sort((a, b) => a.path.localeCompare(b.path));
}
