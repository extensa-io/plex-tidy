import { win32 } from 'node:path';
import { RENAME_ACTION, UNDO_RENAME_ACTION, renameDataSchema, undoRenameDataSchema } from '../apply/reconcile.ts';
import { isAppError } from '../errors.ts';
import { safeRename } from '../fs-win/safe-rename.ts';
import type { Plan } from '../plan/schemas.ts';
import type { Journal } from '../state/journal.ts';
import type { JournalIntent } from '../state/schemas.ts';

export interface UndoStep {
  /** The journal intent for the rename being reversed. */
  intentId: string;
  entryId: string;
  /** Current name, to be renamed back. */
  from: string;
  /** Original name. */
  to: string;
}

/**
 * Finds the renames that finished (`done`) and have not been reversed yet,
 * newest first, so folders and files unwind in the opposite order.
 */
export async function planUndo(journal: Journal): Promise<UndoStep[]> {
  const { records } = await journal.read();
  const finished = new Set(records.filter((record) => record.kind === 'done').map((record) => record.id));

  const reversed = new Set<string>();
  const renames: JournalIntent[] = [];
  for (const record of records) {
    if (record.kind !== 'intent' || !finished.has(record.id)) {
      continue;
    }
    if (record.action === UNDO_RENAME_ACTION) {
      const data = undoRenameDataSchema.safeParse(record.data);
      if (data.success) {
        reversed.add(data.data.undoes);
      }
    } else if (record.action === RENAME_ACTION) {
      renames.push(record);
    }
  }

  const steps: UndoStep[] = [];
  for (const intent of renames.reverse()) {
    const data = renameDataSchema.safeParse(intent.data);
    if (data.success && !reversed.has(intent.id)) {
      steps.push({ intentId: intent.id, entryId: data.data.entryId, from: data.data.to, to: data.data.from });
    }
  }
  return steps;
}

export interface UndoOutcome {
  restored: number;
  failed: number;
  /** Entries with at least one restored rename. */
  restoredEntries: Set<string>;
}

export async function undoRenames(steps: readonly UndoStep[], root: string, journal: Journal): Promise<UndoOutcome> {
  const outcome: UndoOutcome = { restored: 0, failed: 0, restoredEntries: new Set() };
  for (const step of steps) {
    const intent = await journal.appendIntent(UNDO_RENAME_ACTION, {
      entryId: step.entryId,
      from: step.from,
      to: step.to,
      undoes: step.intentId,
    });
    try {
      await safeRename(root, win32.resolve(root, step.from), win32.resolve(root, step.to));
    } catch (error) {
      if (!isAppError(error)) {
        throw error;
      }
      if (error.code !== 'RENAME_FAILED') {
        await journal.appendVoid(intent, `refused: ${error.code}`);
      }
      outcome.failed += 1;
      continue;
    }
    await journal.appendDone(intent);
    outcome.restored += 1;
    outcome.restoredEntries.add(step.entryId);
  }
  return outcome;
}

/** Entries whose renames were reversed go back to `approved`, so the plan can run again. */
export function markUndone(plan: Plan, entryIds: ReadonlySet<string>): Plan {
  return {
    ...plan,
    entries: plan.entries.map((entry) =>
      entryIds.has(entry.id) && (entry.status === 'applied' || entry.status === 'failed')
        ? { ...entry, status: 'approved' }
        : entry,
    ),
  };
}
