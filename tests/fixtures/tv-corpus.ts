// Synthetic names only. None of these is a real library name or a real show.
import type { EpisodeInfo, ShowDetails } from '../../src/tmdb/schemas.ts';

function show(id: number, name: string, year: number, seasons: Record<number, string[]>, extra: Partial<ShowDetails> = {}): ShowDetails {
  return {
    id,
    name,
    originalName: name,
    firstAirDate: `${year}-01-01`,
    year,
    overview: `A synthetic show called ${name}.`,
    genres: ['Documentary'],
    seasons: Object.entries(seasons).map(([season, titles]) => ({ season: Number(season), episodes: titles.length })),
    episodeCount: Object.values(seasons).reduce((total, titles) => total + titles.length, 0),
    altNames: [],
    ...extra,
  };
}

const numbered = (count: number, special: Record<number, string> = {}): string[] =>
  Array.from({ length: count }, (_, index) => special[index + 1] ?? `Episode Title ${index + 1}`);

/** The seasons of each show: titles in aired order. */
export const seasonTitles: Readonly<Record<number, Record<number, string[]>>> = {
  9001: { 1: numbered(13, { 11: 'The Great Change' }) },
  9002: { 1: numbered(10), 2: numbered(10, { 6: 'Guest Name' }) },
  9003: { 1: numbered(13, { 11: 'The Worship of Nature' }) },
  9004: { 1: numbered(12, { 10: 'Victory' }) },
  9100: { 1: ['Pilot', 'Second Day'] },
  9200: { 1: numbered(3), 3: numbered(3) },
  9300: { 1: numbered(4, { 2: 'The Second Part' }) },
  9400: { 1: ['Beginning', 'Middle', 'End'] },
  9401: { 1: ['Beginning', 'Middle', 'End'] },
};

/** What the fake TMDB knows. */
export const shows: readonly ShowDetails[] = [
  show(9001, 'Sample People History', 2000, seasonTitles[9001] ?? {}),
  show(9002, 'Extras Stand-In', 2005, seasonTitles[9002] ?? {}),
  show(9003, 'Sample Broadcaster Civilisation', 1969, seasonTitles[9003] ?? {}),
  show(9004, 'Sample Channel WWII In HD', 2009, seasonTitles[9004] ?? {}),
  show(9100, 'Organized Show', 2015, seasonTitles[9100] ?? {}),
  show(9200, 'Conflict Show', 2012, seasonTitles[9200] ?? {}),
  show(9300, 'Model Show', 2018, seasonTitles[9300] ?? {}),
  show(9400, 'Twin Show', 1994, seasonTitles[9400] ?? {}),
  // The same name as 9400, years apart: a show that needs the judge or a decision.
  show(9401, 'Twin Show', 2014, seasonTitles[9401] ?? {}),
];

export function episodesOf(showId: number, season: number): EpisodeInfo[] | undefined {
  const titles = seasonTitles[showId]?.[season];
  return titles?.map((name, index) => ({
    number: index + 1,
    name,
    airDate: `2001-0${(index % 9) + 1}-01`,
    overview: `Plot of ${name}.`,
  }));
}

/** Files of the synthetic library, relative to the root. */
export const tvTree: readonly string[] = [
  // An episode number with no season, dotted separators.
  'Sample People History\\11.-.The.Great.Change.1886-1915.avi',
  // 2x06 with a Season folder.
  'Extras Stand-In\\Season 2\\Extras Stand-In - 2x06 - Guest Name.avi',
  // A broadcaster prefix and an episode only.
  'Sample Broadcaster Civilisation\\Sample Broadcaster Civilisation - 11 - The Worship of Nature.avi',
  // A group-prefixed scene name, with a subtitle.
  'Sample Channel WWII In HD\\aaf-wwii.in.hd.s01e10.720p.bluray.mkv',
  'Sample Channel WWII In HD\\aaf-wwii.in.hd.s01e10.720p.bluray.en.srt',
  // Already organized.
  'Organized Show (2015) {tmdb-9100}\\Season 01\\Organized Show (2015) {tmdb-9100} - s01e01 - Pilot.mkv',
  // The Season folder and the file name disagree.
  'Conflict Show\\Season 3\\conflict.show.s01e02.mkv',
  // Nothing on TMDB.
  'Unknown Show\\s01e01.mkv',
  // A name the rules cannot read: the model reads the episode.
  'Model Show\\Model Show part 2.mkv',
];

export interface TvModelAnswer {
  show: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  episodeEnd: number | null;
  episodeTitle: string | null;
}

/** What the stub model says for each file name the rules cannot read. */
export const tvModelAnswers: Readonly<Record<string, TvModelAnswer>> = {
  'Model Show part 2': { show: 'Model Show', year: null, season: null, episode: 2, episodeEnd: null, episodeTitle: null },
};
