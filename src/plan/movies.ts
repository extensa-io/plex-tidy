import { win32 } from 'node:path';
import { AppError } from '../errors.ts';
import { checkPathLength } from '../fs-win/path-checks.ts';
import { sanitizeName } from '../fs-win/sanitize.ts';
import type { MovieResolveFile, MovieResolution, MovieResolveEntry } from '../resolve/movie-schemas.ts';
import type { Scan, ScanFile } from '../scan/schemas.ts';
import type { TagRecord } from '../tag/schemas.ts';
import type { MovieDetails } from '../tmdb/schemas.ts';
import { carryOverDecisions, type PathExists } from './build.ts';
import { PLAN_SCHEMA_VERSION, type Plan, type PlanEntry } from './schemas.ts';
import { UNMATCHED_REASON } from './status.ts';
import { folderOf, pathKey } from './targets.ts';

/** The name parts of one movie, without extension. */
export interface MovieNames {
  /** The folder name, which is also the start of the file name. */
  folder: string;
  /** The file name without extension. */
  file: string;
}

type NamedMovie = Pick<MovieDetails, 'id' | 'title' | 'originalTitle' | 'year'>;

/**
 * `Title (Year) {tmdb-<id>}` for the folder and the file, and the file gains
 * ` {edition-<name>}` when an edition was parsed. The title is the TMDB
 * original title, made legal for Windows. Returns undefined when no legal title is left.
 */
export function movieNames(movie: NamedMovie, edition: string | null): MovieNames | undefined {
  const title = sanitizeName(movie.originalTitle) || sanitizeName(movie.title);
  if (title === '') {
    return undefined;
  }
  const year = movie.year === null ? '' : ` (${movie.year})`;
  const folder = `${title}${year} {tmdb-${movie.id}}`;
  const editionName = edition === null ? '' : sanitizeName(edition.replace(/[{}]/g, ''));
  return { folder, file: editionName === '' ? folder : `${folder} {edition-${editionName}}` };
}

/** The record that `tag` writes for a movie. */
export function movieTagRecord(movie: MovieDetails): TagRecord {
  return {
    title: movie.title,
    originalTitle: movie.originalTitle,
    ...(movie.releaseDate === null ? {} : { dateReleased: movie.releaseDate }),
    ...(movie.overview === '' ? {} : { synopsis: movie.overview }),
    ...(movie.genres.length === 0 ? {} : { genre: movie.genres }),
    ...(movie.directors.length === 0 ? {} : { director: movie.directors }),
    ...(movie.cast.length === 0 ? {} : { actor: movie.cast }),
    tmdb: `movie/${movie.id}`,
  };
}

export interface MovieFileInfo {
  file: ScanFile;
  /** True when the file is the only video under its folder, so the folder can take the movie's name. */
  renameFolder: boolean;
}

/**
 * A folder is renamed only when it is below the root and holds exactly one
 * video, counting videos in its subfolders. A folder with several movies keeps its name.
 */
export function movieFileInfos(scan: Scan): Map<string, MovieFileInfo> {
  const infos = new Map<string, MovieFileInfo>();
  for (const file of scan.files) {
    const folder = folderOf(file.path);
    const prefix = `${pathKey(folder)}\\`;
    const videosUnder = scan.files.filter((other) => pathKey(other.path).startsWith(prefix)).length;
    infos.set(file.id, { file, renameFolder: folder !== '' && videosUnder === 1 });
  }
  return infos;
}

/** The names, folder rename, and tag record for a movie. The status and the collision flag are set by the caller. */
function proposeEntry(info: MovieFileInfo, movie: MovieDetails, edition: string | null): PlanEntry | undefined {
  const names = movieNames(movie, edition);
  if (names === undefined) {
    return undefined;
  }
  const { file } = info;
  const oldFolder = folderOf(file.path);
  const parent = folderOf(oldFolder);
  const newFolder = info.renameFolder ? win32.join(parent, names.folder) : oldFolder;
  const folderChanged = info.renameFolder && newFolder !== oldFolder;
  return {
    id: file.id,
    source: file.path,
    target: win32.join(newFolder, `${names.file}${file.ext}`),
    sidecars: file.sidecars.map((sidecar) => ({
      source: sidecar.path,
      target: win32.join(newFolder, `${names.file}${sidecar.suffix}`),
    })),
    folder: folderChanged ? { source: oldFolder, target: newFolder } : null,
    tagRecord: movieTagRecord(movie),
    title: movie.title,
    titleSource: 'tmdb',
    confidence: 'high',
    reason: '',
    status: 'pending',
    tagStatus: 'untagged',
    tagReason: null,
    collision: false,
  };
}

function isUnchanged(entry: PlanEntry): boolean {
  return (
    entry.folder === null &&
    entry.target === entry.source &&
    entry.sidecars.every((sidecar) => sidecar.source === sidecar.target)
  );
}

/** Paths an entry writes: the new folder (when renamed), the video, and the sidecars. */
function writtenPaths(entry: PlanEntry): string[] {
  return [...(entry.folder === null ? [] : [entry.folder.target]), entry.target, ...entry.sidecars.map((sidecar) => sidecar.target)];
}

/** Paths an entry reads or renames away. */
function ownPaths(entry: PlanEntry): string[] {
  return [...(entry.folder === null ? [] : [entry.folder.source]), entry.source, ...entry.sidecars.map((sidecar) => sidecar.source)];
}

/** Why a proposed entry cannot be applied as it is, or undefined. Looks at the disk only. */
async function diskProblem(entry: PlanEntry, root: string, exists: PathExists): Promise<string | undefined> {
  const own = new Set(ownPaths(entry).map(pathKey));
  for (const path of writtenPaths(entry)) {
    const length = checkPathLength(win32.join(root, path));
    if (!length.ok) {
      return `the new path would be ${length.length} characters; the limit is ${length.limit}`;
    }
    if (!own.has(pathKey(path)) && (await exists(win32.join(root, path)))) {
      return 'a file or folder with the new name already exists';
    }
  }
  return undefined;
}

export interface MoviePlanOptions {
  exists: PathExists;
  previous?: Plan | undefined;
  now?: Date;
  onProgress?: (done: number, total: number) => void;
}

/** Builds the plan from the resolved movies. Nothing moves. */
export async function buildMoviePlan(scan: Scan, resolved: MovieResolveFile, options: MoviePlanOptions): Promise<Plan> {
  if (resolved.scanId !== scan.scanId) {
    throw new AppError('STAGE_STALE', 'resolve.json was made from an older scan. Run parse and resolve again.');
  }
  const infos = movieFileInfos(scan);
  const byId = new Map(resolved.entries.map((entry) => [entry.id, entry]));

  const entries: PlanEntry[] = [];
  options.onProgress?.(0, scan.files.length);
  for (const [index, file] of scan.files.entries()) {
    const resolvedEntry = byId.get(file.id);
    const info = infos.get(file.id);
    if (resolvedEntry?.resolution == null || info === undefined) {
      throw new AppError('STAGE_MISSING', 'Some files have no resolution. Run resolve first.');
    }
    entries.push(await entryFor(info, resolvedEntry, resolvedEntry.resolution, scan.root, options.exists));
    options.onProgress?.(index + 1, scan.files.length);
  }

  markDuplicateTargets(entries);
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    scanId: scan.scanId,
    root: scan.root,
    builtAt: (options.now ?? new Date()).toISOString(),
    entries: carryOverDecisions(entries, options.previous),
  };
}

function leftInPlace(file: ScanFile, status: PlanEntry['status'], reason: string, title: string | null): PlanEntry {
  return {
    id: file.id,
    source: file.path,
    target: file.path,
    sidecars: file.sidecars.map((sidecar) => ({ source: sidecar.path, target: sidecar.path })),
    folder: null,
    tagRecord: null,
    title,
    titleSource: 'none',
    confidence: 'low',
    reason,
    status,
    tagStatus: 'untagged',
    tagReason: null,
    collision: false,
  };
}

async function entryFor(
  info: MovieFileInfo,
  resolved: MovieResolveEntry,
  resolution: MovieResolution,
  root: string,
  exists: PathExists,
): Promise<PlanEntry> {
  const chosen = resolved.candidates.find((candidate) => candidate.details.id === resolution.chosenId);

  if (chosen === undefined) {
    if (resolved.candidates.length === 0) {
      return leftInPlace(info.file, 'skipped', UNMATCHED_REASON, null);
    }
    return leftInPlace(info.file, 'pending', `no match was chosen. ${resolution.reason}`, null);
  }

  const proposed = proposeEntry(info, chosen.details, resolved.parse.edition);
  if (proposed === undefined) {
    return leftInPlace(info.file, 'pending', 'the movie title has no characters that Windows allows in a name', chosen.details.title);
  }
  const entry: PlanEntry = {
    ...proposed,
    titleSource: resolution.via === 'judge' ? 'judge' : 'tmdb',
    confidence: resolution.confidence,
  };

  if (isUnchanged(entry)) {
    return { ...entry, status: 'skipped', reason: 'unchanged' };
  }
  const problem = resolved.parse.part !== null
    ? 'the name has a part marker, so several files can belong to this movie'
    : await diskProblem(entry, root, exists);
  if (problem !== undefined) {
    return { ...entry, status: 'pending', collision: true, reason: `blocked: ${problem}` };
  }
  if (resolution.confidence === 'high') {
    return { ...entry, status: 'approved', reason: `auto: ${resolution.reason}` };
  }
  return { ...entry, status: 'pending', reason: resolution.reason };
}

/** Two entries must never write the same path. Review can fix them, and apply refuses them. */
function markDuplicateTargets(entries: PlanEntry[]): void {
  const owners = new Map<string, Set<PlanEntry>>();
  for (const entry of entries) {
    for (const path of writtenPaths(entry)) {
      const key = pathKey(path);
      owners.set(key, (owners.get(key) ?? new Set()).add(entry));
    }
  }
  for (const group of owners.values()) {
    if (group.size < 2) {
      continue;
    }
    for (const entry of group) {
      entry.collision = true;
      if (entry.status === 'approved' || (entry.status === 'skipped' && entry.reason === 'unchanged')) {
        entry.status = 'pending';
      }
      entry.reason = 'blocked: another entry would write the same name';
    }
  }
}

export type MovieChoice = { ok: true; entry: PlanEntry } | { ok: false; message: string };

/**
 * Applies a movie chosen in review. The new names must fit the path limit and
 * collide with nothing in the plan or on disk.
 */
export async function applyChosenMovie(
  plan: Plan,
  entry: PlanEntry,
  info: MovieFileInfo,
  movie: MovieDetails,
  edition: string | null,
  exists: PathExists,
): Promise<MovieChoice> {
  const proposed = proposeEntry(info, movie, edition);
  if (proposed === undefined) {
    return { ok: false, message: 'That movie has no title with characters that Windows allows in a name.' };
  }
  const candidate: PlanEntry = {
    ...proposed,
    titleSource: 'manual',
    confidence: 'high',
    reason: 'movie chosen in review',
    status: isUnchanged(proposed) ? 'skipped' : 'approved',
    tagStatus: entry.tagStatus,
    tagReason: entry.tagReason,
  };
  if (isUnchanged(candidate)) {
    return { ok: true, entry: { ...candidate, reason: 'unchanged' } };
  }

  const problem = await diskProblem(candidate, plan.root, exists);
  if (problem !== undefined) {
    return { ok: false, message: `That movie cannot be used: ${problem}.` };
  }
  const claimed = new Set(
    plan.entries.filter((other) => other.id !== entry.id).flatMap((other) => [...writtenPaths(other), ...ownPaths(other)].map(pathKey)),
  );
  if (writtenPaths(candidate).some((path) => claimed.has(pathKey(path)))) {
    return { ok: false, message: 'Another entry in the plan already uses that name.' };
  }
  return { ok: true, entry: candidate };
}
