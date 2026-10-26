import { describe, expect, it } from 'vitest';
import { pathExists } from '../../src/fs-win/exists.ts';
import type { Plan } from '../../src/plan/schemas.ts';
import { isBulkApprovable, runReview, type Choice, type ReviewIO } from '../../src/review/review.ts';
import { libraryTree } from '../fixtures/videos-corpus.ts';
import { planFor } from '../helpers/pipeline.ts';
import { useTempDirs } from '../helpers/temp-dir.ts';
import { createTree } from '../helpers/tree.ts';

const makeTempDir = useTempDirs();

interface Script {
  confirm?: boolean[];
  choose?: string[];
  ask?: string[];
}

function scriptedIO(script: Script) {
  const queues = { confirm: [...(script.confirm ?? [])], choose: [...(script.choose ?? [])], ask: [...(script.ask ?? [])] };
  const printed: string[] = [];
  const offered: string[][] = [];
  const io: ReviewIO = {
    print: (line) => void printed.push(line),
    confirm: () => Promise.resolve(queues.confirm.shift() ?? false),
    choose: (_message, choices: readonly Choice[]) => {
      offered.push(choices.map((choice) => choice.value));
      return Promise.resolve(queues.choose.shift() ?? 'quit');
    },
    ask: () => Promise.resolve(queues.ask.shift() ?? ''),
  };
  return { io, printed, offered };
}

async function setup(tree: readonly string[], answer?: (kind: string, sources: readonly string[]) => string | null | undefined) {
  const root = await makeTempDir();
  await createTree(root, tree);
  const { scan, plan } = await planFor(root, answer === undefined ? {} : { answer });
  const saved: Plan[] = [];
  const deps = {
    files: new Map(scan.files.map((file) => [file.id, file])),
    exists: pathExists,
    save: (current: Plan) => Promise.resolve(void saved.push(current)),
  };
  return { plan, deps, saved };
}

const statuses = (plan: Plan) => Object.fromEntries(plan.entries.map((entry) => [entry.source, entry.status]));

describe('isBulkApprovable', () => {
  it('requires a pending filename title with high confidence and no collision', async () => {
    const { plan } = await setup(libraryTree);
    const bulk = plan.entries.filter(isBulkApprovable).map((entry) => entry.source);
    expect(bulk.sort()).toEqual(['Trips\\SAMPLE FILM TWO.mkv', 'Trips\\sample_film_three_720p.mp4', '[Group] Sample Film Four [1080p].mkv'].sort());
  });

  it('never includes a collision, a folder title, or a rules-only title', async () => {
    const { plan } = await setup(libraryTree);
    const excluded = plan.entries.filter((entry) => !isBulkApprovable(entry));
    expect(excluded.some((entry) => entry.collision && isBulkApprovable(entry))).toBe(false);
    expect(plan.entries.filter(isBulkApprovable).every((entry) => entry.titleSource === 'filename')).toBe(true);
  });
});

describe('runReview', () => {
  it('approves the bulk group when the owner agrees and then asks about the rest', async () => {
    const { plan, deps, saved } = await setup(libraryTree);
    const { io } = scriptedIO({ confirm: [true], choose: ['skip', 'accept', 'accept', 'quit'] });
    const summary = await runReview(plan, { ...deps, io });

    // The first entry, 2013.mkv, has no title, so it can only be skipped or edited.
    expect(summary).toMatchObject({ bulkApproved: 3, accepted: 2, skipped: 1 });
    expect(summary.plan.entries.filter((entry) => entry.status === 'approved')).toHaveLength(5);
    expect(saved.length).toBe(4);
  });

  it('lists every old and new name of the bulk group before asking', async () => {
    const { plan, deps } = await setup(libraryTree);
    const { io, printed } = scriptedIO({ confirm: [false], choose: ['quit'] });
    await runReview(plan, { ...deps, io });
    expect(printed).toContain('  SAMPLE FILM TWO.mkv  ->  Sample Film Two.mkv');
    expect(printed).toContain('  sample_film_three_720p.mp4  ->  Sample Film Three.mp4');
    expect(printed).toContain('  [Group] Sample Film Four [1080p].mkv  ->  Sample Film Four.mkv');
    expect(printed.filter((line) => line.includes('  ->  '))).toHaveLength(3);
  });

  it('leaves the bulk group pending when the owner declines', async () => {
    const { plan, deps } = await setup(libraryTree);
    const { io } = scriptedIO({ confirm: [false], choose: ['quit'] });
    const summary = await runReview(plan, { ...deps, io });
    expect(summary.bulkApproved).toBe(0);
    expect(summary.plan.entries.filter((entry) => entry.status === 'approved')).toHaveLength(0);
  });

  it('does not offer bulk approval when nothing is eligible', async () => {
    const { plan, deps } = await setup(['Sample Dir\\VID_0001.mp4']);
    const { io, printed } = scriptedIO({ choose: ['quit'] });
    await runReview(plan, { ...deps, io });
    expect(printed.some((line) => line.includes('collide with nothing'))).toBe(false);
  });

  it('records skip as rejected and does not ask about that entry again', async () => {
    const { plan, deps } = await setup(['sample.film.mkv']);
    const first = scriptedIO({ choose: ['skip'] });
    const summary = await runReview(plan, { ...deps, io: first.io });
    expect(statuses(summary.plan)).toEqual({ 'sample.film.mkv': 'rejected' });

    const second = scriptedIO({ choose: ['quit'] });
    await runReview(summary.plan, { ...deps, io: second.io });
    expect(second.offered).toEqual([]);
  });

  it('keeps decisions already made when the owner quits', async () => {
    const { plan, deps, saved } = await setup(['Dir\\VID_0001.mp4', 'Dir\\VID_0002.mp4', 'Dir\\VID_0003.mp4']);
    const { io } = scriptedIO({ choose: ['accept', 'quit'] });
    const summary = await runReview(plan, { ...deps, io });
    expect(summary).toMatchObject({ accepted: 1, left: 2 });
    expect(saved.at(-1)).toEqual(summary.plan);
    expect(Object.values(statuses(summary.plan)).filter((status) => status === 'pending')).toHaveLength(2);
  });

  it('shows the old name, the new name, and the reason', async () => {
    const { plan, deps } = await setup(['Dir\\VID_0001.mp4']);
    const { io, printed } = scriptedIO({ choose: ['quit'] });
    await runReview(plan, { ...deps, io });
    expect(printed).toContain('  old: VID_0001.mp4');
    expect(printed).toContain('  new: Dir.mp4');
    expect(printed.some((line) => line.includes('low confidence') || line.includes('high confidence'))).toBe(true);
  });

  it('applies a typed title, approves the entry, and asks again after a refused title', async () => {
    const { plan, deps } = await setup(['Dir\\VID_0001.mp4', 'Dir\\Other Name.mp4']);
    const { io, printed } = scriptedIO({ choose: ['edit', 'edit', 'quit'], ask: ['Other Name', 'Typed Title'] });
    const summary = await runReview(plan, { ...deps, io });

    expect(printed).toContain('Another file in the plan already uses that name.');
    expect(summary.edited).toBe(1);
    expect(summary.plan.entries.find((entry) => entry.source === 'Dir\\VID_0001.mp4')).toMatchObject({
      target: 'Dir\\Typed Title.mp4',
      titleSource: 'manual',
      status: 'approved',
    });
  });

  it('offers no accept action for a file that has no title, and lets the owner type one', async () => {
    const { plan, deps } = await setup(['2013.mkv']);
    const { io, offered } = scriptedIO({ choose: ['edit'], ask: ['Typed Title'] });
    const summary = await runReview(plan, { ...deps, io });
    expect(offered[0]).toEqual(['edit', 'skip', 'quit']);
    expect(summary.plan.entries[0]).toMatchObject({ target: 'Typed Title.mkv', status: 'approved' });
  });

  it('does not ask about entries whose name does not change', async () => {
    const { plan, deps } = await setup(['Sample Film.mkv']);
    const { io, offered } = scriptedIO({ choose: ['quit'] });
    await runReview(plan, { ...deps, io });
    expect(offered).toEqual([]);
  });
});
