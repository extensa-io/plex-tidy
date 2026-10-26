import { win32 } from 'node:path';
import { checkPathLength } from '../fs-win/path-checks.ts';
import { sanitizeName } from '../fs-win/sanitize.ts';
import { finalizeTitle } from '../resolve/videos.ts';
import type { ScanFile } from '../scan/schemas.ts';
import type { PathExists } from './build.ts';
import type { Plan, PlanEntry } from './schemas.ts';
import { entrySources, entryTargets, pathKey, targetNames } from './targets.ts';

export type ManualEdit = { ok: true; entry: PlanEntry } | { ok: false; message: string };

/**
 * Applies a title typed by the owner. The new name must be legal on Windows,
 * fit the path limit, and collide with nothing in the plan or on disk.
 */
export async function applyManualTitle(
  plan: Plan,
  entry: PlanEntry,
  typed: string,
  file: Pick<ScanFile, 'path' | 'ext' | 'sidecars'>,
  exists: PathExists,
): Promise<ManualEdit> {
  const title = finalizeTitle(typed);
  if (title === '' || sanitizeName(title) !== title) {
    return { ok: false, message: 'That title is empty or has no characters Windows allows.' };
  }

  const names = targetNames(file, title);
  const candidate: PlanEntry = {
    ...entry,
    ...names,
    title,
    titleSource: 'manual',
    confidence: 'high',
    reason: 'title typed in review',
    status: 'approved',
    collision: false,
  };

  for (const path of entryTargets(candidate)) {
    const length = checkPathLength(win32.join(plan.root, path));
    if (!length.ok) {
      return { ok: false, message: `That name makes a path of ${length.length} characters; the limit is ${length.limit}.` };
    }
  }

  const own = new Set(entrySources(entry).map(pathKey));
  const claimed = new Set(
    plan.entries.filter((other) => other.id !== entry.id).flatMap((other) => [...entryTargets(other), ...entrySources(other)].map(pathKey)),
  );
  for (const path of entryTargets(candidate)) {
    if (claimed.has(pathKey(path))) {
      return { ok: false, message: 'Another file in the plan already uses that name.' };
    }
    if (!own.has(pathKey(path)) && (await exists(win32.join(plan.root, path)))) {
      return { ok: false, message: 'A file with that name already exists.' };
    }
  }
  return { ok: true, entry: candidate };
}
