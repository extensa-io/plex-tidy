import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathExists } from '../../src/fs-win/exists.ts';
import { buildPlan } from '../../src/plan/build.ts';
import { applyManualTitle } from '../../src/plan/edit.ts';
import { planSchema } from '../../src/plan/schemas.ts';
import { summarizePlan } from '../../src/plan/status.ts';
import { scanRoot } from '../../src/scan/scan.ts';
import { libraryTree } from '../fixtures/videos-corpus.ts';
import { planFor, resolveScan } from '../helpers/pipeline.ts';
import { useTempDirs } from '../helpers/temp-dir.ts';
import { createTree } from '../helpers/tree.ts';

const makeTempDir = useTempDirs();

async function libraryPlan() {
  const root = await makeTempDir();
  await createTree(root, libraryTree);
  return { root, ...(await planFor(root)) };
}

describe('buildPlan on the fixture library', () => {
  it('produces the expected names for every file', async () => {
    const { plan } = await libraryPlan();
    const targets = Object.fromEntries(plan.entries.map((entry) => [entry.source, entry.target]));
    expect(targets).toEqual({
      '2013.mkv': '2013.mkv',
      '[Group] Sample Film Four [1080p].mkv': 'Sample Film Four.mkv',
      'Family Clips\\VID_20230101_120000.mp4': 'Family Clips\\Family Clips.mp4',
      'Family Clips\\sample.film.one.2011.1080p.bluray.x264-grp.mkv': 'Family Clips\\Sample Film One 02.mkv',
      'Family Clips\\Sample Film One.avi': 'Family Clips\\Sample Film One 01.avi',
      'Trips\\Beach Day\\IMG_0001.mov': 'Trips\\Beach Day\\Beach Day 01.mov',
      'Trips\\Beach Day\\IMG_0002.mov': 'Trips\\Beach Day\\Beach Day 02.mov',
      'Trips\\La Película de Prueba.mkv': 'Trips\\La Película de Prueba.mkv',
      'Trips\\SAMPLE FILM TWO.mkv': 'Trips\\Sample Film Two.mkv',
      'Trips\\sample_film_three_720p.mp4': 'Trips\\Sample Film Three.mp4',
    });
  });

  it('validates against the plan schema', async () => {
    const { plan } = await libraryPlan();
    expect(planSchema.safeParse(plan).success).toBe(true);
  });

  it('carries subtitle sidecars to the new name and keeps their language suffix', async () => {
    const { plan } = await libraryPlan();
    const entry = plan.entries.find((item) => item.source.includes('sample.film.one'));
    expect(entry?.sidecars.map((sidecar) => sidecar.target)).toEqual([
      'Family Clips\\Sample Film One 02.en.srt',
      'Family Clips\\Sample Film One 02.es.forced.srt',
    ]);
  });

  it('numbers colliding titles in the order of the original file names, ignoring case', async () => {
    const { plan } = await libraryPlan();
    // "Sample Film One" sorts before "sample.film.one...", because a space sorts before a dot.
    const first = plan.entries.find((item) => item.source.endsWith('Sample Film One.avi'));
    const second = plan.entries.find((item) => item.source.endsWith('sample.film.one.2011.1080p.bluray.x264-grp.mkv'));
    expect([first?.target, second?.target]).toEqual(['Family Clips\\Sample Film One 01.avi', 'Family Clips\\Sample Film One 02.mkv']);
    expect(first?.collision).toBe(true);
    expect(second?.collision).toBe(true);
  });

  it('marks an unchanged name as skipped with reason unchanged', async () => {
    const { plan } = await libraryPlan();
    const entry = plan.entries.find((item) => item.source === 'Trips\\La Película de Prueba.mkv');
    expect(entry).toMatchObject({ status: 'skipped', reason: 'unchanged' });
  });

  it('marks a file with no title as skipped with reason no-title', async () => {
    const { plan } = await libraryPlan();
    expect(plan.entries.find((item) => item.source === '2013.mkv')).toMatchObject({
      status: 'skipped',
      reason: 'no-title',
      title: null,
    });
  });

  it('leaves every changed entry pending and none approved', async () => {
    const { plan } = await libraryPlan();
    const summary = summarizePlan(plan);
    expect(summary.byStatus).toMatchObject({ pending: 8, approved: 0, skipped: 2 });
    expect(summary.awaitingReview).toBe(9);
    expect(summary.collisions).toBe(4);
  });

  it('refuses resolve results from a different scan', async () => {
    const root = await makeTempDir();
    await createTree(root, libraryTree);
    const scan = await scanRoot(root);
    const other = await scanRoot(root);
    await expect(buildPlan(scan, await resolveScan(other), { exists: pathExists })).rejects.toMatchObject({
      code: 'STAGE_STALE',
    });
  });

  it('refuses entries that were never resolved', async () => {
    const root = await makeTempDir();
    await createTree(root, libraryTree);
    const scan = await scanRoot(root);
    const resolved = await resolveScan(scan);
    const unresolved = { ...resolved, entries: resolved.entries.map((entry) => ({ ...entry, resolution: null })) };
    await expect(buildPlan(scan, unresolved, { exists: pathExists })).rejects.toMatchObject({ code: 'STAGE_MISSING' });
  });
});

describe('buildPlan against existing files', () => {
  it('numbers an entry whose target name already exists as something else', async () => {
    const root = await makeTempDir();
    await createTree(root, ['sample.film.2011.1080p.mkv']);
    const scan = await scanRoot(root);
    const resolved = await resolveScan(scan);
    // A folder with the target name blocks the rename.
    const exists = (path: string) => Promise.resolve(path === join(root, 'Sample Film.mkv') || pathExists(path));
    const plan = await buildPlan(scan, resolved, { exists });
    expect(plan.entries[0]).toMatchObject({ target: 'Sample Film 01.mkv', collision: true, status: 'pending' });
  });

  it('numbers an entry whose sidecar target already exists', async () => {
    const root = await makeTempDir();
    await createTree(root, ['sample.film.2011.1080p.mkv', 'sample.film.2011.1080p.en.srt', 'Sample Film.en.srt']);
    const scan = await scanRoot(root);
    const plan = await buildPlan(scan, await resolveScan(scan), { exists: pathExists });
    const entry = plan.entries.find((item) => item.source === 'sample.film.2011.1080p.mkv');
    expect(entry?.target).toBe('Sample Film 01.mkv');
    expect(entry?.sidecars[0]?.target).toBe('Sample Film 01.en.srt');
  });
});

describe('buildPlan with an earlier plan', () => {
  it('keeps approved and rejected decisions for entries that did not change', async () => {
    const { root, scan, plan } = await libraryPlan();
    const decided = {
      ...plan,
      entries: plan.entries.map((entry, index) =>
        entry.status === 'pending' ? { ...entry, status: index % 2 === 0 ? ('approved' as const) : ('rejected' as const) } : entry,
      ),
    };
    const rebuilt = await buildPlan(scan, await resolveScan(scan), { exists: pathExists, previous: decided });
    expect(rebuilt.entries.map((entry) => entry.status)).toEqual(decided.entries.map((entry) => entry.status));
    expect(root).toBeTruthy();
  });

  it('keeps a title typed by the owner', async () => {
    const root = await makeTempDir();
    await createTree(root, ['2013.mkv']);
    const scan = await scanRoot(root);
    const resolved = await resolveScan(scan);
    const first = await buildPlan(scan, resolved, { exists: pathExists });
    const entry = first.entries[0];
    const file = scan.files[0];
    if (entry === undefined || file === undefined) {
      throw new Error('fixture missing');
    }
    const edit = await applyManualTitle(first, entry, 'Sample Typed Title', file, pathExists);
    if (!edit.ok) {
      throw new Error(edit.message);
    }
    const typed = { ...first, entries: [edit.entry] };
    const rebuilt = await buildPlan(scan, resolved, { exists: pathExists, previous: typed });
    expect(rebuilt.entries[0]).toMatchObject({ target: 'Sample Typed Title.mkv', titleSource: 'manual', status: 'approved' });
  });

  it('drops a decision when the proposal changed', async () => {
    const root = await makeTempDir();
    await createTree(root, ['sample.film.one.mkv']);
    const scan = await scanRoot(root);
    const first = await buildPlan(scan, await resolveScan(scan), { exists: pathExists });
    const approved = { ...first, entries: first.entries.map((entry) => ({ ...entry, status: 'approved' as const })) };
    const changed = await resolveScan(scan, { answer: () => 'Sample One' });
    const rebuilt = await buildPlan(scan, changed, { exists: pathExists, previous: approved });
    expect(rebuilt.entries[0]).toMatchObject({ target: 'Sample One.mkv', status: 'pending' });
  });
});

describe('applyManualTitle', () => {
  async function setup() {
    const root = await makeTempDir();
    await createTree(root, ['Folder\\first.sample.mkv', 'Folder\\first.sample.en.srt', 'Folder\\Other Title.mkv']);
    const scan = await scanRoot(root);
    const plan = await buildPlan(scan, await resolveScan(scan), { exists: pathExists });
    const file = scan.files.find((item) => item.stem === 'first.sample');
    const entry = plan.entries.find((item) => item.id === file?.id);
    if (file === undefined || entry === undefined) {
      throw new Error('fixture missing');
    }
    return { root, plan, file, entry };
  }

  it('renames the video and its sidecars and approves the entry', async () => {
    const { plan, file, entry } = await setup();
    const result = await applyManualTitle(plan, entry, 'Typed: Title?', file, pathExists);
    expect(result).toMatchObject({
      ok: true,
      entry: {
        target: 'Folder\\Typed - Title.mkv',
        title: 'Typed - Title',
        titleSource: 'manual',
        status: 'approved',
        sidecars: [{ source: 'Folder\\first.sample.en.srt', target: 'Folder\\Typed - Title.en.srt' }],
      },
    });
  });

  it('refuses a title that is empty after sanitizing', async () => {
    const { plan, file, entry } = await setup();
    expect(await applyManualTitle(plan, entry, '???', file, pathExists)).toMatchObject({ ok: false });
  });

  it('refuses a name that another entry uses, ignoring case', async () => {
    const { plan, file, entry } = await setup();
    expect(await applyManualTitle(plan, entry, 'other title', file, pathExists)).toMatchObject({
      ok: false,
      message: 'Another file in the plan already uses that name.',
    });
  });

  it('refuses a name that exists on disk', async () => {
    const { root, plan, file, entry } = await setup();
    await writeFile(join(root, 'Folder', 'Taken Name.mkv'), 'x');
    expect(await applyManualTitle(plan, entry, 'Taken Name', file, pathExists)).toMatchObject({
      ok: false,
      message: 'A file with that name already exists.',
    });
  });

  it('refuses a name that makes the path too long', async () => {
    const { plan, file, entry } = await setup();
    const result = await applyManualTitle(plan, entry, 'a'.repeat(300), file, pathExists);
    expect(result).toMatchObject({ ok: false });
  });
});
