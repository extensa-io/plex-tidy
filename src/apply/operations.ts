import { win32 } from 'node:path';
import type { Plan, PlanEntry } from '../plan/schemas.ts';
import { pathKey } from '../plan/targets.ts';

/** A folder rename or a file rename, relative to the root. */
export interface RenameOperation {
  kind: 'rename';
  entryId: string;
  from: string;
  to: string;
}

/** A folder the tool creates. It is created only when it does not exist, and `undo` removes it again when it is empty. */
export interface MkdirOperation {
  kind: 'mkdir';
  entryId: string;
  path: string;
}

export type Operation = RenameOperation | MkdirOperation;

/** The folders from the root down to `path`, outermost first. */
function chain(path: string): string[] {
  const parts = path.split('\\').filter((part) => part !== '');
  return parts.map((_, index) => parts.slice(0, index + 1).join('\\'));
}

function isAncestorOrSelf(ancestor: string, path: string): boolean {
  const a = pathKey(ancestor);
  const p = pathKey(path);
  return p === a || p.startsWith(`${a}\\`);
}

/**
 * Entries that share a folder rename form a group. The folder is renamed in
 * place only when every entry of the group is approved and no other group
 * renames to the same name. Otherwise the approved files move one by one
 * into folders that are created.
 */
function renamesInPlace(entry: PlanEntry, plan: Plan): boolean {
  const folder = entry.folder;
  if (folder === null) {
    return false;
  }
  const sameSource = plan.entries.filter((other) => other.folder !== null && pathKey(other.folder.source) === pathKey(folder.source));
  const sameTarget = plan.entries.filter((other) => other.folder !== null && pathKey(other.folder.target) === pathKey(folder.target));
  const otherSources = new Set(sameTarget.map((other) => pathKey(other.folder?.source ?? '')));
  return sameSource.every((other) => other.status === 'approved') && otherSources.size === 1;
}

/**
 * Every operation for the approved entries, in the order they run: for each
 * entry its folders and file renames, and a folder rename after the last
 * entry of its group. Operations that would repeat are left out.
 */
export function planOperations(plan: Plan): Operation[] {
  const approved = plan.entries.filter((entry) => entry.status === 'approved');
  const operations: Operation[] = [];
  const made = new Set<string>();

  const lastOfGroup = new Map<string, string>();
  for (const entry of approved) {
    if (entry.folder !== null && renamesInPlace(entry, plan)) {
      lastOfGroup.set(pathKey(entry.folder.source), entry.id);
    }
  }

  for (const entry of approved) {
    const sourceDir = win32.dirname(entry.source);
    const inPlace = entry.folder !== null && renamesInPlace(entry, plan);
    // Where the files go first. With an in-place folder rename that is inside the old folder.
    const destinationDir = win32.dirname(entry.target);
    const workDir =
      entry.folder !== null && inPlace
        ? win32.join(entry.folder.source, win32.relative(entry.folder.target, destinationDir))
        : destinationDir;

    // A target that leaves the root or names another drive gets no folders. Its rename is refused by the checks.
    const escapes = workDir.split('\\').includes('..') || win32.isAbsolute(workDir);
    for (const dir of escapes ? [] : chain(workDir)) {
      const key = pathKey(dir);
      // Folders the file already sits in, and the ones above them, exist.
      if (!made.has(key) && !isAncestorOrSelf(dir, sourceDir) && (entry.folder === null || !inPlace || !isAncestorOrSelf(dir, entry.folder.source))) {
        made.add(key);
        operations.push({ kind: 'mkdir', entryId: entry.id, path: dir });
      }
    }

    const moves = [
      { from: entry.source, to: win32.join(workDir, win32.basename(entry.target)) },
      ...entry.sidecars.map((sidecar) => ({ from: sidecar.source, to: win32.join(workDir, win32.basename(sidecar.target)) })),
    ];
    for (const move of moves) {
      if (move.from !== move.to) {
        operations.push({ kind: 'rename', entryId: entry.id, ...move });
      }
    }

    if (entry.folder !== null && inPlace && lastOfGroup.get(pathKey(entry.folder.source)) === entry.id && entry.folder.source !== entry.folder.target) {
      operations.push({ kind: 'rename', entryId: entry.id, from: entry.folder.source, to: entry.folder.target });
    }
  }
  return operations;
}

/** The operations of one entry, in order. */
export function operationsOf(operations: readonly Operation[], entryId: string): Operation[] {
  return operations.filter((operation) => operation.entryId === entryId);
}
