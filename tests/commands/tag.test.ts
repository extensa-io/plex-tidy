import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli.ts';
import { createVideosCommands } from '../../src/commands/videos.ts';
import { parseConfig } from '../../src/config.ts';
import { AppError } from '../../src/errors.ts';
import { createLogger } from '../../src/logger.ts';
import { planSchema } from '../../src/plan/schemas.ts';
import { readJsonFile } from '../../src/state/json-file.ts';
import { openJournal } from '../../src/state/journal.ts';
import { createBackends } from '../../src/tag/backends.ts';
import { createToolLocator, realRunner } from '../../src/tag/runner.ts';
import { approvingIO, exists, harness, type Harness } from '../helpers/cli-harness.ts';
import { findRealTools, makeSample, realBackendDeps } from '../helpers/real-tools.ts';
import { createStubModel } from '../helpers/stub-model.ts';
import { recordingProgress } from '../helpers/recording-progress.ts';
import { listTree } from '../helpers/tree.ts';

const tools = await findRealTools();
const backends = createBackends(realBackendDeps);

const sources = [
  'Clips\\sample one.mkv',
  'Clips\\sample two.mp4',
  'Clips\\sample three.mov',
  'Clips\\sample four.avi',
  'Clips\\sample five.wmv',
];
const renamed = {
  mkv: 'Clips\\Sample One.mkv',
  mp4: 'Clips\\Sample Two.mp4',
  mov: 'Clips\\Sample Three.mov',
  avi: 'Clips\\Sample Four.avi',
  wmv: 'Clips\\Sample Five.wmv',
};

/** Real sample videos, renamed by the real command line path with a stub model. */
async function renamedLibrary(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = await harness({ tree: [], ...options });
  if (tools !== undefined) {
    for (const source of sources) {
      await makeSample(tools, join(h.root, source));
    }
  }
  await h.run('scan');
  await h.run('parse');
  await h.run('resolve');
  await h.run('plan');
  await h.run('review');
  await h.run('apply', '--yes');
  return h;
}

async function titleOf(h: Harness, relative: string): Promise<string | null> {
  const file = join(h.root, relative);
  const writer = relative.endsWith('.mkv') ? 'mkvpropedit' : 'exiftool';
  return (await backends[writer].read(file, [])).title;
}

async function contents(h: Harness, relatives: readonly string[]): Promise<Buffer[]> {
  return Promise.all(relatives.map((relative) => readFile(join(h.root, relative))));
}

describe.skipIf(tools === undefined)('tag and undo --only, with the real tools', () => {
  it('renames first, then a dry run tag changes no file and no state', async () => {
    const h = await renamedLibrary();
    expect(await listTree(h.root)).toContain('Clips\\Sample One.mkv');
    const all = Object.values(renamed);
    const before = await contents(h, all);
    const planBefore = await readFile(h.paths.plan, 'utf8');
    const journalBefore = await readFile(h.paths.journal, 'utf8');

    h.lines.length = 0;
    await h.run('tag');

    expect(await contents(h, all)).toEqual(before);
    expect(await readFile(h.paths.plan, 'utf8')).toBe(planBefore);
    expect(await readFile(h.paths.journal, 'utf8')).toBe(journalBefore);
    expect(h.lines).toContain('tag: 3 to write, 0 already correct, 2 rename-only, 0 could not be read');
    expect(h.lines).toContain('rename-only: 1 files, because ExifTool cannot write AVI (RIFF) files');
    expect(h.lines).toContain('rename-only: 1 files, because ExifTool cannot write WMV (ASF) files');
    expect(h.lines).toContain('dry run: nothing was changed. Add --yes to tag.');
    expect(await titleOf(h, renamed.mkv)).toBeNull();
  });

  it('tags supported files, reports the rest as rename-only, and exits successfully', async () => {
    const h = await renamedLibrary();
    await h.run('tag', '--yes');

    expect(process.exitCode).toBeUndefined();
    expect(await titleOf(h, renamed.mkv)).toBe('Sample One');
    expect(await titleOf(h, renamed.mp4)).toBe('Sample Two');
    expect(await titleOf(h, renamed.mov)).toBe('Sample Three');
    expect(h.lines).toContain('tagged 3 files; 0 already correct, 2 rename-only, 0 failed');

    const plan = await readJsonFile(h.paths.plan, planSchema);
    const byTarget = Object.fromEntries((plan?.entries ?? []).map((entry) => [entry.target, [entry.tagStatus, entry.tagReason]]));
    expect(byTarget[renamed.mkv]).toEqual(['tagged', null]);
    expect(byTarget[renamed.avi]).toEqual(['tag-skipped', 'ExifTool cannot write AVI (RIFF) files']);
    expect(byTarget[renamed.wmv]).toEqual(['tag-skipped', 'ExifTool cannot write WMV (ASF) files']);
  });

  it('shows how far reading and tagging have got', async () => {
    const { factory, tasks } = recordingProgress();
    const h = await renamedLibrary({ progress: factory });
    tasks.length = 0;

    await h.run('tag');
    expect(tasks.map((task) => task.label)).toEqual(['reading tags']);
    expect(tasks[0]?.updates.at(-1)).toEqual([5, 5]);
    expect(tasks[0]?.finished).toBe(true);

    await h.run('tag', '--yes');
    const writing = tasks.filter((task) => task.label === 'tagging').at(-1);
    expect(writing?.updates).toEqual([0, 1, 2, 3, 4, 5].map((done) => [done, 5]));
    expect(writing?.finished).toBe(true);
    // The note about the file being copied is cleared at the start and after every file.
    expect(writing?.details.filter((note) => note === undefined)).toHaveLength(6);
  });

  it('removes temporary copies left by an interrupted run, and only with --yes', async () => {
    const h = await renamedLibrary();
    const leftover = join(h.root, 'Clips', '.Sample Two.mp4.1a2b3c4d.plex-tidy-tag.tmp');
    const unrelated = join(h.root, 'Clips', '.Sample Two.mp4.notes.tmp');
    await writeFile(leftover, 'x');
    await writeFile(unrelated, 'x');

    h.lines.length = 0;
    await h.run('tag');
    expect(await exists(leftover)).toBe(true);
    expect(h.lines).toContain('1 temporary copies left by an interrupted run; --yes removes them');

    await h.run('tag', '--yes');
    expect(await exists(leftover)).toBe(false);
    expect(await exists(unrelated)).toBe(true);
    expect(h.lines).toContain('removed 1 temporary copies left by an interrupted run');
  });

  it('a second run with --yes writes nothing', async () => {
    const h = await renamedLibrary();
    await h.run('tag', '--yes');
    const files = [renamed.mkv, renamed.mp4, renamed.mov];
    const before = await contents(h, files);
    const journalBefore = await readFile(h.paths.journal, 'utf8');

    h.lines.length = 0;
    await h.run('tag', '--yes');

    expect(await contents(h, files)).toEqual(before);
    expect(await readFile(h.paths.journal, 'utf8')).toBe(journalBefore);
    expect(h.lines).toContain('nothing to tag: tagging applies to files that were renamed with apply');
  });

  it('writes tags that already match without touching the file', async () => {
    const h = await renamedLibrary();
    await backends.mkvpropedit.write(join(h.root, renamed.mkv), { title: 'Sample One', fields: {} });
    const before = await readFile(join(h.root, renamed.mkv));

    await h.run('tag', '--yes');
    expect(await readFile(join(h.root, renamed.mkv))).toEqual(before);
    expect(h.lines).toContain('tagged 2 files; 1 already correct, 2 rename-only, 0 failed');
  });

  it('journals the previous values of every tag write', async () => {
    const h = await renamedLibrary();
    await h.run('tag', '--yes');
    const { records } = await openJournal(h.paths.journal).read();
    const tagIntents = records.filter((record) => record.kind === 'intent' && record.action === 'tag');
    expect(tagIntents).toHaveLength(3);
    for (const intent of tagIntents) {
      if (intent.kind === 'intent') {
        expect(intent.data).toMatchObject({ previous: { title: null, fields: {} }, next: { fields: {} } });
      }
    }
    const done = records.filter((record) => record.kind === 'done').map((record) => record.id);
    expect(tagIntents.every((record) => done.includes(record.id))).toBe(true);
  });

  it('undo --only tag restores the titles and keeps the new names', async () => {
    const h = await renamedLibrary();
    await h.run('tag', '--yes');

    await h.run('undo', '--only', 'tag', '--yes');

    expect(await titleOf(h, renamed.mkv)).toBeNull();
    expect(await titleOf(h, renamed.mp4)).toBeNull();
    expect(await titleOf(h, renamed.mov)).toBeNull();
    expect(await listTree(h.root)).toContain('Clips\\Sample One.mkv');
    const plan = await readJsonFile(h.paths.plan, planSchema);
    expect(plan?.entries.filter((entry) => entry.tagStatus === 'untagged' || entry.tagStatus === 'tag-skipped')).toHaveLength(5);
    expect(plan?.entries.filter((entry) => entry.status === 'applied')).toHaveLength(5);
  });

  it('undo --only rename restores the names and keeps the tags', async () => {
    const h = await renamedLibrary();
    await h.run('tag', '--yes');
    const original = [...sources].sort((a, b) => a.localeCompare(b));

    await h.run('undo', '--only', 'rename', '--yes');

    expect(await listTree(h.root)).toEqual(original);
    const tagged = await backends.mkvpropedit.read(join(h.root, 'Clips', 'sample one.mkv'), []);
    expect(tagged.title).toBe('Sample One');
  });

  it('undo with no --only reverses tags before renames and restores everything', async () => {
    const h = await renamedLibrary();
    const original = await listTree(h.root).then((files) => files.map((file) => file));
    expect(original).toContain('Clips\\Sample One.mkv');
    await h.run('tag', '--yes');

    await h.run('undo', '--yes');

    expect(await listTree(h.root)).toEqual([...sources].sort((a, b) => a.localeCompare(b)));
    expect((await backends.mkvpropedit.read(join(h.root, 'Clips', 'sample one.mkv'), [])).title).toBeNull();
    expect((await backends.exiftool.read(join(h.root, 'Clips', 'sample two.mp4'), [])).title).toBeNull();
  });

  it('undo without --yes changes nothing', async () => {
    const h = await renamedLibrary();
    await h.run('tag', '--yes');
    const files = [renamed.mkv, renamed.mp4, renamed.mov];
    const before = await contents(h, files);
    h.lines.length = 0;

    await h.run('undo', '--only', 'tag');

    expect(await contents(h, files)).toEqual(before);
    expect(h.lines).toContain('operations that would be reversed: 3');
  });

  it('refuses an --only value other than rename or tag', async () => {
    const h = await renamedLibrary();
    await expect(h.run('undo', '--only', 'everything', '--yes')).rejects.toMatchObject({ code: 'OPTION_INVALID' });
  });

  it('marks a file tag-failed, keeps it untouched, and exits with an error when verification fails', async () => {
    const failing = createBackends(realBackendDeps, {
      verify: () => Promise.reject(new AppError('TAG_VERIFY_FAILED', 'forced for the test')),
    });
    const h = await renamedLibrary({ backends: failing });
    const before = await contents(h, [renamed.mp4, renamed.mov]);

    await h.run('tag', '--yes');

    expect(await contents(h, [renamed.mp4, renamed.mov])).toEqual(before);
    expect(process.exitCode).toBe(1);
    const plan = await readJsonFile(h.paths.plan, planSchema);
    const mp4 = plan?.entries.find((entry) => entry.target === renamed.mp4);
    expect(mp4).toMatchObject({ tagStatus: 'tag-failed', tagReason: 'forced for the test' });
    // The Matroska file is written by another writer, so it still gets its title.
    expect(await titleOf(h, renamed.mkv)).toBe('Sample One');
    expect(await exists(h.paths.journal)).toBe(true);
    expect(await openJournal(h.paths.journal).unmatchedIntents()).toEqual([]);
  });

  it('tries a failed file again on the next run', async () => {
    const failing = createBackends(realBackendDeps, { verify: () => Promise.reject(new AppError('TAG_NO_SPACE', 'no room')) });
    const h = await renamedLibrary({ backends: failing });
    await h.run('tag', '--yes');
    expect((await readJsonFile(h.paths.plan, planSchema))?.entries.filter((entry) => entry.tagStatus === 'tag-failed')).toHaveLength(2);

    // A new command-line run with working writers, on the same state.
    const logger = createLogger({ level: 'info', secrets: [], write: () => undefined });
    const commands = createVideosCommands({
      loadConfig: () => Promise.resolve(parseConfig({ models: { parse: 'a', judge: 'b' } })),
      createTitleModel: () => createStubModel(),
      createReviewIO: () => approvingIO,
      createBackends: () => createBackends({ runner: realRunner, locate: createToolLocator({}) }),
    });
    await buildProgram({ logger }, { topLevel: [], mode: commands }).parseAsync([
      'node', 'plex-tidy', 'videos', 'tag', '--root', h.root, '--state-dir', h.stateDir, '--yes',
    ]);

    expect(await titleOf(h, renamed.mp4)).toBe('Sample Two');
    expect(await titleOf(h, renamed.mov)).toBe('Sample Three');
  });
});
