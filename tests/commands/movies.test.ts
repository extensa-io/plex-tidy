import { describe, expect, it } from 'vitest';
import { planSchema, type PlanEntry } from '../../src/plan/schemas.ts';
import { movieResolveFileSchema } from '../../src/resolve/movie-schemas.ts';
import type { ReviewIO } from '../../src/review/review.ts';
import { readJsonFile } from '../../src/state/json-file.ts';
import { exists } from '../helpers/cli-harness.ts';
import { buildMoviesPlan, moviesHarness, type MoviesHarness } from '../helpers/movies-harness.ts';
import { listTree } from '../helpers/tree.ts';

async function planOf(h: MoviesHarness): Promise<PlanEntry[]> {
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

describe('movies mode through the command line', () => {
  it('sends only the names that are not already clean to the model, and never a path', async () => {
    const h = await moviesHarness();
    await h.run('scan');
    await h.run('parse');
    const sent = h.model.batches.flat().map((item) => item.name);
    expect(sent.sort()).toEqual([
      'Directors Sample 2001 Directors Cut',
      'El Laberinto de Muestra 2006',
      'Sample Remake HD',
      'Sample.Remake.1990.1080p.BluRay.x264-GRP',
      'Sample.Remake.2012.720p',
    ]);
    expect(sent.some((name) => name.includes('\\'))).toBe(false);
    expect(h.lines).toContain('parsed 10 names: 1 with a TMDB id, 4 clean, 5 sent to the model (0 from cache, 1 requests)');
  });

  it('builds the expected plan for the corpus', async () => {
    const h = await moviesHarness();
    await buildMoviesPlan(h);
    const entries = await planOf(h);

    const alpha = bySource(entries, 'Sample Film Alpha (2010)\\Sample Film Alpha (2010).mkv');
    expect(alpha).toMatchObject({
      status: 'approved',
      target: 'Sample Film Alpha (2010) {tmdb-101}\\Sample Film Alpha (2010) {tmdb-101}.mkv',
      folder: { source: 'Sample Film Alpha (2010)', target: 'Sample Film Alpha (2010) {tmdb-101}' },
      sidecars: [
        {
          source: 'Sample Film Alpha (2010)\\Sample Film Alpha (2010).en.srt',
          target: 'Sample Film Alpha (2010) {tmdb-101}\\Sample Film Alpha (2010) {tmdb-101}.en.srt',
        },
      ],
    });
    expect(alpha.reason.startsWith('auto')).toBe(true);
    expect(alpha.tagRecord).toMatchObject({
      title: 'Sample Film Alpha',
      tmdb: 'movie/101',
      director: ['Sample Director'],
      actor: ['Actor One', 'Actor Two'],
      genre: ['Drama'],
      dateReleased: '2010-05-01',
    });

    // The remakes are told apart by year. The folder holds three videos, so it keeps its name.
    expect(bySource(entries, 'Messy\\Sample.Remake.1990.1080p.BluRay.x264-GRP.mkv')).toMatchObject({
      status: 'approved',
      target: 'Messy\\Sample Remake (1990) {tmdb-201}.mkv',
      folder: null,
    });
    expect(bySource(entries, 'Messy\\Sample.Remake.2012.720p.mkv')).toMatchObject({
      status: 'approved',
      target: 'Messy\\Sample Remake (2012) {tmdb-202}.mkv',
    });

    // No year and a judge that abstains: the entry waits for review.
    expect(bySource(entries, 'Messy\\Sample Remake HD.mkv')).toMatchObject({ status: 'pending', title: null, target: 'Messy\\Sample Remake HD.mkv' });

    // Characters Windows refuses are replaced in the folder and the file.
    expect(bySource(entries, 'Illegal\\Sample Illegal Chars (2005).mkv').target).toBe(
      'Sample - Illegal-Chars (2005) {tmdb-301}\\Sample - Illegal-Chars (2005) {tmdb-301}.mkv',
    );

    // The Spanish title is found by the second pass, and the name uses the original title.
    expect(bySource(entries, 'Spanish\\El Laberinto de Muestra 2006.mkv')).toMatchObject({
      status: 'approved',
      target: 'Zxq Wvu Original (2006) {tmdb-401}\\Zxq Wvu Original (2006) {tmdb-401}.mkv',
    });
    expect(h.tmdb.searches.some((search) => search.startsWith('es-ES:El Laberinto de Muestra'))).toBe(true);

    expect(bySource(entries, 'Unknown\\Totally Unknown Thing (1999).mkv')).toMatchObject({ status: 'skipped', reason: 'unmatched' });

    expect(bySource(entries, 'Edition\\Directors Sample 2001 Directors Cut.mkv').target).toBe(
      'Directors Sample (2001) {tmdb-601}\\Directors Sample (2001) {tmdb-601} {edition-Directors Cut}.mkv',
    );

    expect(
      bySource(entries, 'Sample Sequel 2 (2014) {tmdb-501}\\Sample Sequel 2 (2014) {tmdb-501}.mkv'),
    ).toMatchObject({ status: 'skipped', reason: 'unchanged', folder: null });

    // A file directly in the root keeps the root as its folder.
    expect(bySource(entries, 'Root Level Film (2012).mkv')).toMatchObject({
      status: 'approved',
      target: 'Root Level Film (2012) {tmdb-701}.mkv',
      folder: null,
    });

    expect(entries.filter((entry) => entry.status === 'approved')).toHaveLength(7);
    expect(h.lines.join('\n')).not.toMatch(/Sample|Laberinto|Directors/);
  });

  it('applies the folder and file renames, carries the subtitle, and undo restores everything', async () => {
    const h = await moviesHarness();
    const before = await listTree(h.root);
    await buildMoviesPlan(h);

    await h.run('apply', '--yes');
    const after = await listTree(h.root);
    expect(after).toContain('Sample Film Alpha (2010) {tmdb-101}\\Sample Film Alpha (2010) {tmdb-101}.mkv');
    expect(after).toContain('Sample Film Alpha (2010) {tmdb-101}\\Sample Film Alpha (2010) {tmdb-101}.en.srt');
    expect(after).toContain('Messy\\Sample Remake (1990) {tmdb-201}.mkv');
    expect(after).toContain('Root Level Film (2012) {tmdb-701}.mkv');
    expect(after).toContain('notes.txt');
    expect(await exists(`${h.root}\\Sample Film Alpha (2010)`)).toBe(false);

    await h.run('undo', '--yes');
    expect(await listTree(h.root)).toEqual(before);
    expect(await exists(`${h.root}\\Sample Film Alpha (2010)\\Sample Film Alpha (2010).en.srt`)).toBe(true);
  });

  it('changes nothing without --yes', async () => {
    const h = await moviesHarness();
    const before = await listTree(h.root);
    await buildMoviesPlan(h);
    await h.run('apply');
    expect(await listTree(h.root)).toEqual(before);
    expect(await exists(h.paths.journal)).toBe(false);
  });

  it('plans an organized library as all unchanged, and the second run changes nothing', async () => {
    const h = await moviesHarness();
    await buildMoviesPlan(h);
    await h.run('apply', '--yes');
    const organized = await listTree(h.root);

    await buildMoviesPlan(h);
    const entries = await planOf(h);
    const applied = entries.filter((entry) => entry.reason === 'unchanged');
    // Seven renamed files and the one that was already in shape.
    expect(applied).toHaveLength(8);
    expect(entries.filter((entry) => entry.status === 'approved')).toHaveLength(0);

    await h.run('apply', '--yes');
    expect(await listTree(h.root)).toEqual(organized);
  });

  it('writes the resolution of every file to resolve.json', async () => {
    const h = await moviesHarness();
    await buildMoviesPlan(h);
    const resolved = await readJsonFile(h.paths.resolve, movieResolveFileSchema);
    expect(resolved?.entries).toHaveLength(10);
    const remakeHd = resolved?.entries.find((entry) => entry.parse.title === 'Sample Remake' && entry.parse.year === null);
    expect(remakeHd?.probe).toEqual({ durationSeconds: 118 * 60, title: null });
    expect(remakeHd?.candidates.map((candidate) => candidate.details.id)).toEqual([202, 201]);
    expect(remakeHd?.resolution).toMatchObject({ chosenId: null, via: 'none' });
  });
});

describe('names that need more than the file title', () => {
  it('removes a release tag the model left in the title, and takes the year from the folder name', async () => {
    const h = await moviesHarness({ tree: ['Hints\\21.Sample.Remake.(2012)\\sample.remake.dvd9.720p.mkv'] });
    await buildMoviesPlan(h);
    const [entry] = await planOf(h);
    expect(entry).toMatchObject({
      status: 'approved',
      target: 'Hints\\Sample Remake (2012) {tmdb-202}\\Sample Remake (2012) {tmdb-202}.mkv',
    });
    expect(entry?.reason).toContain('the year comes from the folder name');
    // The folder name never reaches the model.
    expect(JSON.stringify(h.model.batches)).not.toMatch(/21\.Sample|Hints/);
  });

  it('searches again with fewer words when a trailing word finds nothing', async () => {
    const h = await moviesHarness({ tree: ['Misc\\sample remake extra hd.mkv'] });
    await buildMoviesPlan(h);
    expect(h.tmdb.searches.map((search) => search.split(':')[1])).toEqual(
      expect.arrayContaining(['Sample Remake Extra Hd', 'Sample Remake Extra', 'Sample Remake']),
    );
    const resolved = await readJsonFile(h.paths.resolve, movieResolveFileSchema);
    expect(resolved?.entries[0]?.candidates.map((candidate) => candidate.details.id)).toEqual([202, 201]);
  });

  it('falls back to the folder name when the model finds no title', async () => {
    const h = await moviesHarness({ tree: ['Root Level Film (2012)\\unreadable name.mkv'] });
    await buildMoviesPlan(h);
    const [entry] = await planOf(h);
    expect(entry).toMatchObject({
      status: 'approved',
      target: 'Root Level Film (2012) {tmdb-701}\\Root Level Film (2012) {tmdb-701}.mkv',
    });
  });
});

describe('the judge in the command line', () => {
  it('a pick that is a candidate goes to review as a proposal, and a duplicate target is flagged', async () => {
    const h = await moviesHarness({ judge: () => 202 });
    await buildMoviesPlan(h);
    const entries = await planOf(h);

    const picked = bySource(entries, 'Messy\\Sample Remake HD.mkv');
    expect(picked).toMatchObject({ titleSource: 'judge', confidence: 'low', collision: true, status: 'pending' });
    // The 2012 file already resolves to the same name, so both wait.
    expect(bySource(entries, 'Messy\\Sample.Remake.2012.720p.mkv')).toMatchObject({ collision: true, status: 'pending' });
    const request = h.judge?.requests[0];
    expect(request).toMatchObject({ fileName: 'Sample Remake HD', durationMinutes: 118 });
    expect(request?.candidates.map((candidate) => candidate.id)).toEqual([202, 201]);
  });

  it.each([
    ['abstains', () => null],
    ['names a movie that is not a candidate', () => 999],
    ['refuses', () => 'refused' as const],
    ['fails', () => 'failed' as const],
    ['answers in an invalid shape', () => 'invalid' as const],
  ])('leaves the entry for review when the judge %s', async (_label, script) => {
    const h = await moviesHarness({ judge: script });
    await buildMoviesPlan(h);
    const entry = bySource(await planOf(h), 'Messy\\Sample Remake HD.mkv');
    expect(entry).toMatchObject({ status: 'pending', title: null, target: 'Messy\\Sample Remake HD.mkv' });
    expect(process.exitCode).toBeUndefined();
  });

  it('runs without a judge', async () => {
    const h = await moviesHarness({ judge: 'none' });
    await buildMoviesPlan(h);
    expect(bySource(await planOf(h), 'Messy\\Sample Remake HD.mkv').status).toBe('pending');
  });
});

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

describe('review in movies mode', () => {
  it('offers the candidates and the search, and no typed title', async () => {
    const io = scriptedIO(['skip', 'skip']);
    const h = await moviesHarness({ io });
    await buildMoviesPlan(h);
    await h.run('review');

    // The open entries are the unmatched file and the one with two candidates.
    expect(io.offered).toHaveLength(2);
    const withCandidates = io.offered.find((values) => values.includes('pick:202'));
    expect(withCandidates).toEqual(['pick:202', 'pick:201', 'search', 'id', 'skip', 'quit']);
    expect(io.offered.some((values) => values.includes('edit'))).toBe(false);
    expect(io.offered.some((values) => values.includes('accept'))).toBe(false);
  });

  it('refuses a candidate whose name another entry uses, then takes a movie found by search', async () => {
    // Order: the file with candidates comes before the unmatched one.
    const io = scriptedIO(['pick:202', 'search', 'pick:801', 'skip'], ['Spare Film']);
    const h = await moviesHarness({ io });
    await buildMoviesPlan(h);
    await h.run('review');

    expect(io.printed).toContain('Another entry in the plan already uses that name.');
    expect(io.printed).toContain('TMDB found 1 movies.');
    const entry = bySource(await planOf(h), 'Messy\\Sample Remake HD.mkv');
    expect(entry).toMatchObject({
      status: 'approved',
      titleSource: 'manual',
      title: 'Spare Film',
      target: 'Messy\\Spare Film (2003) {tmdb-801}.mkv',
      folder: null,
    });
    expect(entry.tagRecord).toMatchObject({ tmdb: 'movie/801' });
  });

  it('takes a movie by id and reports an id TMDB does not have', async () => {
    const io = scriptedIO(['id', 'id', 'pick:801', 'skip'], ['424242', '801']);
    const h = await moviesHarness({ io });
    await buildMoviesPlan(h);
    await h.run('review');

    expect(io.printed).toContain('TMDB has no movie with that id.');
    expect(bySource(await planOf(h), 'Messy\\Sample Remake HD.mkv').target).toBe('Messy\\Spare Film (2003) {tmdb-801}.mkv');
  });

  it('can match a file that no search found', async () => {
    const io = scriptedIO(['skip', 'id', 'pick:801'], ['801']);
    const h = await moviesHarness({ io });
    await buildMoviesPlan(h);
    await h.run('review');

    const entry = bySource(await planOf(h), 'Unknown\\Totally Unknown Thing (1999).mkv');
    expect(entry).toMatchObject({
      status: 'approved',
      target: 'Spare Film (2003) {tmdb-801}\\Spare Film (2003) {tmdb-801}.mkv',
      folder: { source: 'Unknown', target: 'Spare Film (2003) {tmdb-801}' },
    });
  });

  it('keeps a skipped file where it is', async () => {
    const io = scriptedIO(['skip', 'skip']);
    const h = await moviesHarness({ io });
    await buildMoviesPlan(h);
    await h.run('review');
    const entries = await planOf(h);
    expect(bySource(entries, 'Messy\\Sample Remake HD.mkv').status).toBe('rejected');
    expect(bySource(entries, 'Unknown\\Totally Unknown Thing (1999).mkv').status).toBe('rejected');
  });

  it('does not offer to accept a proposal that collides with another entry', async () => {
    // The judge picks the 1990 film for the file whose name has no year. The 1990 file already resolves to it.
    const io = scriptedIO(['skip', 'skip', 'skip']);
    const h = await moviesHarness({ io, judge: () => 201 });
    await buildMoviesPlan(h);
    await h.run('review');
    const offeredAccept = io.offered.filter((values) => values.includes('accept'));
    // Entries flagged as colliding cannot be accepted.
    expect(offeredAccept).toHaveLength(0);
  });
});

describe('a model that cannot answer', () => {
  it('leaves those files unmatched and goes on', async () => {
    const h = await moviesHarness({ modelStatus: 'refused' });
    await buildMoviesPlan(h);
    const entries = await planOf(h);
    expect(bySource(entries, 'Messy\\Sample.Remake.2012.720p.mkv')).toMatchObject({ status: 'skipped', reason: 'unmatched' });
    // The clean names did not need the model.
    expect(bySource(entries, 'Sample Film Alpha (2010)\\Sample Film Alpha (2010).mkv').status).toBe('approved');
    expect(h.lines.join('\n')).toContain('1 refused');
  });
});
