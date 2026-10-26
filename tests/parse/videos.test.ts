import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryParseCache } from '../../src/llm/title-parser.ts';
import { parseVideos } from '../../src/parse/videos.ts';
import { finalizeModelTitle, resolveVideos } from '../../src/resolve/videos.ts';
import { scanRoot } from '../../src/scan/scan.ts';
import type { Scan } from '../../src/scan/schemas.ts';
import { libraryTree } from '../fixtures/videos-corpus.ts';
import { createStubModel, type StubModelOptions } from '../helpers/stub-model.ts';
import { useTempDirs } from '../helpers/temp-dir.ts';
import { createTree } from '../helpers/tree.ts';

const makeTempDir = useTempDirs();

async function scanned(): Promise<{ root: string; scan: Scan }> {
  const root = await makeTempDir();
  await createTree(root, libraryTree);
  return { root, scan: await scanRoot(root) };
}

async function parseWith(scan: Scan, options: StubModelOptions = {}) {
  const model = createStubModel(options);
  const result = await parseVideos(scan, { model, cache: memoryParseCache(), batchSize: 50 });
  return { model, ...result };
}

describe('parseVideos', () => {
  it('sends a titled file as its base filename only, and an untitled file as its folder names', async () => {
    const { scan } = await scanned();
    const { model } = await parseWith(scan);

    const filenames = model.batches.filter((batch) => batch.kind === 'filename').flatMap((batch) => batch.items);
    const folders = model.batches.filter((batch) => batch.kind === 'folders').flatMap((batch) => batch.items);

    expect(filenames.every((item) => item.sources.length === 1)).toBe(true);
    expect(filenames.map((item) => item.sources[0])).toContain('SAMPLE FILM TWO');
    expect(folders.map((item) => item.sources)).toContainEqual(['Beach Day', 'Trips']);
    expect(folders.map((item) => item.sources)).toContainEqual(['Family Clips']);
  });

  it('never puts a path, a drive letter, the root, or an extension in a request', async () => {
    const { root, scan } = await scanned();
    const { model } = await parseWith(scan);

    const sent = JSON.stringify(model.batches);
    expect(sent).not.toContain(root);
    expect(sent).not.toContain(join(root, 'Trips'));
    expect(sent).not.toMatch(/[A-Za-z]:\\/);
    expect(sent).not.toContain('\\\\');
    expect(sent).not.toMatch(/\.(mkv|mp4|avi|mov|srt)"/i);
    const sources = model.batches.flatMap((batch) => batch.items.flatMap((item) => item.sources));
    expect(sources.some((source) => source.includes('\\') || source.includes('/'))).toBe(false);
  });

  it('sends nothing for an untitled file that has no folder', async () => {
    const { scan } = await scanned();
    const { model, entries } = await parseWith(scan);
    const rootFile = scan.files.find((file) => file.path === '2013.mkv');
    expect(rootFile?.titled).toBe(false);
    expect(entries.find((entry) => entry.id === rootFile?.id)?.parse.outcome).toBe('no-source');
    expect(JSON.stringify(model.batches)).not.toContain('2013');
  });

  it('marks a valid model title with the source it came from', async () => {
    const { scan } = await scanned();
    const { entries } = await parseWith(scan);
    const beach = scan.files.find((file) => file.path === 'Trips\\Beach Day\\IMG_0001.mov');
    expect(entries.find((entry) => entry.id === beach?.id)?.parse).toEqual({
      kind: 'folders',
      outcome: 'valid',
      title: 'Beach Day',
      sourceIndex: 0,
    });
  });

  it('rejects a title that invents a word', async () => {
    const { scan } = await scanned();
    const { entries, outcomes } = await parseWith(scan, { answer: (kind) => (kind === 'filename' ? 'Invented Title' : undefined) });
    expect(entries.filter((entry) => entry.parse.outcome === 'invalid').length).toBe(outcomes.invalid);
    expect(outcomes.invalid).toBeGreaterThan(0);
    expect(entries.filter((entry) => entry.parse.outcome === 'invalid').every((entry) => entry.parse.title === null)).toBe(true);
  });

  it('accepts a title from the nearest folder that holds all its words', async () => {
    const { scan } = await scanned();
    const { entries } = await parseWith(scan, { answer: (kind) => (kind === 'folders' ? 'Trips' : undefined) });
    const beach = scan.files.find((file) => file.path === 'Trips\\Beach Day\\IMG_0001.mov');
    expect(entries.find((entry) => entry.id === beach?.id)?.parse).toMatchObject({ outcome: 'valid', title: 'Trips', sourceIndex: 1 });
  });
});

describe('resolveVideos', () => {
  it('uses a valid file name title with high confidence', async () => {
    const { scan } = await scanned();
    const { entries } = await parseWith(scan);
    const file = scan.files.find((entry) => entry.stem === 'SAMPLE FILM TWO');
    const parse = entries.find((entry) => entry.id === file?.id)?.parse;
    if (file === undefined || parse === undefined) {
      throw new Error('fixture missing');
    }
    expect(resolveVideos(file, parse)).toMatchObject({ title: 'Sample Film Two', source: 'filename', confidence: 'high' });
  });

  it('uses a valid folder title with high confidence for a file with no title', async () => {
    const { scan } = await scanned();
    const { entries } = await parseWith(scan);
    const file = scan.files.find((entry) => entry.path === 'Trips\\Beach Day\\IMG_0001.mov');
    const parse = entries.find((entry) => entry.id === file?.id)?.parse;
    if (file === undefined || parse === undefined) {
      throw new Error('fixture missing');
    }
    expect(resolveVideos(file, parse)).toMatchObject({ title: 'Beach Day', source: 'folder', confidence: 'high' });
  });

  it.each(['refused', 'failed', 'invalid'] as const)(
    'falls back to the rules-only cleaner with low confidence when a batch is %s',
    async (status) => {
      const { scan } = await scanned();
      const { entries } = await parseWith(scan, { status });
      const resolved = scan.files.map((file) => {
        const parse = entries.find((entry) => entry.id === file.id)?.parse;
        if (parse === undefined) {
          throw new Error('missing parse');
        }
        return { file, resolution: resolveVideos(file, parse) };
      });

      const titledFile = resolved.find((item) => item.file.stem === 'SAMPLE FILM TWO');
      expect(titledFile?.resolution).toMatchObject({ title: 'Sample Film Two', source: 'rules-only', confidence: 'low' });
      const folderFile = resolved.find((item) => item.file.path === 'Trips\\Beach Day\\IMG_0001.mov');
      expect(folderFile?.resolution).toMatchObject({ title: 'Beach Day', source: 'rules-only', confidence: 'low' });
      const nothing = resolved.find((item) => item.file.path === '2013.mkv');
      expect(nothing?.resolution).toMatchObject({ title: null, source: 'none' });
    },
  );

  it('makes the title safe for Windows', async () => {
    const { scan } = await scanned();
    const file = scan.files[0];
    if (file === undefined) {
      throw new Error('fixture missing');
    }
    const resolution = resolveVideos(file, { kind: 'filename', outcome: 'valid', title: 'Sample: Film?', sourceIndex: 0 });
    expect(resolution.title).toBe('Sample - Film');
  });
});

describe('finalizeModelTitle', () => {
  it('turns the separators a model keeps into spaces', () => {
    expect(finalizeModelTitle('Sample.Adventure', 'Sample.Adventure.2014.1080p.BluRay.x264-GRP')).toBe('Sample Adventure');
    expect(finalizeModelTitle('Sample_Film_Two', 'Sample_Film_Two_720p')).toBe('Sample Film Two');
  });

  it('applies Title Case when the source name is entirely uppercase or lowercase', () => {
    expect(finalizeModelTitle('Sample_documentary_about_birds', 'SAMPLE_DOCUMENTARY_ABOUT_BIRDS_WEB-DL')).toBe(
      'Sample Documentary About Birds',
    );
    expect(finalizeModelTitle('sample comedy night', 'sample comedy night')).toBe('Sample Comedy Night');
  });

  it('keeps the casing the model returned when the source has mixed case', () => {
    expect(finalizeModelTitle('McSample and the Film', 'McSample.and.the.Film.1080p')).toBe('McSample and the Film');
  });

  it('still applies Title Case when the title alone is in one case', () => {
    expect(finalizeModelTitle('la pelicula de prueba', 'la pelicula de prueba DVDRip')).toBe('La Pelicula de Prueba');
  });
});
