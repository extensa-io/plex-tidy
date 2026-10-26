import { win32 } from 'node:path';
import { z } from 'zod';
import type { PathExists } from '../plan/build.ts';
import type { IntentOutcome, Journal } from '../state/journal.ts';

export const RENAME_ACTION = 'rename';
export const UNDO_RENAME_ACTION = 'undo-rename';

export const renameDataSchema = z.object({
  entryId: z.string().min(1),
  /** Paths are relative to the root. */
  from: z.string().min(1),
  to: z.string().min(1),
});

export const undoRenameDataSchema = renameDataSchema.extend({
  /** The id of the journal intent that this undo reverses. */
  undoes: z.uuid(),
});

export interface ReconcileSummary {
  /** Intents with no `done` record: the rename finished before the crash. */
  completed: number;
  /** Intents with no `done` record: the rename never started. */
  notStarted: number;
  /** Intents where neither name exists, or both do. Left open for the owner to check. */
  unknown: number;
}

/**
 * Looks at each intent that has no `done` record and compares it with the
 * real filesystem. With `write` set, a finished rename gets its `done`
 * record and a rename that never started gets a `void` record. Without it,
 * the journal stays untouched.
 */
export async function reconcileJournal(
  journal: Journal,
  root: string,
  exists: PathExists,
  write: boolean,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { completed: 0, notStarted: 0, unknown: 0 };
  const items = await journal.reconcile(async (intent): Promise<IntentOutcome> => {
    const data = renameDataSchema.safeParse(intent.data);
    if (!data.success) {
      return 'unknown';
    }
    const fromExists = await exists(win32.join(root, data.data.from));
    const toExists = await exists(win32.join(root, data.data.to));
    if (toExists && !fromExists) {
      return 'completed';
    }
    return fromExists && !toExists ? 'not-started' : 'unknown';
  });

  for (const { intent, outcome } of items) {
    if (outcome === 'completed') {
      summary.completed += 1;
      if (write) {
        await journal.appendDone(intent);
      }
    } else if (outcome === 'not-started') {
      summary.notStarted += 1;
      if (write) {
        await journal.appendVoid(intent, 'reconciled: the rename never started');
      }
    } else {
      summary.unknown += 1;
    }
  }
  return summary;
}
