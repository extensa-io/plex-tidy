import { describe, expect, it } from 'vitest';
import { ensureFreeSpace, SPACE_MARGIN_BYTES } from '../../src/tag/space.ts';
import { containerFor, containerMatrix } from '../../src/tag/containers.ts';
import { itemListDesired, mkvDesired, oneLine, snapshotSatisfies } from '../../src/tag/fields.ts';
import { buildTagsXml, globalValues, mergeGlobalTags, parseTagsXml } from '../../src/tag/matroska-tags.ts';
import { tagRecordSchema } from '../../src/tag/schemas.ts';
import { ffprobeOutputSchema, parseProbe, tagValue } from '../../src/tools/ffprobe.ts';

describe('tagRecordSchema', () => {
  it('needs only a title', () => {
    expect(tagRecordSchema.safeParse({ title: 'Sample Title' }).success).toBe(true);
    expect(tagRecordSchema.safeParse({}).success).toBe(false);
    expect(tagRecordSchema.safeParse({ title: '   ' }).success).toBe(false);
  });

  it('accepts the full field set of movies and TV', () => {
    const record = {
      title: 'Sample Title',
      originalTitle: 'Titulo Original',
      dateReleased: '2014-06-22',
      synopsis: 'A short synopsis.',
      genre: ['Drama', 'Comedy'],
      director: ['Sample Director'],
      actor: ['Actor One', 'Actor Two'],
      tmdb: 'movie/603',
      show: 'Sample Show',
      season: 2,
      episode: 5,
      airDate: '2014-06-22',
    };
    expect(tagRecordSchema.parse(record)).toEqual(record);
  });
});

describe('container matrix', () => {
  it('lists the six handled extensions', () => {
    expect(Object.keys(containerMatrix).sort()).toEqual(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.wmv']);
  });

  it.each([
    ['Sample.mkv', 'mkvpropedit'],
    ['Sample.MP4', 'exiftool'],
    ['Sample.m4v', 'exiftool'],
    ['Sample.mov', 'exiftool'],
  ])('writes %s with %s', (file, writer) => {
    expect(containerFor(file)).toMatchObject({ writer, reason: null });
  });

  it.each(['Sample.avi', 'Sample.wmv', 'Sample.xyz'])('makes %s rename-only with a reason', (file) => {
    const support = containerFor(file);
    expect(support.writer).toBeNull();
    expect(support.reason).toBeTruthy();
  });
});

describe('field mapping', () => {
  const rich = {
    title: 'Sample Title',
    originalTitle: 'Titulo Original',
    dateReleased: '2014-06-22',
    synopsis: 'Line one.\nLine two.',
    genre: ['Drama', 'Comedy'],
    director: ['Sample Director'],
    actor: ['Actor One', 'Actor Two'],
    tmdb: 'movie/603',
    show: 'Sample Show',
    season: 2,
    episode: 5,
    airDate: '2014-06-23',
  };

  it('puts a title-only record into the title and no fields', () => {
    expect(mkvDesired({ title: 'Sample Title' })).toEqual({ desired: { title: 'Sample Title', fields: {} }, skipped: [] });
    expect(itemListDesired({ title: 'Sample Title' })).toEqual({ desired: { title: 'Sample Title', fields: {} }, skipped: [] });
  });

  it('maps every field to a Matroska tag and keeps lists as separate values', () => {
    const { desired, skipped } = mkvDesired(rich);
    expect(skipped).toEqual([]);
    expect(desired.fields).toMatchObject({
      GENRE: ['Drama', 'Comedy'],
      ACTOR: ['Actor One', 'Actor Two'],
      SEASON: ['2'],
      SYNOPSIS: ['Line one. Line two.'],
      TMDB: ['movie/603'],
      ORIGINAL_TITLE: ['Titulo Original'],
    });
  });

  it('maps MP4 fields to ItemList atoms, joins lists, and reports what it cannot hold', () => {
    const { desired, skipped } = itemListDesired(rich);
    expect(desired.fields).toMatchObject({
      'ItemList:Genre': ['Drama, Comedy'],
      'ItemList:Performer': ['Actor One, Actor Two'],
      'ItemList:TVSeason': ['2'],
      'ItemList:ReleaseDate': ['2014-06-22'],
    });
    expect(skipped).toEqual([
      { field: 'originalTitle', reason: 'MP4 and MOV files have no atom for this field' },
      { field: 'airDate', reason: 'the release date field already holds the release date' },
    ]);
  });

  it('writes the air date when there is no release date', () => {
    expect(itemListDesired({ title: 'Sample', airDate: '2014-06-23' }).desired.fields).toEqual({
      'ItemList:ReleaseDate': ['2014-06-23'],
    });
  });

  it('never leaves a line break in a value', () => {
    expect(oneLine('a\r\nb\n\n  c ')).toBe('a b c');
  });
});

describe('snapshotSatisfies', () => {
  const desired = { title: 'Sample', fields: { GENRE: ['Drama', 'Comedy'] } };

  it('is true when the title and the touched fields match', () => {
    expect(snapshotSatisfies({ title: 'Sample', fields: { GENRE: ['Drama', 'Comedy'], OTHER: ['x'] } }, desired)).toBe(true);
  });

  it('is false for a different title, a missing field, or a different order', () => {
    expect(snapshotSatisfies({ title: 'Other', fields: { GENRE: ['Drama', 'Comedy'] } }, desired)).toBe(false);
    expect(snapshotSatisfies({ title: 'Sample', fields: {} }, desired)).toBe(false);
    expect(snapshotSatisfies({ title: 'Sample', fields: { GENRE: ['Comedy', 'Drama'] } }, desired)).toBe(false);
  });

  it('treats no title as a null title', () => {
    expect(snapshotSatisfies({ title: null, fields: {} }, { title: null, fields: {} })).toBe(true);
    expect(snapshotSatisfies({ title: 'Sample', fields: {} }, { title: null, fields: {} })).toBe(false);
  });
});

const sampleTagsXml = `\uFEFF<?xml version="1.0"?>
<Tags>
  <Tag>
    <Targets />
    <Simple><Name>ENCODER</Name><String>Sample Muxer</String></Simple>
    <Simple><Name>GENRE</Name><String>Old Genre</String></Simple>
  </Tag>
  <Tag>
    <Targets><TrackUID>123</TrackUID></Targets>
    <Simple><Name>DURATION</Name><String>00:00:01.000000000</String></Simple>
  </Tag>
  <Tag>
    <Targets><TargetTypeValue>50</TargetTypeValue></Targets>
    <Simple><Name>ARTIST</Name><String>Sample Artist</String></Simple>
  </Tag>
</Tags>`;

describe('Matroska tag XML', () => {
  it('reads tags, ignoring a byte-order mark', () => {
    const tags = parseTagsXml(sampleTagsXml);
    expect(tags).toHaveLength(3);
    expect(globalValues(tags, ['GENRE', 'ARTIST', 'DURATION'])).toEqual({
      GENRE: ['Old Genre'],
      ARTIST: ['Sample Artist'],
      DURATION: [],
    });
  });

  it('returns no tags for empty or tagless XML', () => {
    expect(parseTagsXml('')).toEqual([]);
    expect(parseTagsXml('<?xml version="1.0"?><Tags/>')).toEqual([]);
  });

  it('merges new values and keeps other global tags, and leaves track tags out', () => {
    const merged = mergeGlobalTags(parseTagsXml(sampleTagsXml), { GENRE: ['Drama', 'Comedy'], SEASON: ['2'] });
    const names = merged.flatMap((tag) => (tag.Simple ?? []).map((simple) => `${simple.Name}=${simple.String ?? ''}`));
    expect(names).toEqual(['ENCODER=Sample Muxer', 'GENRE=Drama', 'GENRE=Comedy', 'SEASON=2', 'ARTIST=Sample Artist']);
    expect(names.some((name) => name.startsWith('DURATION'))).toBe(false);
  });

  it('removes a managed name whose list is empty', () => {
    const merged = mergeGlobalTags(parseTagsXml(sampleTagsXml), { GENRE: [] });
    expect(globalValues(merged, ['GENRE']).GENRE).toEqual([]);
    expect(globalValues(merged, ['ENCODER']).ENCODER).toEqual(['Sample Muxer']);
  });

  it('returns no tags when nothing is left, so the block can be removed', () => {
    const only = parseTagsXml('<Tags><Tag><Targets/><Simple><Name>GENRE</Name><String>Drama</String></Simple></Tag></Tags>');
    expect(mergeGlobalTags(only, { GENRE: [] })).toEqual([]);
  });

  it('builds XML that reads back the same, with special characters escaped', () => {
    const merged = mergeGlobalTags([], { TITLE_TEXT: ['Fish & <Chips> "quoted"'], GENRE: ['Drama'] });
    const xml = buildTagsXml(merged);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('Fish &amp; &lt;Chips&gt;');
    expect(globalValues(parseTagsXml(xml), ['TITLE_TEXT', 'GENRE'])).toEqual({
      TITLE_TEXT: ['Fish & <Chips> "quoted"'],
      GENRE: ['Drama'],
    });
  });
});

describe('ffprobe output', () => {
  const full = JSON.stringify({
    format: { duration: '61.5', tags: { TITLE: 'Sample Title', encoder: 'x' } },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264', extra_field: 1 },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'spa' } },
    ],
    unknown_top_level: true,
  });

  it('reads duration, title, and tracks, and ignores extra fields', () => {
    expect(parseProbe(full)).toEqual({
      durationSeconds: 61.5,
      title: 'Sample Title',
      tracks: [
        { index: 0, type: 'video', codec: 'h264', language: null },
        { index: 1, type: 'audio', codec: 'aac', language: 'spa' },
      ],
    });
  });

  it('copes with missing fields', () => {
    expect(parseProbe('{}')).toEqual({ durationSeconds: null, title: null, tracks: [] });
    expect(parseProbe(JSON.stringify({ format: {}, streams: [{}] }))).toEqual({
      durationSeconds: null,
      title: null,
      tracks: [{ index: 0, type: 'unknown', codec: null, language: null }],
    });
  });

  it('finds the title tag whatever its case', () => {
    expect(tagValue({ Title: 'a' }, 'title')).toBe('a');
    expect(tagValue({ TITLE: 'b' }, 'title')).toBe('b');
    expect(tagValue({ title: '   ' }, 'title')).toBeNull();
    expect(tagValue({ title: 5 }, 'title')).toBeNull();
    expect(tagValue(undefined, 'title')).toBeNull();
  });

  it.each(['not json', '[1,2]', '{"streams": "nope"}', '{"format": {"tags": 5}}'])(
    'turns bad output %j into an AppError, not a raw error',
    (text) => {
      expect(() => parseProbe(text)).toThrow(expect.objectContaining({ code: 'TOOL_OUTPUT_INVALID' }));
      expect(ffprobeOutputSchema.safeParse(text).success).toBe(false);
    },
  );
});

describe('ensureFreeSpace', () => {
  const size = 1000;

  it('accepts a volume with room for the file and the margin', async () => {
    await expect(ensureFreeSpace('D:\\x', size, () => Promise.resolve(size + SPACE_MARGIN_BYTES))).resolves.toBeUndefined();
  });

  it('refuses a volume one byte short', async () => {
    await expect(ensureFreeSpace('D:\\x', size, () => Promise.resolve(size + SPACE_MARGIN_BYTES - 1))).rejects.toMatchObject({
      code: 'TAG_NO_SPACE',
    });
  });

  it('goes on when the system does not report free space', async () => {
    await expect(ensureFreeSpace('D:\\x', size, () => Promise.resolve(null))).resolves.toBeUndefined();
  });
});
