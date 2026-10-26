import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeCheckers, reconcileJournal, renameChecker } from '../../src/apply/reconcile.ts';
import { AppError } from '../../src/errors.ts';
import { pathExists } from '../../src/fs-win/exists.ts';
import type { Plan, PlanEntry } from '../../src/plan/schemas.ts';
import { openJournal } from '../../src/state/journal.ts';
import type { TagBackend } from '../../src/tag/backend.ts';
import { tagChecker, type Backends } from '../../src/tag/backends.ts';
import { itemListDesired, mkvDesired } from '../../src/tag/fields.ts';
import type { TagSnapshot, Writer } from '../../src/tag/schemas.ts';
import { countCandidates, findLeftoverCopies, findLeftoverWorkDirs, isTaggable, planTagging, runTagging } from '../../src/tag/tagger.ts';
import { planUndo, undoSteps } from '../../src/undo/undo.ts';
import { useTempDirs } from '../helpers/temp-dir.ts';

const makeTempDir = useTempDirs();
const root = 'D:\\Library';

interface FakeFile {
  title: string | null;
  fields?: Record<string, string[]>;
  unreadable?: boolean;
}

/** A tag writer that keeps tags in memory, so no real tool is needed. */
function fakeBackend(writer: Writer, files: Map<string, FakeFile>, failWith?: AppError): TagBackend & { writes: string[] } {
  const writes: string[] = [];
  return {
    writer,
    writes,
    desired: writer === 'mkvpropedit' ? mkvDesired : itemListDesired,
    read: (file, names) => {
      const stored = files.get(file);
      if (stored === undefined || stored.unreadable === true) {
        return Promise.reject(new AppError('TOOL_FAILED', 'ffprobe exited with code 1.'));
      }
      return Promise.resolve({
        title: stored.title,
        fields: Object.fromEntries(names.map((name) => [name, stored.fields?.[name] ?? []])),
      });
    },
    write: (file, target) => {
      writes.push(file);
      if (failWith !== undefined) {
        return Promise.reject(failWith);
      }
      files.set(file, { title: target.title, fields: target.fields });
      return Promise.resolve();
    },
  };
}

function backendsFor(files: Map<string, FakeFile>, failWith?: AppError): Backends & { mkv: ReturnType<typeof fakeBackend>; exif: ReturnType<typeof fakeBackend> } {
  const mkv = fakeBackend('mkvpropedit', files, failWith);
  const exif = fakeBackend('exiftool', files, failWith);
  return { mkvpropedit: mkv, exiftool: exif, mkv, exif };
}

function entry(id: string, target: string, overrides: Partial<PlanEntry> = {}): PlanEntry {
  return {
    id,
    source: 'old name.mkv',
    target,
    sidecars: [],
    title: 'Sample Title',
    titleSource: 'filename',
    confidence: 'high',
    reason: 'test',
    status: 'applied',
    tagStatus: 'untagged',
    tagReason: null,
    collision: false,
    ...overrides,
  };
}

function planOf(entries: PlanEntry[]): Plan {
  return { schemaVersion: 1, scanId: '00000000-0000-4000-8000-000000000000', root, builtAt: '2026-01-01T00:00:00.000Z', entries };
}

const pathOf = (target: string) => join(root, target);

describe('isTaggable', () => {
  it('takes renamed untagged files and failed tags, and nothing else', () => {
    expect(isTaggable(entry('a', 'a.mkv'))).toBe(true);
    expect(isTaggable(entry('a', 'a.mkv', { tagStatus: 'tag-failed' }))).toBe(true);
    expect(isTaggable(entry('a', 'a.mkv', { tagStatus: 'tagged' }))).toBe(false);
    expect(isTaggable(entry('a', 'a.mkv', { tagStatus: 'tag-skipped' }))).toBe(false);
    expect(isTaggable(entry('a', 'a.mkv', { status: 'approved' }))).toBe(false);
    expect(isTaggable(entry('a', 'a.mkv', { status: 'pending' }))).toBe(false);
  });
});

describe('planTagging', () => {
  it('chooses the writer by container and compares with what the file has', async () => {
    const files = new Map<string, FakeFile>([
      [pathOf('a.mkv'), { title: null }],
      [pathOf('b.mp4'), { title: 'Sample Title' }],
    ]);
    const candidates = await planTagging(
      planOf([entry('a', 'a.mkv'), entry('b', 'b.mp4'), entry('c', 'c.avi'), entry('d', 'd.wmv')]),
      backendsFor(files),
    );
    expect(candidates.map((candidate) => [candidate.entry.id, candidate.action, candidate.writer])).toEqual([
      ['a', 'write', 'mkvpropedit'],
      ['b', 'unchanged', 'exiftool'],
      ['c', 'unsupported', null],
      ['d', 'unsupported', null],
    ]);
    expect(countCandidates(candidates)).toMatchObject({
      write: 1,
      unchanged: 1,
      unsupported: 2,
      unsupportedReasons: { 'ExifTool cannot write AVI (RIFF) files': 1, 'ExifTool cannot write WMV (ASF) files': 1 },
    });
  });

  it('reports a file that cannot be read without failing the plan', async () => {
    const candidates = await planTagging(planOf([entry('a', 'a.mp4')]), backendsFor(new Map()));
    expect(candidates[0]).toMatchObject({ action: 'unreadable', reason: 'ffprobe exited with code 1.' });
  });

  it('writes nothing', async () => {
    const files = new Map<string, FakeFile>([[pathOf('a.mkv'), { title: null }]]);
    const backends = backendsFor(files);
    await planTagging(planOf([entry('a', 'a.mkv')]), backends);
    expect(backends.mkv.writes).toEqual([]);
    expect(files.get(pathOf('a.mkv'))?.title).toBeNull();
  });
});

describe('runTagging', () => {
  async function run(files: Map<string, FakeFile>, entries: PlanEntry[], failWith?: AppError) {
    const journal = openJournal(join(await makeTempDir(), 'journal.jsonl'));
    const backends = backendsFor(files, failWith);
    const plan = planOf(entries);
    const saved: Plan[] = [];
    const candidates = await planTagging(plan, backends);
    const result = await runTagging(plan, candidates, {
      root,
      journal,
      backends,
      save: (current) => Promise.resolve(void saved.push(current)),
    });
    return { ...result, journal, backends, saved };
  }

  it('writes, journals the previous values, and marks the entry tagged', async () => {
    const files = new Map<string, FakeFile>([[pathOf('a.mkv'), { title: 'Old Title' }]]);
    const { plan, outcome, journal } = await run(files, [entry('a', 'a.mkv')]);

    expect(outcome).toEqual({ tagged: 1, unchanged: 0, skipped: 0, failed: 0 });
    expect(plan.entries[0]).toMatchObject({ tagStatus: 'tagged', tagReason: null });
    expect(files.get(pathOf('a.mkv'))?.title).toBe('Sample Title');

    const { records } = await journal.read();
    expect(records.map((record) => record.kind)).toEqual(['intent', 'done']);
    expect(records[0]).toMatchObject({
      kind: 'intent',
      action: 'tag',
      data: { entryId: 'a', path: 'a.mkv', writer: 'mkvpropedit', previous: { title: 'Old Title' }, next: { title: 'Sample Title' } },
    });
  });

  it('marks a rename-only container tag-skipped with the reason, and does not journal it', async () => {
    const { plan, outcome, journal } = await run(new Map(), [entry('a', 'a.avi')]);
    expect(outcome.skipped).toBe(1);
    expect(plan.entries[0]).toMatchObject({ tagStatus: 'tag-skipped', tagReason: 'ExifTool cannot write AVI (RIFF) files' });
    expect((await journal.read()).records).toEqual([]);
  });

  it('writes nothing for a file that already has the title', async () => {
    const files = new Map<string, FakeFile>([[pathOf('a.mp4'), { title: 'Sample Title' }]]);
    const { plan, outcome, backends, journal } = await run(files, [entry('a', 'a.mp4')]);
    expect(outcome.unchanged).toBe(1);
    expect(backends.exif.writes).toEqual([]);
    expect(plan.entries[0]?.tagStatus).toBe('tagged');
    expect((await journal.read()).records).toEqual([]);
  });

  it('marks an unreadable file tag-failed', async () => {
    const { plan, outcome } = await run(new Map(), [entry('a', 'a.mkv')]);
    expect(outcome.failed).toBe(1);
    expect(plan.entries[0]).toMatchObject({ tagStatus: 'tag-failed', tagReason: 'ffprobe exited with code 1.' });
  });

  it.each(['TAG_VERIFY_FAILED', 'TAG_NO_SPACE'] as const)('closes the journal intent when the write ends with %s', async (code) => {
    const files = new Map<string, FakeFile>([[pathOf('a.mp4'), { title: null }]]);
    const { plan, outcome, journal } = await run(files, [entry('a', 'a.mp4')], new AppError(code, 'reason text'));
    expect(outcome.failed).toBe(1);
    expect(plan.entries[0]).toMatchObject({ tagStatus: 'tag-failed', tagReason: 'reason text' });
    expect(await journal.unmatchedIntents()).toEqual([]);
    expect((await journal.read()).records.map((record) => record.kind)).toEqual(['intent', 'void']);
  });

  it('leaves the intent open when the state after the failure is unclear', async () => {
    const files = new Map<string, FakeFile>([[pathOf('a.mkv'), { title: null }]]);
    const { journal } = await run(files, [entry('a', 'a.mkv')], new AppError('TOOL_FAILED', 'mkvpropedit exited with code 2.'));
    expect(await journal.unmatchedIntents()).toHaveLength(1);
  });

  it('saves the plan after every entry', async () => {
    const files = new Map<string, FakeFile>([
      [pathOf('a.mkv'), { title: null }],
      [pathOf('b.mp4'), { title: null }],
    ]);
    const { saved } = await run(files, [entry('a', 'a.mkv'), entry('b', 'b.mp4'), entry('c', 'c.avi')]);
    expect(saved).toHaveLength(3);
  });

  it('carries on after a failure', async () => {
    const files = new Map<string, FakeFile>([[pathOf('b.mkv'), { title: null }]]);
    const { outcome } = await run(files, [entry('a', 'a.mkv'), entry('b', 'b.mkv')]);
    expect(outcome).toMatchObject({ tagged: 1, failed: 1 });
  });
});

describe('reconciling an interrupted tag', () => {
  async function interrupted(current: FakeFile | undefined) {
    const files = new Map<string, FakeFile>(current === undefined ? [] : [[pathOf('a.mkv'), current]]);
    const journal = openJournal(join(await makeTempDir(), 'journal.jsonl'));
    const previous: TagSnapshot = { title: 'Old Title', fields: {} };
    const next: TagSnapshot = { title: 'Sample Title', fields: {} };
    await journal.appendIntent('tag', { entryId: 'a', path: 'a.mkv', writer: 'mkvpropedit', previous, next });
    const check = composeCheckers(renameChecker(root, pathExists), tagChecker(root, backendsFor(files)));
    return { journal, check };
  }

  it('sees a finished write when the file shows the new title', async () => {
    const { journal, check } = await interrupted({ title: 'Sample Title' });
    expect(await reconcileJournal(journal, check, true)).toEqual({ completed: 1, notStarted: 0, unknown: 0 });
    expect(await journal.unmatchedIntents()).toEqual([]);
    expect(await planUndo(journal, 'tag')).toHaveLength(1);
  });

  it('sees a write that never started when the file shows the old title', async () => {
    const { journal, check } = await interrupted({ title: 'Old Title' });
    expect(await reconcileJournal(journal, check, true)).toEqual({ completed: 0, notStarted: 1, unknown: 0 });
    expect(await planUndo(journal, 'tag')).toEqual([]);
  });

  it('leaves the intent open when the file shows something else or cannot be read', async () => {
    const other = await interrupted({ title: 'Third Title' });
    expect(await reconcileJournal(other.journal, other.check, true)).toEqual({ completed: 0, notStarted: 0, unknown: 1 });
    const missing = await interrupted(undefined);
    expect(await reconcileJournal(missing.journal, missing.check, true)).toEqual({ completed: 0, notStarted: 0, unknown: 1 });
  });

  it('changes nothing in a dry run', async () => {
    const { journal, check } = await interrupted({ title: 'Sample Title' });
    await reconcileJournal(journal, check, false);
    expect(await journal.unmatchedIntents()).toHaveLength(1);
  });
});

describe('undoing tags', () => {
  it('restores the previous values and does not reverse them twice', async () => {
    const files = new Map<string, FakeFile>([[pathOf('a.mkv'), { title: 'Old Title' }]]);
    const journal = openJournal(join(await makeTempDir(), 'journal.jsonl'));
    const backends = backendsFor(files);
    const plan = planOf([entry('a', 'a.mkv')]);
    await runTagging(plan, await planTagging(plan, backends), { root, journal, backends, save: () => Promise.resolve() });
    expect(files.get(pathOf('a.mkv'))?.title).toBe('Sample Title');

    const steps = await planUndo(journal, 'tag');
    expect(steps).toHaveLength(1);
    const outcome = await undoSteps(steps, { root, journal, backends });

    expect(outcome).toMatchObject({ restored: 1, failed: 0 });
    expect(files.get(pathOf('a.mkv'))?.title).toBe('Old Title');
    expect(await planUndo(journal, 'tag')).toEqual([]);
  });

  it('reports a step it cannot do when no writer is available', async () => {
    const files = new Map<string, FakeFile>([[pathOf('a.mkv'), { title: null }]]);
    const journal = openJournal(join(await makeTempDir(), 'journal.jsonl'));
    const backends = backendsFor(files);
    const plan = planOf([entry('a', 'a.mkv')]);
    await runTagging(plan, await planTagging(plan, backends), { root, journal, backends, save: () => Promise.resolve() });

    const outcome = await undoSteps(await planUndo(journal, 'tag'), { root, journal });
    expect(outcome).toMatchObject({ restored: 0, failed: 1 });
  });

  it('filters by kind', async () => {
    const files = new Map<string, FakeFile>([[pathOf('a.mkv'), { title: null }]]);
    const journal = openJournal(join(await makeTempDir(), 'journal.jsonl'));
    const backends = backendsFor(files);
    const plan = planOf([entry('a', 'a.mkv')]);
    const intent = await journal.appendIntent('rename', { entryId: 'a', from: 'old name.mkv', to: 'a.mkv' });
    await journal.appendDone(intent);
    await runTagging(plan, await planTagging(plan, backends), { root, journal, backends, save: () => Promise.resolve() });

    expect((await planUndo(journal)).map((step) => step.kind)).toEqual(['tag', 'rename']);
    expect((await planUndo(journal, 'tag')).map((step) => step.kind)).toEqual(['tag']);
    expect((await planUndo(journal, 'rename')).map((step) => step.kind)).toEqual(['rename']);
  });
});

describe('progress and leftover copies', () => {
  it('reports zero done before the first file, then each file', async () => {
    const files = new Map<string, FakeFile>([
      [pathOf('a.mkv'), { title: null }],
      [pathOf('b.mp4'), { title: null }],
    ]);
    const journal = openJournal(join(await makeTempDir(), 'journal.jsonl'));
    const backends = backendsFor(files);
    const plan = planOf([entry('a', 'a.mkv'), entry('b', 'b.mp4'), entry('c', 'c.avi')]);
    const reads: [number, number][] = [];
    const candidates = await planTagging(plan, backends, (done, total) => void reads.push([done, total]));
    expect(reads).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);

    const writes: [number, number][] = [];
    await runTagging(plan, candidates, {
      root,
      journal,
      backends,
      save: () => Promise.resolve(),
      onProgress: (done, total) => void writes.push([done, total]),
    });
    expect(writes).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
  });

  it('finds only files named like this tool names its temporary copies', async () => {
    const dir = await makeTempDir();
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'Clips'));
    const leftover = join(dir, 'Clips', '.Sample One.mp4.1a2b3c4d.plex-tidy-tag.tmp');
    await writeFile(leftover, 'x');
    await writeFile(join(dir, 'Clips', '.Sample One.mp4.1a2b3c4d.other.tmp'), 'x');
    await writeFile(join(dir, 'Clips', 'Sample One.plex-tidy-tag.tmp'), 'x');
    await writeFile(join(dir, 'Clips', 'Sample One.mp4'), 'x');

    const plan = { ...planOf([entry('a', 'Clips\\Sample One.mp4')]), root: dir };
    expect(await findLeftoverCopies(plan)).toEqual([leftover]);
  });
});

describe('findLeftoverWorkDirs', () => {
  it('finds only the folders of runs that are over', async () => {
    const temp = await makeTempDir();
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(temp, 'plex-tidy-copy-111111-abc'));
    await mkdir(join(temp, `plex-tidy-copy-${process.pid}-own`));
    await mkdir(join(temp, 'plex-tidy-copy-222222-other-run-still-going'));
    await mkdir(join(temp, 'plex-tidy-copy-without-a-pid'));
    await mkdir(join(temp, 'some-other-folder'));
    await writeFile(join(temp, 'plex-tidy-copy-333333-a-file'), 'x');

    const running = (pid: number) => pid === 222222;
    expect(await findLeftoverWorkDirs(temp, running)).toEqual([join(temp, 'plex-tidy-copy-111111-abc')]);
  });

  it('treats a missing folder as having nothing left over', async () => {
    expect(await findLeftoverWorkDirs(join(await makeTempDir(), 'missing'))).toEqual([]);
  });

  it('knows the current process is running', async () => {
    const temp = await makeTempDir();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(temp, `plex-tidy-copy-${process.ppid}-parent`));
    // The parent process of this test is alive, so its folder is not leftover.
    expect(await findLeftoverWorkDirs(temp)).toEqual([]);
  });
});
