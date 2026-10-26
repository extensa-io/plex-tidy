import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planSchema } from '../../src/plan/schemas.ts';
import { readJsonFile } from '../../src/state/json-file.ts';
import { buildUpToPlan, exists, harness } from '../helpers/cli-harness.ts';
import { createTree, listTree } from '../helpers/tree.ts';

describe('videos mode through the command line', () => {
  it('reports counts for scan', async () => {
    const h = await harness();
    await h.run('scan');
    expect(h.lines).toContain('scanned 10 video files and 3 subtitle files');
    expect(h.lines).toContain('4 files have no title in the file name');
  });

  it('runs scan, parse, resolve, plan, review, apply, and undo, and undo restores every name', async () => {
    const h = await harness();
    const before = await listTree(h.root);

    await buildUpToPlan(h);
    await h.run('review');
    await h.run('apply', '--yes');
    const renamed = await listTree(h.root);
    expect(renamed).not.toEqual(before);
    expect(renamed).toContain('Trips\\Sample Film Two.mkv');
    expect(renamed).toContain('Family Clips\\Sample Film One 02.en.srt');

    await h.run('undo', '--yes');
    expect(await listTree(h.root)).toEqual(before);

    const plan = await readJsonFile(h.paths.plan, planSchema);
    expect(plan?.entries.filter((entry) => entry.status === 'approved')).toHaveLength(8);
  });

  it('apply without --yes changes nothing on disk and writes no journal', async () => {
    const h = await harness();
    const before = await listTree(h.root);
    await buildUpToPlan(h);
    await h.run('review');

    h.lines.length = 0;
    await h.run('apply');
    expect(await listTree(h.root)).toEqual(before);
    expect(await exists(h.paths.journal)).toBe(false);
    expect(h.lines).toContain('renames that would happen: 11');
    expect(h.lines).toContain('dry run: nothing was changed. Add --yes to rename.');
  });

  it('undo without --yes changes nothing', async () => {
    const h = await harness();
    await buildUpToPlan(h);
    await h.run('review');
    await h.run('apply', '--yes');
    const renamed = await listTree(h.root);

    await h.run('undo');
    expect(await listTree(h.root)).toEqual(renamed);
  });

  it('keeps file names out of console output at the default level', async () => {
    const h = await harness();
    await buildUpToPlan(h);
    await h.run('review');
    await h.run('apply');
    await h.run('status');
    const output = h.lines.join('\n');
    expect(output).not.toMatch(/Sample Film|Beach Day|Family Clips|IMG_|VID_/);
  });

  it('prints the full rename list at debug level', async () => {
    const h = await harness({ level: 'debug' });
    await buildUpToPlan(h);
    await h.run('review');
    await h.run('apply');
    expect(h.lines.join('\n')).toContain('Trips\\SAMPLE FILM TWO.mkv -> Trips\\Sample Film Two.mkv');
  });

  it('sends no path to the model', async () => {
    const h = await harness();
    await h.run('scan');
    await h.run('parse');
    const sent = JSON.stringify(h.models.flatMap((model) => model.batches));
    expect(sent).not.toContain(h.root);
    expect(sent).not.toMatch(/[A-Za-z]:\\/);
  });

  it('uses the rules-only cleaner with low confidence when the model refuses', async () => {
    const h = await harness({ model: { status: 'refused' } });
    await buildUpToPlan(h);
    expect(h.lines.some((line) => line.startsWith('requests: 2 refused'))).toBe(true);
    const plan = await readJsonFile(h.paths.plan, planSchema);
    const changed = plan?.entries.filter((entry) => entry.status === 'pending') ?? [];
    expect(changed).toHaveLength(8);
    expect(changed.every((entry) => entry.titleSource === 'rules-only' && entry.confidence === 'low')).toBe(true);
  });

  it('produces an all-unchanged plan for a library it already organized', async () => {
    const h = await harness();
    await buildUpToPlan(h);
    await h.run('review');
    await h.run('apply', '--yes');

    await buildUpToPlan(h);
    const plan = await readJsonFile(h.paths.plan, planSchema);
    const entries = plan?.entries ?? [];
    expect(entries).toHaveLength(10);
    for (const entry of entries) {
      if (entry.source === '2013.mkv') {
        // The owner skipped this file in review, and that decision carries over.
        expect(entry).toMatchObject({ status: 'rejected', reason: 'no-title' });
      } else {
        expect(entry, entry.source).toMatchObject({ status: 'skipped', reason: 'unchanged' });
      }
    }
  });

  it('refuses to apply, and changes nothing, when a target appears after the plan', async () => {
    const h = await harness();
    await buildUpToPlan(h);
    await h.run('review');
    // Not "Sample Film Two.mkv": Windows treats that as the same file as "SAMPLE FILM TWO.mkv".
    await createTree(h.root, ['Trips\\Sample Film Three.mp4']);
    const before = await listTree(h.root);

    await expect(h.run('apply', '--yes')).rejects.toMatchObject({ code: 'PREFLIGHT_FAILED' });
    expect(await listTree(h.root)).toEqual(before);
    expect(await exists(h.paths.journal)).toBe(false);
  });

  it('tells the owner which command to run first', async () => {
    const h = await harness();
    await expect(h.run('parse')).rejects.toMatchObject({ code: 'STAGE_MISSING', message: 'Run scan first.' });
    await h.run('scan');
    await expect(h.run('resolve')).rejects.toMatchObject({ code: 'STAGE_MISSING', message: 'Run parse first.' });
    await expect(h.run('plan')).rejects.toMatchObject({ code: 'STAGE_MISSING' });
    await expect(h.run('apply')).rejects.toMatchObject({ code: 'STAGE_MISSING', message: 'Run plan first.' });
  });

  it('refuses stale parse results after a new scan', async () => {
    const h = await harness();
    await h.run('scan');
    await h.run('parse');
    await h.run('scan');
    await expect(h.run('resolve')).rejects.toMatchObject({ code: 'STAGE_STALE' });
  });

  it('reports the plan counts in status', async () => {
    const h = await harness();
    await buildUpToPlan(h);
    h.lines.length = 0;
    await h.run('status');
    expect(h.lines).toContain('scan: done; parse and resolve: done; plan: done');
    expect(h.lines).toContain('plan: 10 entries: 0 pending, 0 approved, 0 rejected, 2 skipped, 0 applied, 0 failed'.replace('0 pending', '8 pending'));
  });

  it('writes state under the mode and root hash', async () => {
    const h = await harness();
    await h.run('scan');
    expect(await exists(join(h.paths.dir, 'scan.json'))).toBe(true);
  });
});
