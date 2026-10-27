import { win32 } from 'node:path';
import {
  MKDIR_ACTION,
  RENAME_ACTION,
  UNDO_MKDIR_ACTION,
  UNDO_RENAME_ACTION,
  mkdirDataSchema,
  renameDataSchema,
  undoMkdirDataSchema,
  undoRenameDataSchema,
} from '../apply/reconcile.ts';
import { isAppError } from '../errors.ts';
import { removeEmptyFolder } from '../fs-win/safe-mkdir.ts';
import { safeRename } from '../fs-win/safe-rename.ts';
import type { Plan } from '../plan/schemas.ts';
import type { Journal } from '../state/journal.ts';
import type { JournalIntent } from '../state/schemas.ts';
import type { Backends } from '../tag/backends.ts';
import { snapshotSatisfies } from '../tag/fields.ts';
import {
  TAG_ACTION,
  UNDO_TAG_ACTION,
  tagIntentDataSchema,
  undoTagIntentDataSchema,
  type TagSnapshot,
  type Writer,
} from '../tag/schemas.ts';

export type UndoKind = 'rename' | 'tag';

export interface RenameStep {
  kind: 'rename';
  /** The journal intent for the rename being reversed. */
  intentId: string;
  entryId: string;
  /** Current name, to be renamed back. */
  from: string;
  /** Original name. */
  to: string;
}

export interface TagStep {
  kind: 'tag';
  intentId: string;
  entryId: string;
  /** Path relative to the root, as it was when the file was tagged. */
  path: string;
  writer: Writer;
  /** The values the file had before it was tagged. */
  restore: TagSnapshot;
  /** The values the tool wrote. */
  written: TagSnapshot;
}

export interface MkdirStep {
  kind: 'mkdir';
  intentId: string;
  entryId: string;
  /** The folder the tool created, relative to the root. It is removed only when it is empty. */
  path: string;
}

export type UndoStep = RenameStep | TagStep | MkdirStep;

/**
 * Finds the operations that finished (`done`) and have not been reversed,
 * newest first, so tags unwind before the renames they followed. `only`
 * limits the result to renames or to tags.
 */
export async function planUndo(journal: Journal, only?: UndoKind): Promise<UndoStep[]> {
  const { records } = await journal.read();
  const finished = new Set(records.filter((record) => record.kind === 'done').map((record) => record.id));

  const reversed = new Set<string>();
  const operations: JournalIntent[] = [];
  for (const record of records) {
    if (record.kind !== 'intent' || !finished.has(record.id)) {
      continue;
    }
    if (record.action === UNDO_RENAME_ACTION) {
      const data = undoRenameDataSchema.safeParse(record.data);
      if (data.success) {
        reversed.add(data.data.undoes);
      }
    } else if (record.action === UNDO_TAG_ACTION) {
      const data = undoTagIntentDataSchema.safeParse(record.data);
      if (data.success) {
        reversed.add(data.data.undoes);
      }
    } else if (record.action === UNDO_MKDIR_ACTION) {
      const data = undoMkdirDataSchema.safeParse(record.data);
      if (data.success) {
        reversed.add(data.data.undoes);
      }
    } else if (record.action === RENAME_ACTION || record.action === TAG_ACTION || record.action === MKDIR_ACTION) {
      operations.push(record);
    }
  }

  const steps: UndoStep[] = [];
  for (const intent of operations.reverse()) {
    if (reversed.has(intent.id)) {
      continue;
    }
    if (intent.action === MKDIR_ACTION && only !== 'tag') {
      const data = mkdirDataSchema.safeParse(intent.data);
      if (data.success) {
        steps.push({ kind: 'mkdir', intentId: intent.id, entryId: data.data.entryId, path: data.data.path });
      }
    } else if (intent.action === RENAME_ACTION && only !== 'tag') {
      const data = renameDataSchema.safeParse(intent.data);
      if (data.success) {
        steps.push({ kind: 'rename', intentId: intent.id, entryId: data.data.entryId, from: data.data.to, to: data.data.from });
      }
    } else if (intent.action === TAG_ACTION && only !== 'rename') {
      const data = tagIntentDataSchema.safeParse(intent.data);
      if (data.success) {
        steps.push({
          kind: 'tag',
          intentId: intent.id,
          entryId: data.data.entryId,
          path: data.data.path,
          writer: data.data.writer,
          restore: data.data.previous,
          written: data.data.next,
        });
      }
    }
  }
  return steps;
}

export interface UndoOutcome {
  restored: number;
  failed: number;
  /** Entries with at least one reversed rename. */
  restoredRenames: Set<string>;
  /** Entries whose tags were put back. */
  restoredTags: Set<string>;
  /** Folders the tool created that still hold something, so they were left in place. */
  keptFolders: number;
}

export interface UndoDeps {
  root: string;
  journal: Journal;
  /** Needed only when there are tag steps. */
  backends?: Backends;
  /** Called after each step, with the steps done and the total. */
  onProgress?: (done: number, total: number) => void;
}

export async function undoSteps(steps: readonly UndoStep[], deps: UndoDeps): Promise<UndoOutcome> {
  const outcome: UndoOutcome = { restored: 0, failed: 0, restoredRenames: new Set(), restoredTags: new Set(), keptFolders: 0 };
  deps.onProgress?.(0, steps.length);
  for (const [index, step] of steps.entries()) {
    if (step.kind === 'mkdir') {
      const removed = await undoMkdir(step, deps);
      if (removed === 'kept') {
        outcome.keptFolders += 1;
      } else if (removed === 'removed') {
        outcome.restored += 1;
      } else {
        outcome.failed += 1;
      }
      deps.onProgress?.(index + 1, steps.length);
      continue;
    }
    const succeeded = step.kind === 'rename' ? await undoRename(step, deps) : await undoTag(step, deps);
    if (succeeded) {
      outcome.restored += 1;
      (step.kind === 'rename' ? outcome.restoredRenames : outcome.restoredTags).add(step.entryId);
    } else {
      outcome.failed += 1;
    }
    deps.onProgress?.(index + 1, steps.length);
  }
  return outcome;
}

/**
 * Removes a folder the tool created, only when it is empty. A folder that
 * holds something is kept and is not an error.
 */
async function undoMkdir(step: MkdirStep, deps: UndoDeps): Promise<'removed' | 'kept' | 'failed'> {
  const intent = await deps.journal.appendIntent(UNDO_MKDIR_ACTION, { entryId: step.entryId, path: step.path, undoes: step.intentId });
  try {
    const removed = await removeEmptyFolder(deps.root, win32.resolve(deps.root, step.path));
    await deps.journal.appendDone(intent);
    return removed ? 'removed' : 'kept';
  } catch (error) {
    if (!isAppError(error)) {
      throw error;
    }
    return 'failed';
  }
}

async function undoRename(step: RenameStep, deps: UndoDeps): Promise<boolean> {
  const intent = await deps.journal.appendIntent(UNDO_RENAME_ACTION, {
    entryId: step.entryId,
    from: step.from,
    to: step.to,
    undoes: step.intentId,
  });
  try {
    await safeRename(deps.root, win32.resolve(deps.root, step.from), win32.resolve(deps.root, step.to));
  } catch (error) {
    if (!isAppError(error)) {
      throw error;
    }
    if (error.code !== 'RENAME_FAILED') {
      await deps.journal.appendVoid(intent, `refused: ${error.code}`);
    }
    return false;
  }
  await deps.journal.appendDone(intent);
  return true;
}

async function undoTag(step: TagStep, deps: UndoDeps): Promise<boolean> {
  const backend = deps.backends?.[step.writer];
  if (backend === undefined) {
    return false;
  }
  const file = win32.resolve(deps.root, step.path);
  const intent = await deps.journal.appendIntent(UNDO_TAG_ACTION, {
    entryId: step.entryId,
    path: step.path,
    writer: step.writer,
    previous: step.written,
    next: step.restore,
    undoes: step.intentId,
  });
  try {
    const current = await backend.read(file, Object.keys(step.restore.fields));
    if (!snapshotSatisfies(current, step.restore)) {
      await backend.write(file, step.restore);
    }
  } catch (error) {
    if (!isAppError(error)) {
      throw error;
    }
    if (error.code === 'TAG_VERIFY_FAILED' || error.code === 'TAG_NO_SPACE') {
      await deps.journal.appendVoid(intent, `refused: ${error.code}`);
    }
    return false;
  }
  await deps.journal.appendDone(intent);
  return true;
}

/**
 * Entries whose renames were reversed go back to `approved`, so the plan can
 * run again. Entries whose tags were restored go back to `untagged`.
 */
export function markUndone(plan: Plan, renamed: ReadonlySet<string>, tagged: ReadonlySet<string> = new Set()): Plan {
  return {
    ...plan,
    entries: plan.entries.map((entry) => {
      let updated = entry;
      if (renamed.has(entry.id) && (entry.status === 'applied' || entry.status === 'failed')) {
        updated = { ...updated, status: 'approved' };
      }
      if (tagged.has(entry.id)) {
        updated = { ...updated, tagStatus: 'untagged', tagReason: null };
      }
      return updated;
    }),
  };
}
