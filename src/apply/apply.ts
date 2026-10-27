import { win32 } from 'node:path';
import { AppError, isAppError } from '../errors.ts';
import { pathExists } from '../fs-win/exists.ts';
import { checkPathLength, isInsideRoot, sameVolume } from '../fs-win/path-checks.ts';
import { safeMkdir } from '../fs-win/safe-mkdir.ts';
import { safeRename } from '../fs-win/safe-rename.ts';
import { isSanitized } from '../fs-win/sanitize.ts';
import type { PathExists } from '../plan/build.ts';
import type { Plan, PlanEntry } from '../plan/schemas.ts';
import { pathKey } from '../plan/targets.ts';
import type { Journal } from '../state/journal.ts';
import { operationsOf, planOperations, type Operation } from './operations.ts';
import { MKDIR_ACTION, RENAME_ACTION } from './reconcile.ts';

export interface Move {
  entryId: string;
  from: string;
  to: string;
}

export interface PreflightProblem {
  entryId: string;
  message: string;
}

/**
 * The renames for one entry alone: the video first, then each sidecar, then
 * the folder. Files are renamed inside the old folder, so the folder rename is
 * the last step. Names that do not change are left out. Apply uses
 * `planOperations`, which also knows about the other entries of a folder.
 */
export function movesFor(entry: PlanEntry): Move[] {
  const insideOldFolder = (path: string): string =>
    entry.folder === null ? path : win32.join(entry.folder.source, win32.basename(path));
  const moves: Move[] = [
    { entryId: entry.id, from: entry.source, to: insideOldFolder(entry.target) },
    ...entry.sidecars.map((sidecar) => ({
      entryId: entry.id,
      from: sidecar.source,
      to: insideOldFolder(sidecar.target),
    })),
  ];
  if (entry.folder !== null) {
    moves.push({ entryId: entry.id, from: entry.folder.source, to: entry.folder.target });
  }
  return moves.filter((move) => move.from !== move.to);
}

export function approvedEntries(plan: Plan): PlanEntry[] {
  return plan.entries.filter((entry) => entry.status === 'approved');
}

/** The renames among the operations, as moves. */
export function movesOf(operations: readonly Operation[]): Move[] {
  return operations.flatMap((operation) =>
    operation.kind === 'rename' ? [{ entryId: operation.entryId, from: operation.from, to: operation.to }] : [],
  );
}

/**
 * Checks every operation for the approved entries before any file changes. A
 * single problem refuses the whole plan: a path outside the root, another
 * volume, a path over the limit, an illegal name, a missing source, a target
 * that already exists, or a target shared by two renames.
 */
export async function preflight(
  plan: Plan,
  exists: PathExists,
  onProgress?: (done: number, total: number) => void,
): Promise<PreflightProblem[]> {
  const problems: PreflightProblem[] = [];
  const claimed = new Map<string, string>();
  const operations = planOperations(plan);
  // Progress counts entries, as the owner sees them, not single operations.
  const entryIds = approvedEntries(plan).map((entry) => entry.id);
  let checked = 0;
  onProgress?.(0, entryIds.length);

  for (const [index, operation] of operations.entries()) {
    const path = operation.kind === 'rename' ? operation.to : operation.path;
    // `resolve`, not `join`: a crafted absolute path must show up as what it is.
    const to = win32.resolve(plan.root, path);
    const problem = (message: string) => problems.push({ entryId: operation.entryId, message });
    const lastOfEntry = operations[index + 1]?.entryId !== operation.entryId;
    const finish = () => {
      if (lastOfEntry) {
        checked += 1;
        onProgress?.(checked, entryIds.length);
      }
    };

    if (!sameVolume(plan.root, to) || (operation.kind === 'rename' && !sameVolume(plan.root, win32.resolve(plan.root, operation.from)))) {
      problem(operation.kind === 'rename' ? 'the rename would cross volumes' : 'a folder would be on another volume');
      finish();
      continue;
    }
    if (!isInsideRoot(plan.root, to) || (operation.kind === 'rename' && !isInsideRoot(plan.root, win32.resolve(plan.root, operation.from)))) {
      problem('a path is outside the library root');
      finish();
      continue;
    }
    if (!checkPathLength(to).ok) {
      problem('the target path is over the length limit');
    }
    if (!isSanitized(win32.basename(to))) {
      problem('the target name is not legal on Windows');
    }

    if (operation.kind === 'mkdir') {
      finish();
      continue;
    }
    const from = win32.resolve(plan.root, operation.from);
    if (!(await exists(from))) {
      problem('the source file does not exist');
    }
    const caseOnly = pathKey(operation.from) === pathKey(operation.to);
    if (!caseOnly && (await exists(to))) {
      problem('the target already exists');
    }
    const owner = claimed.get(pathKey(operation.to));
    if (owner !== undefined) {
      problem('another rename has the same target');
    }
    claimed.set(pathKey(operation.to), operation.entryId);
    finish();
  }
  return problems;
}

export interface ApplyOutcome {
  applied: number;
  failed: number;
  renames: number;
  /** Folders the run created. */
  folders: number;
}

export interface ApplyDeps {
  root: string;
  journal: Journal;
  /** Called after each entry so a crash loses at most one entry's status. */
  save: (plan: Plan) => Promise<void>;
  /** Called after each entry, with the entries done and the total. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Runs the operations of every approved entry. Each folder and each rename
 * writes an `intent` line before and a `done` line after. An entry that fails
 * is marked `failed` and the run goes on with the next entry. A folder is
 * renamed only when every file in it was moved.
 */
export async function applyPlan(plan: Plan, deps: ApplyDeps): Promise<{ plan: Plan; outcome: ApplyOutcome }> {
  let current = plan;
  const outcome: ApplyOutcome = { applied: 0, failed: 0, renames: 0, folders: 0 };
  const operations = planOperations(plan);
  // Folders whose files did not all move. They are not renamed.
  const brokenFolders = new Set<string>();

  const approved = approvedEntries(plan);
  deps.onProgress?.(0, approved.length);
  for (const [index, entry] of approved.entries()) {
    const result = await applyEntry(entry, operationsOf(operations, entry.id), deps, brokenFolders, outcome);
    outcome.applied += result.status === 'applied' ? 1 : 0;
    outcome.failed += result.status === 'failed' ? 1 : 0;
    current = {
      ...current,
      entries: current.entries.map((other) =>
        other.id === entry.id ? { ...other, status: result.status, reason: result.reason ?? other.reason } : other,
      ),
    };
    await deps.save(current);
    deps.onProgress?.(index + 1, approved.length);
  }
  return { plan: current, outcome };
}

async function applyEntry(
  entry: PlanEntry,
  operations: readonly Operation[],
  deps: ApplyDeps,
  brokenFolders: Set<string>,
  outcome: ApplyOutcome,
): Promise<{ status: 'applied' | 'failed'; reason?: string }> {
  let done = 0;
  for (const operation of operations) {
    const isFolderRename =
      operation.kind === 'rename' && entry.folder !== null && pathKey(operation.from) === pathKey(entry.folder.source);
    if (isFolderRename && entry.folder !== null && brokenFolders.has(pathKey(entry.folder.source))) {
      return { status: 'failed', reason: 'the folder was not renamed because some of its files did not move' };
    }

    const failure = await runOperation(operation, deps, outcome);
    if (failure !== undefined) {
      if (entry.folder !== null) {
        brokenFolders.add(pathKey(entry.folder.source));
      }
      return { status: 'failed', reason: `refused (${failure}) after ${done} of ${operations.length} operations` };
    }
    done += 1;
  }
  return { status: 'applied' };
}

/** Runs one operation with its journal lines. Returns the error code when the operation was refused or failed. */
async function runOperation(operation: Operation, deps: ApplyDeps, outcome: ApplyOutcome): Promise<string | undefined> {
  if (operation.kind === 'mkdir') {
    const absolute = win32.resolve(deps.root, operation.path);
    // A folder that is already there is not the tool's to remove later, so it gets no journal line.
    if (await pathExists(absolute)) {
      try {
        await safeMkdir(deps.root, absolute);
        return undefined;
      } catch (error) {
        return isAppError(error) ? error.code : 'MKDIR_FAILED';
      }
    }
    const intent = await deps.journal.appendIntent(MKDIR_ACTION, { entryId: operation.entryId, path: operation.path });
    try {
      await safeMkdir(deps.root, absolute);
    } catch (error) {
      if (!isAppError(error)) {
        throw error;
      }
      if (error.code !== 'MKDIR_FAILED') {
        await deps.journal.appendVoid(intent, `refused: ${error.code}`);
      }
      return error.code;
    }
    await deps.journal.appendDone(intent);
    outcome.folders += 1;
    return undefined;
  }

  const intent = await deps.journal.appendIntent(RENAME_ACTION, {
    entryId: operation.entryId,
    from: operation.from,
    to: operation.to,
  });
  try {
    await safeRename(deps.root, win32.resolve(deps.root, operation.from), win32.resolve(deps.root, operation.to));
  } catch (error) {
    if (!isAppError(error)) {
      throw error;
    }
    // Every refusal except RENAME_FAILED happens before the filesystem changes.
    if (error.code !== 'RENAME_FAILED') {
      await deps.journal.appendVoid(intent, `refused: ${error.code}`);
    }
    return error.code;
  }
  await deps.journal.appendDone(intent);
  outcome.renames += 1;
  return undefined;
}

export function requireNoProblems(problems: readonly PreflightProblem[]): void {
  if (problems.length > 0) {
    throw new AppError(
      'PREFLIGHT_FAILED',
      `${problems.length} problem${problems.length === 1 ? '' : 's'} found before any rename. Nothing was changed. Run with --verbose to see them.`,
    );
  }
}
