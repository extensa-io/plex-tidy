import type { SkippedField, TagField, TagRecord, TagSnapshot, Writer } from './schemas.ts';

export interface DesiredTags {
  desired: TagSnapshot;
  skipped: SkippedField[];
}

type OptionalField = Exclude<TagField, 'title'>;

/** Matroska global tag names. Titles live in the segment info, so `title` has no row here. */
export const mkvTagNames: Readonly<Record<OptionalField, string>> = {
  originalTitle: 'ORIGINAL_TITLE',
  dateReleased: 'DATE_RELEASED',
  synopsis: 'SYNOPSIS',
  genre: 'GENRE',
  director: 'DIRECTOR',
  actor: 'ACTOR',
  tmdb: 'TMDB',
  show: 'SHOW',
  season: 'SEASON',
  episode: 'EPISODE',
  airDate: 'AIR_DATE',
};

/**
 * MP4, M4V, and MOV fields, written with ExifTool into the iTunes-style
 * `ItemList` atoms. `null` means the container has no atom for the field.
 */
export const itemListTagNames: Readonly<Record<OptionalField, string | null>> = {
  originalTitle: null,
  dateReleased: 'ItemList:ReleaseDate',
  synopsis: 'ItemList:LongDescription',
  genre: 'ItemList:Genre',
  director: 'ItemList:Director',
  actor: 'ItemList:Performer',
  tmdb: 'ItemList:Comment',
  show: 'ItemList:TVShow',
  season: 'ItemList:TVSeason',
  episode: 'ItemList:TVEpisode',
  airDate: 'ItemList:ReleaseDate',
};

export const ITEM_LIST_TITLE = 'ItemList:Title';

/** The record's optional fields as lists of text. Numbers become text; empty values are dropped. */
function recordValues(record: TagRecord): [OptionalField, string[]][] {
  const entries: [OptionalField, string[]][] = [];
  const add = (field: OptionalField, value: string | number | readonly string[] | undefined) => {
    if (value === undefined) {
      return;
    }
    const values = (Array.isArray(value) ? [...(value as readonly string[])] : [String(value)])
      .map(oneLine)
      .filter((item) => item !== '');
    if (values.length > 0) {
      entries.push([field, values]);
    }
  };
  add('originalTitle', record.originalTitle);
  add('dateReleased', record.dateReleased);
  add('synopsis', record.synopsis);
  add('genre', record.genre);
  add('director', record.director);
  add('actor', record.actor);
  add('tmdb', record.tmdb);
  add('show', record.show);
  add('season', record.season);
  add('episode', record.episode);
  add('airDate', record.airDate);
  return entries;
}

/** Arg files and tag values are line based, so a value never holds a line break. */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export function mkvDesired(record: TagRecord): DesiredTags {
  const fields: Record<string, string[]> = {};
  for (const [field, values] of recordValues(record)) {
    fields[mkvTagNames[field]] = values;
  }
  return { desired: { title: oneLine(record.title), fields }, skipped: [] };
}

export function itemListDesired(record: TagRecord): DesiredTags {
  const fields: Record<string, string[]> = {};
  const skipped: SkippedField[] = [];
  const values = recordValues(record);
  const hasReleaseDate = values.some(([field]) => field === 'dateReleased');

  for (const [field, list] of values) {
    const name = itemListTagNames[field];
    if (name === null) {
      skipped.push({ field, reason: 'MP4 and MOV files have no atom for this field' });
    } else if (field === 'airDate' && hasReleaseDate) {
      skipped.push({ field, reason: 'the release date field already holds the release date' });
    } else {
      // These atoms hold one text value, so a list is joined.
      fields[name] = [list.join(', ')];
    }
  }
  return { desired: { title: oneLine(record.title), fields }, skipped };
}

export function desiredFor(writer: Writer, record: TagRecord): DesiredTags {
  return writer === 'mkvpropedit' ? mkvDesired(record) : itemListDesired(record);
}

/** True when `current` already holds every value that `desired` sets. Fields `desired` does not set are ignored. */
export function snapshotSatisfies(current: TagSnapshot, desired: TagSnapshot): boolean {
  if ((current.title ?? null) !== (desired.title ?? null)) {
    return false;
  }
  return Object.entries(desired.fields).every(([name, wanted]) => {
    const have = current.fields[name] ?? [];
    return have.length === wanted.length && have.every((value, index) => value === wanted[index]);
  });
}
