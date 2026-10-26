import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { AppError, nodeErrorCode } from '../errors.ts';
import {
  JOURNAL_SCHEMA_VERSION,
  journalRecordSchema,
  type JournalDone,
  type JournalIntent,
  type JournalRecord,
  type JournalVoid,
} from './schemas.ts';

export interface JournalContents {
  records: JournalRecord[];
  /** Lines cut off by a crash mid-write. They are not valid JSON and are skipped. */
  partialLines: number;
}

export type IntentOutcome = 'completed' | 'not-started' | 'unknown';

export interface ReconcileItem {
  intent: JournalIntent;
  outcome: IntentOutcome;
}

export interface Journal {
  readonly file: string;
  appendIntent(action: string, data: Record<string, unknown>): Promise<JournalIntent>;
  appendDone(intent: JournalIntent): Promise<JournalDone>;
  appendVoid(intent: JournalIntent, reason: string): Promise<JournalVoid>;
  read(): Promise<JournalContents>;
  unmatchedIntents(): Promise<JournalIntent[]>;
  /** Checks each intent that has no `done` record against the real filesystem. */
  reconcile(check: (intent: JournalIntent) => Promise<IntentOutcome>): Promise<ReconcileItem[]>;
}

export function openJournal(file: string): Journal {
  const read = async (): Promise<JournalContents> => readJournal(file);

  const unmatchedIntents = async (): Promise<JournalIntent[]> => {
    const { records } = await read();
    const closedIds = new Set(records.filter((record) => record.kind !== 'intent').map((record) => record.id));
    return records.filter((record): record is JournalIntent => record.kind === 'intent' && !closedIds.has(record.id));
  };

  return {
    file,
    async appendIntent(action, data) {
      const intent: JournalIntent = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        kind: 'intent',
        id: randomUUID(),
        at: new Date().toISOString(),
        action,
        data,
      };
      await appendRecord(file, intent);
      return intent;
    },
    async appendDone(intent) {
      const done: JournalDone = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        kind: 'done',
        id: intent.id,
        at: new Date().toISOString(),
      };
      await appendRecord(file, done);
      return done;
    },
    async appendVoid(intent, reason) {
      const voided: JournalVoid = {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        kind: 'void',
        id: intent.id,
        at: new Date().toISOString(),
        reason,
      };
      await appendRecord(file, voided);
      return voided;
    },
    read,
    unmatchedIntents,
    async reconcile(check) {
      const intents = await unmatchedIntents();
      const items: ReconcileItem[] = [];
      for (const intent of intents) {
        items.push({ intent, outcome: await check(intent) });
      }
      return items;
    },
  };
}

async function appendRecord(file: string, record: JournalRecord): Promise<void> {
  const line = `${JSON.stringify(journalRecordSchema.parse(record))}\n`;
  try {
    await mkdir(dirname(file), { recursive: true });
    const handle = await open(file, 'a+');
    try {
      // Start on a fresh line if a crash left the previous record unterminated.
      const prefix = (await endsWithNewline(handle)) ? '' : '\n';
      await handle.appendFile(prefix + line, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new AppError('STATE_WRITE_FAILED', `Journal ${basename(file)} could not be written.`, { cause: error });
  }
}

async function endsWithNewline(handle: FileHandle): Promise<boolean> {
  const { size } = await handle.stat();
  if (size === 0) {
    return true;
  }
  const buffer = Buffer.alloc(1);
  await handle.read(buffer, 0, 1, size - 1);
  return buffer[0] === 0x0a;
}

async function readJournal(file: string): Promise<JournalContents> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      return { records: [], partialLines: 0 };
    }
    throw new AppError('STATE_INVALID', `Journal ${basename(file)} could not be read.`, { cause: error });
  }

  const records: JournalRecord[] = [];
  let partialLines = 0;

  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') {
      continue;
    }
    const raw = parseJson(line);
    if (raw === undefined) {
      partialLines += 1;
      continue;
    }
    // Valid JSON that fails the schema is not crash damage; refuse to guess.
    const result = journalRecordSchema.safeParse(raw);
    if (!result.success) {
      throw new AppError('STATE_INVALID', `Journal ${basename(file)} has an invalid record on line ${index + 1}.`, {
        cause: result.error,
      });
    }
    records.push(result.data);
  }

  return { records, partialLines };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
