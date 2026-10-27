import { win32 } from 'node:path';
import { AppError } from '../errors.ts';
import { checkPathLength } from '../fs-win/path-checks.ts';
import { sanitizeName } from '../fs-win/sanitize.ts';
import type { TvEpisodeResolution, TvResolveFile, TvShowGroup } from '../resolve/tv-schemas.ts';
import type { Scan, ScanFile } from '../scan/schemas.ts';
import type { TagRecord } from '../tag/schemas.ts';
import type { ShowDetails } from '../tmdb/schemas.ts';
import { carryOverDecisions, type PathExists } from './build.ts';
import { PLAN_SCHEMA_VERSION, type Plan, type PlanEntry } from './schemas.ts';
import { UNMATCHED_REASON } from './status.ts';
import { folderOf, pathKey } from './targets.ts';

type NamedShow = Pick<ShowDetails, 'id' | 'name' | 'originalName' | 'year'>;

/** `Show (Year) {tmdb-<id>}`, the name of the show folder. Undefined when no legal name is left. */
export function showFolderName(show: NamedShow): string | undefined {
  const name = sanitizeName(show.name) || sanitizeName(show.originalName);
  if (name === '') {
    return undefined;
  }
  return `${name}${show.year === null ? '' : ` (${show.year})`} {tmdb-${show.id}}`;
}

/** `Season 01`. Season 0 is `Season 00`, which Plex reads as the specials. */
export function seasonFolderName(season: number): string {
  return `Season ${String(season).padStart(2, '0')}`;
}

/** `s01e02`, or `s01e02-e03` for a file with several episodes. */
export function episodeCode(season: number, episode: number, episodeEnd: number | null): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `s${pad(season)}e${pad(episode)}${episodeEnd === null ? '' : `-e${pad(episodeEnd)}`}`;
}

/** The titles of a file's episodes in one piece. A file with several episodes joins them with ` + `. */
export function joinedTitle(titles: readonly string[]): string {
  return titles.filter((title) => title !== '').join(' + ');
}

/** `Show (Year) {tmdb-id} - s01e02 - Title`, without the extension. */
export function episodeFileStem(folderName: string, code: string, title: string): string {
  const cleaned = sanitizeName(title);
  return cleaned === '' ? `${folderName} - ${code}` : `${folderName} - ${code} - ${cleaned}`;
}

/** The record that `tag` writes for an episode. */
export function episodeTagRecord(show: ShowDetails, episode: TvEpisodeResolution, title: string): TagRecord {
  return {
    title: title === '' ? show.name : title,
    show: show.name,
    ...(episode.season === null ? {} : { season: episode.season }),
    ...(episode.episode === null ? {} : { episode: episode.episode }),
    ...(episode.airDate === null ? {} : { airDate: episode.airDate }),
    ...(episode.overview === '' ? {} : { synopsis: episode.overview }),
    ...(show.genres.length === 0 ? {} : { genre: show.genres }),
    tmdb: `tv/${show.id}`,
  };
}

/** Where an episode goes, and what is renamed with it. Statuses and flags are set by the caller. */
export function proposeEpisode(
  file: ScanFile,
  group: Pick<TvShowGroup, 'dir'>,
  show: ShowDetails,
  episode: TvEpisodeResolution,
  newShowDirExists: boolean,
): PlanEntry | undefined {
  const folderName = showFolderName(show);
  if (folderName === undefined || episode.season === null || episode.episode === null || !episode.found) {
    return undefined;
  }
  const parent = group.dir === '' ? '' : folderOf(group.dir);
  const newShowDir = win32.join(parent, folderName);
  const seasonDir = win32.join(newShowDir, seasonFolderName(episode.season));
  const title = joinedTitle(episode.titles);
  const stem = episodeFileStem(folderName, episodeCode(episode.season, episode.episode, episode.episodeEnd), title);
  // The show folder is renamed in place when the new name is free. Otherwise the files move into it.
  const renameFolder = group.dir !== '' && group.dir !== newShowDir && !newShowDirExists;
  return {
    id: file.id,
    source: file.path,
    target: win32.join(seasonDir, `${stem}${file.ext}`),
    sidecars: file.sidecars.map((sidecar) => ({ source: sidecar.path, target: win32.join(seasonDir, `${stem}${sidecar.suffix}`) })),
    folder: renameFolder ? { source: group.dir, target: newShowDir } : null,
    tagRecord: episodeTagRecord(show, episode, title),
    title: title === '' ? show.name : title,
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
  return entry.folder === null && entry.target === entry.source && entry.sidecars.every((sidecar) => sidecar.source === sidecar.target);
}

function writtenPaths(entry: PlanEntry): string[] {
  return [entry.target, ...entry.sidecars.map((sidecar) => sidecar.target)];
}

function ownPaths(entry: PlanEntry): string[] {
  return [entry.source, ...entry.sidecars.map((sidecar) => sidecar.source)];
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
      return 'a file with the new name already exists';
    }
  }
  return undefined;
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

export interface TvPlanOptions {
  exists: PathExists;
  previous?: Plan | undefined;
  now?: Date;
  onProgress?: (done: number, total: number) => void;
}

/** Builds the plan from the resolved shows and episodes. Nothing moves. */
export async function buildTvPlan(scan: Scan, resolved: TvResolveFile, options: TvPlanOptions): Promise<Plan> {
  if (resolved.scanId !== scan.scanId) {
    throw new AppError('STAGE_STALE', 'resolve.json was made from an older scan. Run parse and resolve again.');
  }
  const groups = new Map(resolved.shows.map((group) => [group.key, group]));
  const byId = new Map(resolved.entries.map((entry) => [entry.id, entry]));
  const showFolderExists = new Map<string, boolean>();

  const entries: PlanEntry[] = [];
  options.onProgress?.(0, scan.files.length);
  for (const [index, file] of scan.files.entries()) {
    const entry = byId.get(file.id);
    const group = entry === undefined ? undefined : groups.get(entry.groupKey);
    if (entry === undefined || group === undefined || entry.episode === null) {
      throw new AppError('STAGE_MISSING', 'Some files have no resolution. Run resolve first.');
    }
    const show = group.candidates.find((candidate) => candidate.details.id === group.resolution?.chosenId)?.details;

    if (show === undefined || group.resolution === null) {
      entries.push(
        group.candidates.length === 0
          ? leftInPlace(file, 'skipped', UNMATCHED_REASON, null)
          : leftInPlace(file, 'pending', `no show was chosen. ${group.resolution?.reason ?? ''}`.trim(), null),
      );
    } else {
      entries.push(await episodeEntry(file, group, show, entry.episode, scan.root, options.exists, showFolderExists));
    }
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

async function episodeEntry(
  file: ScanFile,
  group: TvShowGroup,
  show: ShowDetails,
  episode: TvEpisodeResolution,
  root: string,
  exists: PathExists,
  folderExists: Map<string, boolean>,
): Promise<PlanEntry> {
  const resolution = group.resolution;
  const folderName = showFolderName(show);
  const parent = group.dir === '' ? '' : folderOf(group.dir);
  const newShowDir = folderName === undefined ? '' : win32.join(parent, folderName);
  if (!folderExists.has(newShowDir)) {
    folderExists.set(newShowDir, newShowDir !== '' && newShowDir.toLowerCase() !== group.dir.toLowerCase() && (await exists(win32.join(root, newShowDir))));
  }

  const proposed = proposeEpisode(file, group, show, episode, folderExists.get(newShowDir) ?? false);
  if (proposed === undefined) {
    return leftInPlace(file, 'pending', episode.found ? 'the show has no name that Windows allows in a folder name' : episode.reason, null);
  }
  const entry: PlanEntry = { ...proposed, titleSource: resolution?.via === 'judge' ? 'judge' : resolution?.via === 'manual' ? 'manual' : 'tmdb' };

  if (isUnchanged(entry)) {
    return { ...entry, status: 'skipped', reason: 'unchanged' };
  }
  const problem = await diskProblem(entry, root, exists);
  if (problem !== undefined) {
    return { ...entry, status: 'pending', collision: true, reason: `blocked: ${problem}` };
  }

  const flagged = episode.seasonSource === 'assumed' || episode.conflict;
  const sure = resolution?.confidence === 'high' && !flagged;
  const showNote = `${show.name}: ${episode.reason}`;
  return sure
    ? { ...entry, confidence: 'high', status: 'approved', reason: `auto: ${showNote}` }
    : { ...entry, confidence: 'low', status: 'pending', reason: flagged ? showNote : `${showNote}. ${resolution?.reason ?? ''}`.trim() };
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
