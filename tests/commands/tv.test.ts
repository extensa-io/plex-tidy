import { describe, expect, it } from 'vitest';
import { planSchema, type PlanEntry } from '../../src/plan/schemas.ts';
import { tvResolveFileSchema } from '../../src/resolve/tv-schemas.ts';
import type { ReviewIO } from '../../src/review/review.ts';
import { readJsonFile } from '../../src/state/json-file.ts';
import { exists } from '../helpers/cli-harness.ts';
import { buildTvPlanFiles, tvHarness, type TvHarness } from '../helpers/tv-harness.ts';
import { listTree } from '../helpers/tree.ts';

async function planOf(h: TvHarness): Promise<PlanEntry[]> {
  const plan = await readJsonFile(h.paths.plan, planSchema);
  return plan?.entries ?? [];
}

function bySource(entries: readonly PlanEntry[], source: string): PlanEntry {
  const found = entries.find((entry) => entry.source === source);
  if (found === undefined) {
    throw new Error(`no plan entry for ${source}`);
  }
  return found;
}

/** Answers the review prompts from lists, and records what was printed and offered. */
function scriptedIO(actions: string[], answers: string[] = []): ReviewIO & { printed: string[]; offered: string[][] } {
  const printed: string[] = [];
  const offered: string[][] = [];
  return {
    printed,
    offered,
    print: (line) => void printed.push(line),
    confirm: () => Promise.resolve(true),
    choose: (_message, choices) => {
      offered.push(choices.map((choice) => choice.value));
      return Promise.resolve(actions.shift() ?? 'quit');
    },
    ask: () => Promise.resolve(answers.shift() ?? ''),
  };
}

const people = 'Sample People History (2000) {tmdb-9001}';
const extras = 'Extras Stand-In (2005) {tmdb-9002}';

describe('tv mode through the command line', () => {
  it('sends only the names the rules cannot read to the model, and never a path or a folder', async () => {
    const h = await tvHarness();
    await h.run('scan');
    await h.run('parse');
    expect(h.model.batches.flat().map((item) => item.name)).toEqual(['Model Show part 2']);
    expect(JSON.stringify(h.model.batches)).not.toMatch(/\\\\|Season|Model Show\\\\/);
    expect(h.lines).toContain('parsed 8 names: 7 by rules, 1 sent to the model (0 from cache, 1 requests)');
  });

  it('builds the expected plan for the four sample shapes and the rest of the corpus', async () => {
    const h = await tvHarness();
    await buildTvPlanFiles(h);
    const entries = await planOf(h);

    // An episode number with no season: season 1 is assumed, so it waits for review.
    expect(bySource(entries, 'Sample People History\\11.-.The.Great.Change.1886-1915.avi')).toMatchObject({
      status: 'pending',
      target: `${people}\\Season 01\\${people} - s01e11 - The Great Change.avi`,
      folder: { source: 'Sample People History', target: people },
    });

    // 2x06 inside a Season 2 folder: approved. The season folder is written Season 02.
    const extrasEntry = bySource(entries, 'Extras Stand-In\\Season 2\\Extras Stand-In - 2x06 - Guest Name.avi');
    expect(extrasEntry).toMatchObject({
      status: 'approved',
      target: `${extras}\\Season 02\\${extras} - s02e06 - Guest Name.avi`,
      folder: { source: 'Extras Stand-In', target: extras },
    });
    expect(extrasEntry.reason.startsWith('auto')).toBe(true);
    expect(extrasEntry.tagRecord).toMatchObject({
      title: 'Guest Name',
      show: 'Extras Stand-In',
      season: 2,
      episode: 6,
      tmdb: 'tv/9002',
      genre: ['Documentary'],
    });

    // A broadcaster prefix and an episode only.
    expect(bySource(entries, 'Sample Broadcaster Civilisation\\Sample Broadcaster Civilisation - 11 - The Worship of Nature.avi')).toMatchObject({
      status: 'pending',
      target:
        'Sample Broadcaster Civilisation (1969) {tmdb-9003}\\Season 01\\Sample Broadcaster Civilisation (1969) {tmdb-9003} - s01e11 - The Worship of Nature.avi',
    });

    // A scene name with s01e10, and its subtitle.
    const wwii = bySource(entries, 'Sample Channel WWII In HD\\aaf-wwii.in.hd.s01e10.720p.bluray.mkv');
    const wwiiStem = 'Sample Channel WWII In HD (2009) {tmdb-9004}\\Season 01\\Sample Channel WWII In HD (2009) {tmdb-9004} - s01e10 - Victory';
    expect(wwii).toMatchObject({ status: 'approved', target: `${wwiiStem}.mkv` });
    expect(wwii.sidecars).toEqual([
      { source: 'Sample Channel WWII In HD\\aaf-wwii.in.hd.s01e10.720p.bluray.en.srt', target: `${wwiiStem}.en.srt` },
    ]);

    // The Season folder and the file name disagree.
    expect(bySource(entries, 'Conflict Show\\Season 3\\conflict.show.s01e02.mkv')).toMatchObject({ status: 'pending' });
    expect(bySource(entries, 'Conflict Show\\Season 3\\conflict.show.s01e02.mkv').reason).toContain('differs from the Season folder');

    // The model read the episode; no season, so season 1 is assumed.
    expect(bySource(entries, 'Model Show\\Model Show part 2.mkv')).toMatchObject({
      status: 'pending',
      target: 'Model Show (2018) {tmdb-9300}\\Season 01\\Model Show (2018) {tmdb-9300} - s01e02 - The Second Part.mkv',
    });

    expect(bySource(entries, 'Unknown Show\\s01e01.mkv')).toMatchObject({ status: 'skipped', reason: 'unmatched' });
    expect(bySource(entries, 'Organized Show (2015) {tmdb-9100}\\Season 01\\Organized Show (2015) {tmdb-9100} - s01e01 - Pilot.mkv')).toMatchObject({
      status: 'skipped',
      reason: 'unchanged',
      folder: null,
    });
    expect(entries.filter((entry) => entry.status === 'approved')).toHaveLength(2);
    expect(h.lines.join('\n')).not.toMatch(/Sample|Extras|Conflict|Model Show/);
  });

  it('resolves each show once, however many episodes it has', async () => {
    const h = await tvHarness({
      tree: ['Model Show\\s01e01.mkv', 'Model Show\\s01e02.mkv', 'Model Show\\s01e03.mkv', 'Model Show\\Season 1\\s01e04.mkv'],
    });
    await buildTvPlanFiles(h);
    expect(h.tmdb.showSearchRequests).toHaveLength(1);
    // One season listing serves every episode.
    expect(h.tmdb.seasonRequests).toEqual(['9300/1']);
  });

  it('applies folders and renames, carries the subtitle, and undo restores the structure', async () => {
    const h = await tvHarness();
    const before = await listTree(h.root);
    await buildTvPlanFiles(h);
    await h.run('review');
    await h.run('apply', '--yes');

    const after = await listTree(h.root);
    expect(after).toContain(`${extras}\\Season 02\\${extras} - s02e06 - Guest Name.avi`);
    expect(after).toContain(`${people}\\Season 01\\${people} - s01e11 - The Great Change.avi`);
    expect(after).toContain(
      'Sample Channel WWII In HD (2009) {tmdb-9004}\\Season 01\\Sample Channel WWII In HD (2009) {tmdb-9004} - s01e10 - Victory.en.srt',
    );
    expect(await exists(`${h.root}\\Extras Stand-In`)).toBe(false);
    expect(after).toContain('Unknown Show\\s01e01.mkv');

    await h.run('undo', '--yes');
    expect(await listTree(h.root)).toEqual(before);
    // The folders the tool created are gone, and the original ones are back.
    expect(await exists(`${h.root}\\Extras Stand-In\\Season 02`)).toBe(false);
    expect(await exists(`${h.root}\\${extras}`)).toBe(false);
    expect(await exists(`${h.root}\\Extras Stand-In\\Season 2`)).toBe(true);
  });

  it('changes nothing without --yes', async () => {
    const h = await tvHarness();
    const before = await listTree(h.root);
    await buildTvPlanFiles(h);
    await h.run('review');
    await h.run('apply');
    expect(await listTree(h.root)).toEqual(before);
    expect(await exists(h.paths.journal)).toBe(false);
    expect(h.lines.some((line) => line.startsWith('folders that would be created'))).toBe(true);
  });

  it('plans an organized library as all unchanged, and the second run changes nothing', async () => {
    const h = await tvHarness();
    await buildTvPlanFiles(h);
    await h.run('review');
    await h.run('apply', '--yes');
    const organized = await listTree(h.root);

    await buildTvPlanFiles(h);
    const entries = await planOf(h);
    // Seven episodes in shape (six moved, one that was) and one unmatched file.
    expect(entries.filter((entry) => entry.reason === 'unchanged')).toHaveLength(7);
    expect(entries.filter((entry) => entry.status === 'approved')).toHaveLength(0);
    await h.run('apply', '--yes');
    expect(await listTree(h.root)).toEqual(organized);
  });

  it('moves files one by one into new folders when the show folder is only partly approved', async () => {
    const h = await tvHarness({ tree: ['Model Show\\ep 1.mkv', 'Model Show\\ep 2.mkv', 'Model Show\\notes.txt'] });
    await buildTvPlanFiles(h);
    // The season is assumed for both files, so both wait. Approve only the first.
    h.useIO(scriptedIO(['accept', 'skip']));
    await h.run('review');
    await h.run('apply', '--yes');

    const after = await listTree(h.root);
    expect(after).toContain('Model Show (2018) {tmdb-9300}\\Season 01\\Model Show (2018) {tmdb-9300} - s01e01 - Episode Title 1.mkv');
    // The other file and the note stay in the old folder, because the folder is not renamed.
    expect(after).toContain('Model Show\\ep 2.mkv');
    expect(after).toContain('Model Show\\notes.txt');
  });

  it('renames the show folder in place when every file is approved, and the other files in it go along', async () => {
    const h = await tvHarness({ tree: ['Model Show\\s01e01.mkv', 'Model Show\\s01e02.mkv', 'Model Show\\notes.txt'] });
    await buildTvPlanFiles(h);
    await h.run('apply', '--yes');

    const after = await listTree(h.root);
    expect(after).toContain('Model Show (2018) {tmdb-9300}\\notes.txt');
    expect(after).toContain('Model Show (2018) {tmdb-9300}\\Season 01\\Model Show (2018) {tmdb-9300} - s01e02 - The Second Part.mkv');
    expect(await exists(`${h.root}\\Model Show`)).toBe(false);
  });

  it('writes the resolution of every show and episode to resolve.json', async () => {
    const h = await tvHarness();
    await buildTvPlanFiles(h);
    const resolved = await readJsonFile(h.paths.resolve, tvResolveFileSchema);
    expect(resolved?.shows).toHaveLength(8);
    const assumed = resolved?.entries.filter((entry) => entry.episode?.seasonSource === 'assumed');
    expect(assumed).toHaveLength(3);
    expect(resolved?.entries.every((entry) => entry.episode !== null)).toBe(true);
  });
});

describe('--folder', () => {
  it('works on one folder while the root stays the boundary, so that folder can be renamed', async () => {
    const h = await tvHarness();
    const before = await listTree(h.root);
    await h.run('scan', '--folder', 'Extras Stand-In');
    expect(h.lines).toContain('scanned 1 video files and 0 subtitle files');
    await h.run('parse');
    await h.run('resolve');
    await h.run('plan');
    await h.run('apply', '--yes');

    const after = await listTree(h.root);
    expect(after).toContain(`${extras}\\Season 02\\${extras} - s02e06 - Guest Name.avi`);
    expect(await exists(`${h.root}\\Extras Stand-In`)).toBe(false);
    // Every other show is untouched.
    expect(after.filter((path) => !path.startsWith(extras))).toEqual(before.filter((path) => !path.startsWith('Extras Stand-In')));
  });

  it('refuses a folder outside the root, and a folder that does not exist', async () => {
    const h = await tvHarness();
    await expect(h.run('scan', '--folder', '..')).rejects.toMatchObject({ code: 'OPTION_INVALID' });
    await expect(h.run('scan', '--folder', 'No Such Folder')).rejects.toMatchObject({ code: 'OPTION_INVALID' });
    await expect(h.run('scan', '--folder', h.root)).rejects.toMatchObject({ code: 'OPTION_INVALID' });
  });

  it('accepts an absolute path inside the root', async () => {
    const h = await tvHarness();
    await h.run('scan', '--folder', `${h.root}\\Extras Stand-In`);
    expect(h.lines).toContain('scanned 1 video files and 0 subtitle files');
  });
});

describe('show decisions in review', () => {
  const twins = ['Twin Show\\s01e01.mkv', 'Twin Show\\s01e02.mkv'];

  it('sends two shows with the same name to the judge, and leaves the show open when it abstains', async () => {
    const h = await tvHarness({ tree: twins });
    await buildTvPlanFiles(h);
    const request = h.judge?.requests[0];
    expect(request).toMatchObject({ fileNames: ['s01e01', 's01e02'], episodeCount: 2 });
    expect(request?.candidates.map((candidate) => candidate.id).sort()).toEqual([9400, 9401]);
    expect((await planOf(h)).map((entry) => entry.status)).toEqual(['pending', 'pending']);
  });

  it('one show decision in review applies to all of the show\'s episodes', async () => {
    const io = scriptedIO(['pick:9401']);
    const h = await tvHarness({ tree: twins, io });
    await buildTvPlanFiles(h);
    await h.run('review');

    expect(io.offered).toHaveLength(1);
    const entries = await planOf(h);
    expect(entries.map((entry) => entry.status)).toEqual(['approved', 'approved']);
    expect(entries.map((entry) => entry.target)).toEqual([
      'Twin Show (2014) {tmdb-9401}\\Season 01\\Twin Show (2014) {tmdb-9401} - s01e01 - Beginning.mkv',
      'Twin Show (2014) {tmdb-9401}\\Season 01\\Twin Show (2014) {tmdb-9401} - s01e02 - Middle.mkv',
    ]);
    const resolved = await readJsonFile(h.paths.resolve, tvResolveFileSchema);
    expect(resolved?.shows[0]?.resolution).toMatchObject({ chosenId: 9401, via: 'manual' });
  });

  it('a judge pick is offered as a pick to keep, and never approves anything on its own', async () => {
    const io = scriptedIO(['pick:9400']);
    const h = await tvHarness({ tree: twins, io, judge: () => 9400 });
    await buildTvPlanFiles(h);
    expect((await planOf(h)).map((entry) => entry.status)).toEqual(['pending', 'pending']);

    await h.run('review');
    expect(io.offered[0]?.[0]).toBe('pick:9400');
    expect((await planOf(h)).map((entry) => entry.status)).toEqual(['approved', 'approved']);
  });

  it.each([
    ['abstains', () => null],
    ['names a show that is not a candidate', () => 424242],
    ['refuses', () => 'refused' as const],
    ['fails', () => 'failed' as const],
    ['answers in an invalid shape', () => 'invalid' as const],
  ])('leaves the show for review when the judge %s', async (_label, script) => {
    const h = await tvHarness({ tree: twins, judge: script });
    await buildTvPlanFiles(h);
    expect((await planOf(h)).map((entry) => entry.status)).toEqual(['pending', 'pending']);
    expect(process.exitCode).toBeUndefined();
  });

  it('skipping a show leaves all its files where they are', async () => {
    const io = scriptedIO(['skip']);
    const h = await tvHarness({ tree: twins, io });
    await buildTvPlanFiles(h);
    await h.run('review');
    expect((await planOf(h)).map((entry) => entry.status)).toEqual(['rejected', 'rejected']);
  });

  it('can search for a show by title and take it', async () => {
    const io = scriptedIO(['search', 'pick:9300'], ['Model Show']);
    const h = await tvHarness({ tree: twins, io });
    await buildTvPlanFiles(h);
    await h.run('review');

    expect(io.printed).toContain('TMDB found 1 shows.');
    expect((await planOf(h)).map((entry) => entry.target)).toEqual([
      'Model Show (2018) {tmdb-9300}\\Season 01\\Model Show (2018) {tmdb-9300} - s01e01 - Episode Title 1.mkv',
      'Model Show (2018) {tmdb-9300}\\Season 01\\Model Show (2018) {tmdb-9300} - s01e02 - The Second Part.mkv',
    ]);
  });

  it('takes a show by id and reports an id TMDB does not have', async () => {
    const io = scriptedIO(['id', 'id', 'pick:9300'], ['424242', '9300']);
    const h = await tvHarness({ tree: twins, io });
    await buildTvPlanFiles(h);
    await h.run('review');

    expect(io.printed).toContain('TMDB has no show with that id.');
    expect((await planOf(h)).map((entry) => entry.status)).toEqual(['approved', 'approved']);
  });

  it('leaves an unmatched show with no candidates as unmatched files', async () => {
    const h = await tvHarness({ tree: ['Unknown Show\\s01e01.mkv'] });
    await buildTvPlanFiles(h);
    expect((await planOf(h))[0]).toMatchObject({ status: 'skipped', reason: 'unmatched' });
  });
});

describe('episode decisions in review', () => {
  it('sets the season and episode typed by the owner, and approves the file', async () => {
    const io = scriptedIO(['numbers'], ['s01e03']);
    const h = await tvHarness({ tree: ['Model Show\\whatever.mkv'], io });
    await buildTvPlanFiles(h);
    expect((await planOf(h))[0]).toMatchObject({ status: 'pending', title: null });

    await h.run('review');
    expect((await planOf(h))[0]).toMatchObject({
      status: 'approved',
      titleSource: 'manual',
      target: 'Model Show (2018) {tmdb-9300}\\Season 01\\Model Show (2018) {tmdb-9300} - s01e03 - Episode Title 3.mkv',
    });
  });

  it('refuses numbers that are not a season and an episode', async () => {
    const io = scriptedIO(['numbers', 'skip'], ['banana']);
    const h = await tvHarness({ tree: ['Model Show\\whatever.mkv'], io });
    await buildTvPlanFiles(h);
    await h.run('review');
    expect(io.printed).toContain('Those are not a season and an episode. Use a form such as s02e05.');
  });

  it('flags an episode that TMDB does not list', async () => {
    const h = await tvHarness({ tree: ['Model Show\\s01e99.mkv'] });
    await buildTvPlanFiles(h);
    const [entry] = await planOf(h);
    expect(entry).toMatchObject({ status: 'pending', title: null });
    expect(entry?.reason).toContain('TMDB lists no episode 99 in season 1');
  });

  it('names a file with several episodes with both numbers and both titles', async () => {
    const h = await tvHarness({ tree: ['Model Show\\s01e01e02.mkv'] });
    await buildTvPlanFiles(h);
    const [entry] = await planOf(h);
    expect(entry).toMatchObject({
      status: 'approved',
      target: 'Model Show (2018) {tmdb-9300}\\Season 01\\Model Show (2018) {tmdb-9300} - s01e01-e02 - Episode Title 1 + The Second Part.mkv',
    });
    expect(entry?.tagRecord).toMatchObject({ episode: 1 });
  });
});

describe('a model that cannot answer', () => {
  it('leaves those files for review and goes on', async () => {
    const h = await tvHarness({ modelStatus: 'refused' });
    await buildTvPlanFiles(h);
    const entries = await planOf(h);
    expect(bySource(entries, 'Model Show\\Model Show part 2.mkv').status).toBe('pending');
    expect(bySource(entries, 'Extras Stand-In\\Season 2\\Extras Stand-In - 2x06 - Guest Name.avi').status).toBe('approved');
    expect(h.lines.join('\n')).toContain('1 refused');
  });
});
