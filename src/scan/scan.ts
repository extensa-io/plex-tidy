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

export interface ScanOptions {
  /** Called after each video file is found, with the count so far. */
  onFile?: (count: number) => void;
  /**
   * A folder under the root. Only this folder is scanned, but paths stay
   * relative to the root, so the folder itself can be renamed.
   */
  folder?: string;
}

/** The folder names between the root and `folder`, or an empty list for the whole root. */
export function folderSegments(root: string, folder: string | undefined): string[] {
  if (folder === undefined || folder.trim() === '') {
    return [];
  }
  const absolute = win32.resolve(root, folder.trim());
  const relative = win32.relative(win32.resolve(root), absolute);
  if (relative === '' || relative.startsWith('..') || win32.isAbsolute(relative)) {
    throw new AppError('OPTION_INVALID', '--folder must name a folder inside the root.');
  }
  return relative.split('\\').filter((segment) => segment !== '');
}

export async function scanRoot(root: string, options: ScanOptions = {}): Promise<Scan> {
  const absoluteRoot = win32.resolve(root);
  await requireDirectory(absoluteRoot);
  const segments = folderSegments(absoluteRoot, options.folder);
  const start = win32.join(absoluteRoot, ...segments);
  if (segments.length > 0) {
    await requireDirectory(start).catch(() => {
      throw new AppError('OPTION_INVALID', '--folder must name a folder inside the root.');
    });
  }

  const files: ScanFile[] = [];
  await walk(start, segments, files, options.onFile);
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
async function walk(
  directory: string,
  relativeFolders: readonly string[],
  out: ScanFile[],
  onFile: ((count: number) => void) | undefined,
): Promise<void> {
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
      await walk(win32.join(directory, entry.name), [...relativeFolders, entry.name], out, onFile);
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
    onFile?.(out.length);
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
