import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import { isAppError } from '../errors.ts';
import type { Plan, PlanEntry } from '../plan/schemas.ts';
import type { Journal } from '../state/journal.ts';
import type { WriteOptions } from './backend.ts';
import type { Backends } from './backends.ts';
import { containerFor } from './containers.ts';
import { snapshotSatisfies } from './fields.ts';
import { TAG_ACTION, type SkippedField, type TagSnapshot, type Writer } from './schemas.ts';

export type TagAction = 'write' | 'unchanged' | 'unsupported' | 'unreadable';

export interface TagCandidate {
  entry: PlanEntry;
  /** Absolute path of the renamed file. */
  file: string;
  action: TagAction;
  writer: Writer | null;
  /** Why the file is not written: the container is rename-only, or the file could not be read. */
  reason: string | null;
  current: TagSnapshot | null;
  desired: TagSnapshot | null;
  skippedFields: SkippedField[];
}

/** An entry is ready to tag after it was renamed. A failed tag is tried again. */
export function isTaggable(entry: PlanEntry): boolean {
  return entry.status === 'applied' && (entry.tagStatus === 'untagged' || entry.tagStatus === 'tag-failed');
}

/** Reads the current tags of every taggable entry and decides what to do. Changes nothing. */
export async function planTagging(
  plan: Plan,
  backends: Backends,
  onProgress?: (done: number, total: number) => void,
): Promise<TagCandidate[]> {
  const candidates: TagCandidate[] = [];
  const taggable = plan.entries.filter(isTaggable);
  for (const [index, entry] of taggable.entries()) {
    onProgress?.(index, taggable.length);
    const file = win32.resolve(plan.root, entry.target);
    const base = { entry, file, current: null, desired: null, skippedFields: [] };
    const container = containerFor(file);

    if (container.writer === null || entry.title === null) {
      candidates.push({
        ...base,
        action: 'unsupported',
        writer: null,
        reason: container.reason ?? 'the file has no title to write',
      });
      continue;
    }

    const backend = backends[container.writer];
    const { desired, skipped } = backend.desired(entry.tagRecord ?? { title: entry.title });
    try {
      const current = await backend.read(file, Object.keys(desired.fields));
      candidates.push({
        ...base,
        action: snapshotSatisfies(current, desired) ? 'unchanged' : 'write',
        writer: container.writer,
        reason: null,
        current,
        desired,
        skippedFields: skipped,
      });
    } catch (error) {
      if (!isAppError(error)) {
        throw error;
      }
      candidates.push({ ...base, action: 'unreadable', writer: container.writer, reason: error.message, desired, skippedFields: skipped });
    }
  }
  onProgress?.(taggable.length, taggable.length);
  return candidates;
}

export interface TagCounts {
  write: number;
  unchanged: number;
  unsupported: number;
  unreadable: number;
  /** Rename-only candidates by reason. */
  unsupportedReasons: Record<string, number>;
}

export function countCandidates(candidates: readonly TagCandidate[]): TagCounts {
  const counts: TagCounts = { write: 0, unchanged: 0, unsupported: 0, unreadable: 0, unsupportedReasons: {} };
  for (const candidate of candidates) {
    counts[candidate.action] += 1;
    if (candidate.action === 'unsupported' && candidate.reason !== null) {
      counts.unsupportedReasons[candidate.reason] = (counts.unsupportedReasons[candidate.reason] ?? 0) + 1;
    }
  }
  return counts;
}

/** The name of a temporary copy made by an ExifTool write: a hidden file ending in `.plex-tidy-tag.tmp`. */
const LEFTOVER_COPY = /^\..+\.[0-9a-f]{8}\.plex-tidy-tag\.tmp$/;

/**
 * Temporary copies that an interrupted run left behind, in the folders of the
 * renamed files. Only files with the exact name this tool gives its copies.
 */
export async function findLeftoverCopies(plan: Plan): Promise<string[]> {
  const folders = new Set(
    plan.entries.filter((entry) => entry.status === 'applied').map((entry) => win32.dirname(win32.resolve(plan.root, entry.target))),
  );
  const found: string[] = [];
  for (const folder of folders) {
    try {
      for (const name of await readdir(folder)) {
        if (LEFTOVER_COPY.test(name)) {
          found.push(win32.join(folder, name));
        }
      }
    } catch {
      // A folder that cannot be read has no copies this tool can see.
    }
  }
  return found;
}

const WORK_DIR = /^plex-tidy-copy-(\d+)-/;

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

/**
 * Working folders in the system temporary folder whose run is over. A folder
 * is named after the process that made it, so a copy that another run is
 * still building is never touched.
 */
export async function findLeftoverWorkDirs(
  tempRoot: string = tmpdir(),
  isRunning: (pid: number) => boolean = processIsRunning,
): Promise<string[]> {
  try {
    const entries = await readdir(tempRoot, { withFileTypes: true });
    return entries
      .filter((entry) => {
        const pid = entry.isDirectory() ? Number(WORK_DIR.exec(entry.name)?.[1]) : Number.NaN;
        return Number.isInteger(pid) && pid !== process.pid && !isRunning(pid);
      })
      .map((entry) => win32.join(tempRoot, entry.name));
  } catch {
    return [];
  }
}

export interface TagOutcome {
  tagged: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export interface TagDeps {
  root: string;
  journal: Journal;
  backends: Backends;
  /** Called after each entry, so a crash loses at most one entry's status. */
  save: (plan: Plan) => Promise<void>;
  /** Called before the first entry and after each one, with the entries done and the total. */
  onProgress?: (done: number, total: number) => void;
  /** Called while one file is being copied, with the bytes written and the size expected. */
  onCopyProgress?: WriteOptions['onCopyProgress'];
}

/**
 * Applies the candidates. A `write` gets an `intent` line with the previous
 * values before the file changes, and a `done` line after the read-back
 * matches. A rename-only container or an unreadable file is recorded, never
 * an error for the run.
 */
export async function runTagging(plan: Plan, candidates: readonly TagCandidate[], deps: TagDeps): Promise<{ plan: Plan; outcome: TagOutcome }> {
  let current = plan;
  const outcome: TagOutcome = { tagged: 0, unchanged: 0, skipped: 0, failed: 0 };

  deps.onProgress?.(0, candidates.length);
  for (const [index, candidate] of candidates.entries()) {
    const result = await applyCandidate(candidate, deps);
    outcome[result.counter] += 1;
    current = {
      ...current,
      entries: current.entries.map((entry) =>
        entry.id === candidate.entry.id ? { ...entry, tagStatus: result.tagStatus, tagReason: result.reason } : entry,
      ),
    };
    await deps.save(current);
    deps.onProgress?.(index + 1, candidates.length);
  }
  return { plan: current, outcome };
}

interface CandidateResult {
  tagStatus: PlanEntry['tagStatus'];
  reason: string | null;
  counter: keyof TagOutcome;
}

async function applyCandidate(candidate: TagCandidate, deps: TagDeps): Promise<CandidateResult> {
  if (candidate.action === 'unsupported') {
    return { tagStatus: 'tag-skipped', reason: candidate.reason, counter: 'skipped' };
  }
  if (candidate.action === 'unreadable') {
    return { tagStatus: 'tag-failed', reason: candidate.reason, counter: 'failed' };
  }
  if (candidate.action === 'unchanged' || candidate.writer === null || candidate.current === null || candidate.desired === null) {
    return { tagStatus: 'tagged', reason: null, counter: 'unchanged' };
  }

  const intent = await deps.journal.appendIntent(TAG_ACTION, {
    entryId: candidate.entry.id,
    path: candidate.entry.target,
    writer: candidate.writer,
    previous: candidate.current,
    next: candidate.desired,
  });
  try {
    await deps.backends[candidate.writer].write(candidate.file, candidate.desired, {
      ...(deps.onCopyProgress === undefined ? {} : { onCopyProgress: deps.onCopyProgress }),
    });
  } catch (error) {
    if (!isAppError(error)) {
      throw error;
    }
    // These two leave the file as it was. For any other failure the state is unclear, so the intent stays open.
    if (error.code === 'TAG_VERIFY_FAILED' || error.code === 'TAG_NO_SPACE') {
      await deps.journal.appendVoid(intent, `refused: ${error.code}`);
    }
    return { tagStatus: 'tag-failed', reason: error.message, counter: 'failed' };
  }
  await deps.journal.appendDone(intent);
  return { tagStatus: 'tagged', reason: null, counter: 'tagged' };
}
