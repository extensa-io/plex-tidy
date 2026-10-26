// Synthetic names only. None of these is a real library name or a real film.
import type { MovieDetails } from '../../src/tmdb/schemas.ts';

function movie(id: number, title: string, year: number, runtimeMinutes: number, extra: Partial<MovieDetails> = {}): MovieDetails {
  return {
    id,
    title,
    originalTitle: title,
    releaseDate: `${year}-05-01`,
    year,
    runtimeMinutes,
    overview: `A synthetic plot for ${title}.`,
    genres: ['Drama'],
    directors: ['Sample Director'],
    cast: ['Actor One', 'Actor Two'],
    altTitles: [],
    ...extra,
  };
}

/** What the fake TMDB knows. */
export const catalog: readonly MovieDetails[] = [
  movie(101, 'Sample Film Alpha', 2010, 120),
  movie(201, 'Sample Remake', 1990, 113),
  movie(202, 'Sample Remake', 2012, 118),
  movie(301, 'Sample: Illegal/Chars?', 2005, 95),
  movie(401, 'The Sample Labyrinth', 2006, 105, { originalTitle: 'Zxq Wvu Original' }),
  movie(501, 'Sample Sequel 2', 2014, 100),
  movie(601, 'Directors Sample', 2001, 130),
  movie(701, 'Root Level Film', 2012, 90),
  // On TMDB but not in the library: a movie to pick in review.
  movie(801, 'Spare Film', 2003, 88),
];

/** The Spanish title that a Spanish-language search returns, by movie id. */
export const spanishTitles: Readonly<Record<number, string>> = { 401: 'El Laberinto de Muestra' };

/** Files of the synthetic library, relative to the root. */
export const moviesTree: readonly string[] = [
  // A clean name, with a subtitle that travels with it.
  'Sample Film Alpha (2010)\\Sample Film Alpha (2010).mkv',
  'Sample Film Alpha (2010)\\Sample Film Alpha (2010).en.srt',
  // Two videos in one folder: the folder keeps its name.
  'Messy\\Sample.Remake.1990.1080p.BluRay.x264-GRP.mkv',
  'Messy\\Sample.Remake.2012.720p.mkv',
  // No year: the length decides between the two remakes, and the judge is asked.
  'Messy\\Sample Remake HD.mkv',
  // Characters Windows refuses in the TMDB title.
  'Illegal\\Sample Illegal Chars (2005).mkv',
  // A Spanish title that the English search does not find.
  'Spanish\\El Laberinto de Muestra 2006.mkv',
  // Nothing on TMDB.
  'Unknown\\Totally Unknown Thing (1999).mkv',
  // An edition.
  'Edition\\Directors Sample 2001 Directors Cut.mkv',
  // Already in the final shape.
  'Sample Sequel 2 (2014) {tmdb-501}\\Sample Sequel 2 (2014) {tmdb-501}.mkv',
  // Directly in the root: only the file is renamed.
  'Root Level Film (2012).mkv',
  // Another file in the root that is not a video.
  'notes.txt',
];

export interface ModelAnswer {
  title: string | null;
  year: number | null;
  edition: string | null;
  language: string | null;
  part: string | null;
}

const answer = (title: string, year: number | null, extra: Partial<ModelAnswer> = {}): ModelAnswer => ({
  title,
  year,
  edition: null,
  language: null,
  part: null,
  ...extra,
});

/** What the stub model says for each file name that is not already clean. */
export const modelAnswers: Readonly<Record<string, ModelAnswer>> = {
  'Sample.Remake.1990.1080p.BluRay.x264-GRP': answer('Sample Remake', 1990),
  'Sample.Remake.2012.720p': answer('Sample Remake', 2012),
  'Sample Remake HD': answer('Sample Remake', null),
  'El Laberinto de Muestra 2006': answer('El Laberinto de Muestra', 2006, { language: 'es' }),
  'Directors Sample 2001 Directors Cut': answer('Directors Sample', 2001, { edition: 'Directors Cut' }),
  // A title that keeps a release tag, with the year only in the folder name.
  'sample.remake.dvd9.720p': answer('sample remake dvd9', null),
  // A trailing word that is not a known tag.
  'sample remake extra hd': answer('sample remake extra hd', null),
  // The model finds no title; the folder name has it.
  'unreadable name': answer('', null),
};

/** The length of each video in minutes, by file name without extension. */
export const durations: Readonly<Record<string, number>> = {
  'Sample Film Alpha (2010)': 120,
  'Sample.Remake.1990.1080p.BluRay.x264-GRP': 113,
  'Sample.Remake.2012.720p': 118,
  'Sample Remake HD': 118,
  'Sample Illegal Chars (2005)': 95,
  'El Laberinto de Muestra 2006': 105,
  'Directors Sample 2001 Directors Cut': 130,
  'Sample Sequel 2 (2014) {tmdb-501}': 100,
  'Root Level Film (2012)': 90,
  'sample.remake.dvd9.720p': 118,
  'sample remake extra hd': 118,
  'unreadable name': 90,
};
