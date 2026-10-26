import { win32 } from 'node:path';
import { z } from 'zod';
import type { PathExists } from '../plan/build.ts';
import type { IntentOutcome, Journal } from '../state/journal.ts';
import type { JournalIntent } from '../state/schemas.ts';

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
  /** Intents with no `done` record: the operation finished before the crash. */
  completed: number;
  /** Intents with no `done` record: the operation never started. */
  notStarted: number;
  /** Intents the checker could not place. Left open for the owner to check. */
  unknown: number;
}

/**
 * Looks at the real filesystem for one unfinished intent. Returns `undefined`
 * for an action this checker does not know, so another checker can answer.
 */
export type IntentChecker = (intent: JournalIntent) => Promise<IntentOutcome | undefined>;

/** Checks `rename` and `undo-rename` intents: the old name is still there, or only the new name is. */
export function renameChecker(root: string, exists: PathExists): IntentChecker {
  return async (intent) => {
    if (intent.action !== RENAME_ACTION && intent.action !== UNDO_RENAME_ACTION) {
      return undefined;
    }
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
  };
}

/** Asks each checker in turn. An action no checker knows is `unknown`. */
export function composeCheckers(...checkers: readonly IntentChecker[]): (intent: JournalIntent) => Promise<IntentOutcome> {
  return async (intent) => {
    for (const checker of checkers) {
      const outcome = await checker(intent);
      if (outcome !== undefined) {
        return outcome;
      }
    }
    return 'unknown';
  };
}

/**
 * Compares each intent that has no `done` record with the real files. With
 * `write` set, a finished operation gets its `done` record and one that never
 * started gets a `void` record. Without it, the journal stays untouched.
 */
export async function reconcileJournal(
  journal: Journal,
  check: (intent: JournalIntent) => Promise<IntentOutcome>,
  write: boolean,
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { completed: 0, notStarted: 0, unknown: 0 };
  for (const { intent, outcome } of await journal.reconcile(check)) {
    if (outcome === 'completed') {
      summary.completed += 1;
      if (write) {
        await journal.appendDone(intent);
      }
    } else if (outcome === 'not-started') {
      summary.notStarted += 1;
      if (write) {
        await journal.appendVoid(intent, 'reconciled: the operation never started');
      }
    } else {
      summary.unknown += 1;
    }
  }
  return summary;
}
