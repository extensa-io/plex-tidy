import { win32 } from 'node:path';
import { AppError, isAppError } from '../errors.ts';
import { checkPathLength, isInsideRoot, sameVolume } from '../fs-win/path-checks.ts';
import { safeRename } from '../fs-win/safe-rename.ts';
import { isSanitized } from '../fs-win/sanitize.ts';
import type { PathExists } from '../plan/build.ts';
import type { Plan, PlanEntry } from '../plan/schemas.ts';
import { pathKey } from '../plan/targets.ts';
import type { Journal } from '../state/journal.ts';
import { RENAME_ACTION } from './reconcile.ts';

export interface Move {
  entryId: string;
  from: string;
  to: string;
}

export interface PreflightProblem {
  entryId: string;
  message: string;
}

/** The renames for one entry: the video first, then each sidecar. Names that do not change are left out. */
export function movesFor(entry: PlanEntry): Move[] {
  return [
    { entryId: entry.id, from: entry.source, to: entry.target },
    ...entry.sidecars.map((sidecar) => ({ entryId: entry.id, from: sidecar.source, to: sidecar.target })),
  ].filter((move) => move.from !== move.to);
}

export function approvedEntries(plan: Plan): PlanEntry[] {
  return plan.entries.filter((entry) => entry.status === 'approved');
}

/**
 * Checks every approved rename before any file changes. A single problem
 * refuses the whole plan: a path outside the root, another volume, a path over
 * the limit, an illegal name, a missing source, a target that already
 * exists, or a target shared by two renames.
 */
export async function preflight(
  plan: Plan,
  exists: PathExists,
  onProgress?: (done: number, total: number) => void,
): Promise<PreflightProblem[]> {
  const problems: PreflightProblem[] = [];
  const claimed = new Map<string, string>();

  const approved = approvedEntries(plan);
  for (const [index, entry] of approved.entries()) {
    onProgress?.(index + 1, approved.length);
    for (const move of movesFor(entry)) {
      // `resolve`, not `join`: a crafted absolute path must show up as what it is.
      const from = win32.resolve(plan.root, move.from);
      const to = win32.resolve(plan.root, move.to);
      const problem = (message: string) => problems.push({ entryId: entry.id, message });

      if (!sameVolume(plan.root, from) || !sameVolume(plan.root, to)) {
        problem('the rename would cross volumes');
        continue;
      }
      if (!isInsideRoot(plan.root, from) || !isInsideRoot(plan.root, to)) {
        problem('a path is outside the library root');
        continue;
      }
      if (!checkPathLength(to).ok) {
        problem('the target path is over the length limit');
      }
      if (!isSanitized(win32.basename(to))) {
        problem('the target name is not legal on Windows');
      }
      if (!(await exists(from))) {
        problem('the source file does not exist');
      }
      const caseOnly = pathKey(move.from) === pathKey(move.to);
      if (!caseOnly && (await exists(to))) {
        problem('the target already exists');
      }
      const owner = claimed.get(pathKey(move.to));
      if (owner !== undefined) {
        problem('another rename has the same target');
      }
      claimed.set(pathKey(move.to), entry.id);
    }
  }
  return problems;
}

export interface ApplyOutcome {
  applied: number;
  failed: number;
  renames: number;
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
 * Renames every approved entry. Each rename writes an `intent` line before
 * and a `done` line after. An entry that fails is marked `failed` and the
 * run goes on with the next entry.
 */
export async function applyPlan(plan: Plan, deps: ApplyDeps): Promise<{ plan: Plan; outcome: ApplyOutcome }> {
  let current = plan;
  const outcome: ApplyOutcome = { applied: 0, failed: 0, renames: 0 };

  const approved = approvedEntries(plan);
  deps.onProgress?.(0, approved.length);
  for (const [index, entry] of approved.entries()) {
    const result = await applyEntry(entry, deps);
    outcome.renames += result.renames;
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
  deps: ApplyDeps,
): Promise<{ status: 'applied' | 'failed'; renames: number; reason?: string }> {
  let renames = 0;
  for (const move of movesFor(entry)) {
    const intent = await deps.journal.appendIntent(RENAME_ACTION, { entryId: move.entryId, from: move.from, to: move.to });
    try {
      await safeRename(deps.root, win32.resolve(deps.root, move.from), win32.resolve(deps.root, move.to));
    } catch (error) {
      if (!isAppError(error)) {
        throw error;
      }
      // Every refusal except RENAME_FAILED happens before the filesystem changes.
      if (error.code !== 'RENAME_FAILED') {
        await deps.journal.appendVoid(intent, `refused: ${error.code}`);
      }
      return { status: 'failed', renames, reason: `rename refused (${error.code}) after ${renames} of ${movesFor(entry).length} renames` };
    }
    await deps.journal.appendDone(intent);
    renames += 1;
  }
  return { status: 'applied', renames };
}

export function requireNoProblems(problems: readonly PreflightProblem[]): void {
  if (problems.length > 0) {
    throw new AppError(
      'PREFLIGHT_FAILED',
      `${problems.length} problem${problems.length === 1 ? '' : 's'} found before any rename. Nothing was changed. Run with --verbose to see them.`,
    );
  }
}
