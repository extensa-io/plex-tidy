import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openJournal } from '../../src/state/journal.ts';
import { useTempDirs } from '../helpers/temp-dir.ts';

const makeTempDir = useTempDirs();

async function journalFile(): Promise<string> {
  return join(await makeTempDir(), 'videos', 'abc123', 'journal.jsonl');
}

describe('journal', () => {
  it('reads an empty journal when the file does not exist', async () => {
    const journal = openJournal(await journalFile());
    expect(await journal.read()).toEqual({ records: [], partialLines: 0 });
    expect(await journal.unmatchedIntents()).toEqual([]);
  });

  it('appends intent and done records as one JSON object per line', async () => {
    const file = await journalFile();
    const journal = openJournal(file);
    const intent = await journal.appendIntent('rename', { from: 'a.mkv', to: 'A.mkv' });
    await journal.appendDone(intent);

    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ kind: 'intent', id: intent.id, schemaVersion: 1 });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ kind: 'done', id: intent.id, schemaVersion: 1 });
    expect(await journal.unmatchedIntents()).toEqual([]);
  });

  it('finds an intent without a done record and reconciles it against a check', async () => {
    const journal = openJournal(await journalFile());
    const finished = await journal.appendIntent('rename', { from: 'one.mkv', to: 'One.mkv' });
    await journal.appendDone(finished);
    // Simulates a crash between the intent and the done record.
    const interrupted = await journal.appendIntent('rename', { from: 'two.mkv', to: 'Two.mkv' });

    expect((await journal.unmatchedIntents()).map((intent) => intent.id)).toEqual([interrupted.id]);

    const checked: string[] = [];
    const report = await journal.reconcile((intent) => {
      checked.push(intent.id);
      return Promise.resolve('completed');
    });
    expect(checked).toEqual([interrupted.id]);
    expect(report).toEqual([{ intent: interrupted, outcome: 'completed' }]);
  });

  it('skips a line cut off by a crash and starts the next record on a fresh line', async () => {
    const file = await journalFile();
    const journal = openJournal(file);
    const first = await journal.appendIntent('rename', { from: 'one.mkv', to: 'One.mkv' });
    await appendFile(file, '{"schemaVersion":1,"kind":"do');

    expect(await journal.read()).toMatchObject({ partialLines: 1 });

    await journal.appendDone(first);
    const contents = await journal.read();
    expect(contents.partialLines).toBe(1);
    expect(contents.records.map((record) => record.kind)).toEqual(['intent', 'done']);
    expect(await journal.unmatchedIntents()).toEqual([]);
  });

  it('rejects a line that is valid JSON but not a journal record', async () => {
    const file = await journalFile();
    const journal = openJournal(file);
    await journal.appendIntent('rename', { from: 'one.mkv', to: 'One.mkv' });
    await writeFile(file, `${await readFile(file, 'utf8')}{"kind":"unknown"}\n`);

    await expect(journal.read()).rejects.toMatchObject({ code: 'STATE_INVALID' });
  });
});
