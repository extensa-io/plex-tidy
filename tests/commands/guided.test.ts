import { describe, expect, it } from 'vitest';
import { planSchema } from '../../src/plan/schemas.ts';
import type { ReviewIO } from '../../src/review/review.ts';
import { readJsonFile } from '../../src/state/json-file.ts';
import type { TagBackend } from '../../src/tag/backend.ts';
import type { Backends } from '../../src/tag/backends.ts';
import { itemListDesired, mkvDesired } from '../../src/tag/fields.ts';
import type { Writer } from '../../src/tag/schemas.ts';
import { exists, harness } from '../helpers/cli-harness.ts';
import { createTree, listTree } from '../helpers/tree.ts';

interface Question {
  message: string;
  defaultYes: boolean | undefined;
  answer: boolean;
}

/** Answers each yes/no question from the list; any question beyond the list gets No. */
function scripted(answers: readonly boolean[]) {
  const queue = [...answers];
  const asked: Question[] = [];
  const printed: string[] = [];
  const io: ReviewIO = {
    print: (line) => void printed.push(line),
    confirm: (message, defaultYes) => {
      const answer = queue.shift() ?? false;
      asked.push({ message, defaultYes, answer });
      return Promise.resolve(answer);
    },
    choose: (_message, choices) => Promise.resolve(choices.some((choice) => choice.value === 'accept') ? 'accept' : 'skip'),
    ask: () => Promise.resolve(''),
  };
  return { io, asked, printed };
}

const stepOf = (question: Question) => /^Step (\d) of 4/.exec(question.message)?.[1];

describe('videos run, the guided command', () => {
  it('asks before prepare, review, rename, and tag, and renames after three Yes answers', async () => {
    const prompts = scripted([true, true, true, true]);
    const h = await harness({ io: prompts.io });
    const before = await listTree(h.root);

    await h.run('run');

    expect(prompts.asked.map(stepOf)).toEqual(['1', '2', undefined, '3', '4']);
    expect(prompts.asked[2]?.message).toMatch(/^Approve all 3/);
    const after = await listTree(h.root);
    expect(after).not.toEqual(before);
    expect(after).toContain('Trips\\Sample Film Two.mkv');
    expect(after).toContain('Family Clips\\Sample Film One 02.en.srt');
    expect(h.lines).toContain('applied 8 entries (11 renames); 0 failed');
  });

  it('defaults prepare and review to Yes and the final rename to No', async () => {
    const prompts = scripted([true, true, true, true]);
    const h = await harness({ io: prompts.io });
    await h.run('run');
    const byStep = new Map(prompts.asked.map((question) => [stepOf(question), question.defaultYes]));
    expect(byStep.get('1')).toBe(true);
    expect(byStep.get('2')).toBe(true);
    expect(byStep.get('3')).toBe(false);
    expect(byStep.get('4')).toBe(true);
  });

  it('says how many renames and entries the final question covers, and mentions undo', async () => {
    const prompts = scripted([true, true, true, false]);
    const h = await harness({ io: prompts.io });
    await h.run('run');
    const last = prompts.asked.at(-1)?.message ?? '';
    expect(last).toContain('11 renames for 8 approved entries');
    expect(last).toContain('undo --yes');
  });

  it('changes nothing and writes no journal when the final answer is No', async () => {
    const prompts = scripted([true, true, true, false]);
    const h = await harness({ io: prompts.io });
    const before = await listTree(h.root);

    await h.run('run');

    expect(await listTree(h.root)).toEqual(before);
    expect(await exists(h.paths.journal)).toBe(false);
    expect(h.lines).toContain('Nothing was renamed. Run this command again when you are ready.');
    const plan = await readJsonFile(h.paths.plan, planSchema);
    expect(plan?.entries.filter((entry) => entry.status === 'approved')).toHaveLength(8);
  });

  it('stops without writing anything when the first answer is No and there is no plan', async () => {
    const prompts = scripted([false]);
    const h = await harness({ io: prompts.io });
    await h.run('run');
    expect(prompts.asked).toHaveLength(1);
    expect(h.models).toHaveLength(0);
    expect(await exists(h.paths.scan)).toBe(false);
    expect(h.lines.at(-1)).toContain('There is no plan yet');
  });

  it('stops before review when that answer is No, with nothing renamed', async () => {
    const prompts = scripted([true, false]);
    const h = await harness({ io: prompts.io });
    const before = await listTree(h.root);
    await h.run('run');
    expect(prompts.asked).toHaveLength(2);
    expect(await listTree(h.root)).toEqual(before);
    expect(h.lines.at(-1)).toContain('Stopped before review');
    expect(await exists(h.paths.plan)).toBe(true);
  });

  it('continues from an earlier plan when prepare is declined, and lists the renames before asking', async () => {
    const h = await harness({ io: scripted([true, true, true, false]).io });
    await h.run('run');
    const modelsBefore = h.models.length;

    const second = scripted([false, true]);
    h.useIO(second.io);
    await h.run('run');

    expect(h.models).toHaveLength(modelsBefore);
    expect(second.asked.map(stepOf)).toEqual(['1', '3', '4']);
    expect(second.printed).toContain('  SAMPLE FILM TWO.mkv  ->  Sample Film Two.mkv');
    expect(await listTree(h.root)).toContain('Trips\\Sample Film Two.mkv');
  });

  it('refuses before the rename question when a target appeared since the plan', async () => {
    const h = await harness({ io: scripted([true, true, true, false]).io });
    await h.run('run');
    await createTree(h.root, ['Trips\\Sample Film Three.mp4']);
    const before = await listTree(h.root);

    const second = scripted([false]);
    h.useIO(second.io);
    await expect(h.run('run')).rejects.toMatchObject({ code: 'PREFLIGHT_FAILED' });
    expect(second.asked).toHaveLength(1);
    expect(await listTree(h.root)).toEqual(before);
    expect(await exists(h.paths.journal)).toBe(false);
  });

  it('asks no review or rename question when everything is already organized, and offers the tag step', async () => {
    const h = await harness({ io: scripted([true, true, true, true]).io });
    await h.run('run');

    const second = scripted([true, false]);
    h.useIO(second.io);
    await h.run('run');
    expect(second.asked.map(stepOf)).toEqual(['1', '4']);
    expect(h.lines).toContain('No entry is approved, so there is nothing to rename.');
  });

  describe('the tag step', () => {
    /** Tag writers that keep nothing and record every write, so no real tool is needed. */
    function stubBackends(): { backends: Backends; written: string[] } {
      const written: string[] = [];
      const backend = (writer: Writer, desired: TagBackend['desired']): TagBackend => ({
        writer,
        desired,
        read: (_file, names) => Promise.resolve({ title: null, fields: Object.fromEntries(names.map((name) => [name, []])) }),
        write: (file) => {
          written.push(file);
          return Promise.resolve();
        },
      });
      return { backends: { mkvpropedit: backend('mkvpropedit', mkvDesired), exiftool: backend('exiftool', itemListDesired) }, written };
    }

    it('writes the tags after the rename when the owner answers Yes, with the tag command unchanged', async () => {
      const { backends, written } = stubBackends();
      const prompts = scripted([true, true, true, true, true]);
      const h = await harness({ io: prompts.io, backends });
      await h.run('run');

      expect(prompts.asked.at(-1)?.message).toMatch(/^Step 4 of 4, tag: write the title and the details into the \d+ renamed files/);
      expect(written.length).toBeGreaterThan(0);
      expect(h.lines.some((line) => /^tagged \d+ files;/.test(line))).toBe(true);
      const plan = await readJsonFile(h.paths.plan, planSchema);
      expect(plan?.entries.filter((entry) => entry.tagStatus === 'tagged').length).toBeGreaterThan(0);
    });

    it('writes no tag and says how to tag later when the owner answers No', async () => {
      const { backends, written } = stubBackends();
      const prompts = scripted([true, true, true, true, false]);
      const h = await harness({ io: prompts.io, backends });
      await h.run('run');

      expect(written).toEqual([]);
      expect(h.lines.at(-1)).toContain('Not tagged. Run the tag command when you are ready.');
      const plan = await readJsonFile(h.paths.plan, planSchema);
      expect(plan?.entries.every((entry) => entry.tagStatus === 'untagged')).toBe(true);
    });

    it('does not ask when nothing was renamed', async () => {
      const prompts = scripted([true, true, true, false]);
      const h = await harness({ io: prompts.io });
      await h.run('run');
      expect(prompts.asked.map(stepOf)).toEqual(['1', '2', undefined, '3']);
    });

    it('offers to tag renamed files from an earlier run when the run has nothing left to rename', async () => {
      const { backends, written } = stubBackends();
      const h = await harness({ io: scripted([true, true, true, true, false]).io, backends });
      await h.run('run');

      const second = scripted([false, true]);
      h.useIO(second.io);
      await h.run('run');
      expect(second.asked.map(stepOf)).toEqual(['1', '4']);
      expect(written.length).toBeGreaterThan(0);
    });
  });

  it('does not create the model when prepare is declined', async () => {
    const prompts = scripted([false]);
    const h = await harness({ io: prompts.io });
    await h.run('run');
    expect(h.models).toHaveLength(0);
  });
});
