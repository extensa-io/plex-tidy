import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPlan, movesFor, preflight, requireNoProblems } from '../../src/apply/apply.ts';
import { RENAME_ACTION, reconcileJournal } from '../../src/apply/reconcile.ts';
import { pathExists } from '../../src/fs-win/exists.ts';
import type { Plan } from '../../src/plan/schemas.ts';
import { openJournal } from '../../src/state/journal.ts';
import { markUndone, planUndo, undoRenames } from '../../src/undo/undo.ts';
import { libraryTree } from '../fixtures/local-corpus.ts';
import { approveAll, planFor } from '../helpers/pipeline.ts';
import { useTempDirs } from '../helpers/temp-dir.ts';
import { createTree, listTree } from '../helpers/tree.ts';

const makeTempDir = useTempDirs();

async function setup(tree: readonly string[] = libraryTree) {
  const root = await makeTempDir();
  const stateDir = await makeTempDir();
  await createTree(root, tree);
  const { plan } = await planFor(root);
  const journal = openJournal(join(stateDir, 'journal.jsonl'));
  const saved: Plan[] = [];
  return { root, plan: approveAll(plan), journal, saved, save: (current: Plan) => Promise.resolve(void saved.push(current)) };
}

describe('preflight', () => {
  it('finds no problem in a clean approved plan', async () => {
    const { plan } = await setup();
    expect(await preflight(plan, pathExists)).toEqual([]);
  });

  it('looks only at approved entries', async () => {
    const { plan } = await setup();
    const broken = { ...plan, entries: plan.entries.map((entry) => ({ ...entry, status: 'pending' as const, target: '..\\Escaped.mkv' })) };
    expect(await preflight(broken, pathExists)).toEqual([]);
  });

  async function problemsFor(change: (entry: Plan['entries'][number]) => Plan['entries'][number]) {
    const { root, plan } = await setup(['Sample Source.mkv']);
    const first = plan.entries[0];
    if (first === undefined) {
      throw new Error('fixture missing');
    }
    const approved = { ...first, status: 'approved' as const, sidecars: [] };
    return { root, problems: await preflight({ ...plan, entries: [change(approved)] }, pathExists) };
  }

  it('refuses a target outside the root', async () => {
    const { problems } = await problemsFor((entry) => ({ ...entry, target: '..\\Escaped.mkv' }));
    expect(problems.map((problem) => problem.message)).toEqual(['a path is outside the library root']);
  });

  it('refuses a target on another volume', async () => {
    const { root, problems } = await problemsFor((entry) => ({ ...entry, target: 'Z:\\Elsewhere.mkv' }));
    expect(root.startsWith('Z:')).toBe(false);
    expect(problems.map((problem) => problem.message)).toEqual(['the rename would cross volumes']);
  });

  it('refuses a target that already exists', async () => {
    const { root } = await setup(['Sample Source.mkv', 'Taken.mkv']);
    const { plan } = await planFor(root);
    const entry = plan.entries.find((item) => item.source === 'Sample Source.mkv');
    if (entry === undefined) {
      throw new Error('fixture missing');
    }
    const problems = await preflight({ ...plan, entries: [{ ...entry, status: 'approved', target: 'Taken.mkv', sidecars: [] }] }, pathExists);
    expect(problems.map((problem) => problem.message)).toContain('the target already exists');
  });

  it('refuses a missing source', async () => {
    const { problems } = await problemsFor((entry) => ({ ...entry, source: 'Missing.mkv', target: 'New Name.mkv' }));
    expect(problems.map((problem) => problem.message)).toEqual(['the source file does not exist']);
  });

  it('refuses a name that is not legal on Windows', async () => {
    const { problems } = await problemsFor((entry) => ({ ...entry, target: 'Bad?Name.mkv' }));
    expect(problems.map((problem) => problem.message)).toContain('the target name is not legal on Windows');
  });

  it('refuses a path over the length limit', async () => {
    const { problems } = await problemsFor((entry) => ({ ...entry, target: `${'a'.repeat(300)}.mkv` }));
    expect(problems.map((problem) => problem.message)).toContain('the target path is over the length limit');
  });

  it('refuses two renames with the same target, ignoring case', async () => {
    const { plan } = await setup(['One.mkv', 'Two.mkv']);
    const [first, second] = plan.entries;
    if (first === undefined || second === undefined) {
      throw new Error('fixture missing');
    }
    const clash = {
      ...plan,
      entries: [
        { ...first, status: 'approved' as const, target: 'Same.mkv', sidecars: [] },
        { ...second, status: 'approved' as const, target: 'SAME.mkv', sidecars: [] },
      ],
    };
    expect((await preflight(clash, pathExists)).map((problem) => problem.message)).toEqual(['another rename has the same target']);
  });

  it('turns any problem into one PREFLIGHT_FAILED error', () => {
    expect(() => {
      requireNoProblems([]);
    }).not.toThrow();
    expect(() => {
      requireNoProblems([{ entryId: 'a', message: 'x' }]);
    }).toThrow(expect.objectContaining({ code: 'PREFLIGHT_FAILED' }));
  });
});

describe('applyPlan and undo', () => {
  it('renames approved videos and sidecars, and leaves everything else alone', async () => {
    const { root, plan, journal, save } = await setup();
    const before = await listTree(root);
    const { outcome, plan: updated } = await applyPlan(plan, { root, journal, save });

    const after = await listTree(root);
    expect(outcome).toEqual({ applied: 8, failed: 0, renames: 11 });
    expect(after).toContain('Family Clips\\Sample Film One 02.en.srt');
    expect(after).toContain('Family Clips\\Sample Film One 02.es.forced.srt');
    expect(after).toContain('Trips\\Beach Day\\Beach Day 01.mov');
    expect(after).toContain('Notes\\readme.txt');
    expect(after).toContain('2013.mkv');
    expect(after).toHaveLength(before.length);
    expect(updated.entries.filter((entry) => entry.status === 'applied')).toHaveLength(8);
    expect(await readFile(join(root, 'Trips', 'Sample Film Two.mkv'), 'utf8')).toBe('Trips\\SAMPLE FILM TWO.mkv');
  });

  it('writes an intent line before and a done line after every rename', async () => {
    const { root, plan, journal, save } = await setup();
    await applyPlan(plan, { root, journal, save });
    const { records } = await journal.read();
    expect(records.filter((record) => record.kind === 'intent')).toHaveLength(11);
    expect(records.filter((record) => record.kind === 'done')).toHaveLength(11);
    expect(await journal.unmatchedIntents()).toEqual([]);
    expect(records[0]?.kind).toBe('intent');
    expect(records[1]?.kind).toBe('done');
  });

  it('saves the plan after every entry', async () => {
    const { root, plan, journal, saved, save } = await setup();
    await applyPlan(plan, { root, journal, save });
    expect(saved).toHaveLength(8);
  });

  it('undo restores the original names exactly', async () => {
    const { root, plan, journal, save } = await setup();
    const before = await listTree(root);
    const { plan: applied } = await applyPlan(plan, { root, journal, save });
    expect(await listTree(root)).not.toEqual(before);

    const steps = await planUndo(journal);
    expect(steps).toHaveLength(11);
    const outcome = await undoRenames(steps, root, journal);
    expect(outcome).toMatchObject({ restored: 11, failed: 0 });
    expect(await listTree(root)).toEqual(before);
    expect(await readFile(join(root, 'Trips', 'SAMPLE FILM TWO.mkv'), 'utf8')).toBe('Trips\\SAMPLE FILM TWO.mkv');

    expect(markUndone(applied, outcome.restoredEntries).entries.filter((entry) => entry.status === 'approved')).toHaveLength(8);
  });

  it('a second undo finds nothing left to reverse', async () => {
    const { root, plan, journal, save } = await setup();
    await applyPlan(plan, { root, journal, save });
    await undoRenames(await planUndo(journal), root, journal);
    expect(await planUndo(journal)).toEqual([]);
  });

  it('undo refuses to overwrite a file that now has the original name, and reports it', async () => {
    const { root, plan, journal, save } = await setup(['Sample Source.mkv', 'sample.film.2011.1080p.mkv']);
    await applyPlan(plan, { root, journal, save });
    await writeFile(join(root, 'sample.film.2011.1080p.mkv'), 'a different file');

    const outcome = await undoRenames(await planUndo(journal), root, journal);
    expect(outcome.failed).toBe(1);
    expect(await readFile(join(root, 'sample.film.2011.1080p.mkv'), 'utf8')).toBe('a different file');
    expect(await journal.unmatchedIntents()).toEqual([]);
  });

  it('marks an entry failed, journals the refusal, and carries on when a target appears after preflight', async () => {
    const { root, plan, journal, save } = await setup(['sample.film.one.mkv', 'sample.film.two.mkv']);
    await writeFile(join(root, 'Sample Film One.mkv'), 'appeared late');

    const { outcome, plan: updated } = await applyPlan(plan, { root, journal, save });
    expect(outcome).toMatchObject({ applied: 1, failed: 1 });
    expect(updated.entries.map((entry) => entry.status).sort()).toEqual(['applied', 'failed']);
    expect(await readFile(join(root, 'Sample Film One.mkv'), 'utf8')).toBe('appeared late');
    expect(await journal.unmatchedIntents()).toEqual([]);
  });

  it('skips renames that do not change a name', () => {
    expect(movesFor({ ...({} as Plan['entries'][number]), id: 'x', source: 'A.mkv', target: 'A.mkv', sidecars: [] })).toEqual([]);
  });
});

describe('reconcileJournal', () => {
  async function interrupted() {
    const root = await makeTempDir();
    const stateDir = await makeTempDir();
    await createTree(root, ['finished before.mkv', 'never started.mkv', 'both gone.mkv']);
    const journal = openJournal(join(stateDir, 'journal.jsonl'));
    // The process stopped after the rename and before the done line.
    await journal.appendIntent(RENAME_ACTION, { entryId: 'a', from: 'finished before.mkv', to: 'Finished.mkv' });
    await rename(join(root, 'finished before.mkv'), join(root, 'Finished.mkv'));
    // The process stopped before the rename.
    await journal.appendIntent(RENAME_ACTION, { entryId: 'b', from: 'never started.mkv', to: 'Never Begun.mkv' });
    // Neither name exists.
    await journal.appendIntent(RENAME_ACTION, { entryId: 'c', from: 'gone.mkv', to: 'Also Gone.mkv' });
    return { root, journal };
  }

  it('detects and reports interrupted renames without writing in a dry run', async () => {
    const { root, journal } = await interrupted();
    const summary = await reconcileJournal(journal, root, pathExists, false);
    expect(summary).toEqual({ completed: 1, notStarted: 1, unknown: 1 });
    expect(await journal.unmatchedIntents()).toHaveLength(3);
  });

  it('closes finished and never-started intents and leaves the unknown one open', async () => {
    const { root, journal } = await interrupted();
    await reconcileJournal(journal, root, pathExists, true);
    const open = await journal.unmatchedIntents();
    expect(open.map((intent) => intent.data.entryId)).toEqual(['c']);
  });

  it('lets undo reverse a rename that finished before the interruption', async () => {
    const { root, journal } = await interrupted();
    await reconcileJournal(journal, root, pathExists, true);
    const steps = await planUndo(journal);
    expect(steps.map((step) => step.to)).toEqual(['finished before.mkv']);
    await undoRenames(steps, root, journal);
    expect(await listTree(root)).toEqual(['finished before.mkv', 'never started.mkv', 'both gone.mkv'].sort((a, b) => a.localeCompare(b)));
  });

  it('reports nothing when the journal is complete', async () => {
    const { root, plan, journal, save } = await setup();
    await applyPlan(plan, { root, journal, save });
    expect(await reconcileJournal(journal, root, pathExists, true)).toEqual({ completed: 0, notStarted: 0, unknown: 0 });
  });
});
