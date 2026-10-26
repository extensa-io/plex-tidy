// Synthetic names only. None of these is a real library name.

/** A file stem and what the rules-only cleaner must return for it. */
export const cleanerCases: readonly { label: string; input: string; expected: string }[] = [
  { label: 'clean name', input: 'Sample Film One', expected: 'Sample Film One' },
  { label: 'release tags after a year', input: 'Sample.Film.Two.2011.1080p.BluRay.x264-GRP', expected: 'Sample Film Two' },
  { label: 'underscores and web-dl', input: 'Sample_Film_Three_720p_WEB-DL_AAC2.0_H.264', expected: 'Sample Film Three' },
  { label: 'bracketed group and tags', input: '[Group] Sample Film Four [1080p][HEVC]', expected: 'Sample Film Four' },
  { label: 'site prefix', input: 'www.example-site.com - Sample Film Five 2015', expected: 'Sample Film Five' },
  { label: 'all lowercase', input: 'sample film six', expected: 'Sample Film Six' },
  { label: 'all uppercase', input: 'SAMPLE FILM SEVEN', expected: 'Sample Film Seven' },
  { label: 'small words in lowercase', input: 'the sample of the film', expected: 'The Sample of the Film' },
  { label: 'mixed case Spanish with accents', input: 'La Película de Prueba', expected: 'La Película de Prueba' },
  { label: 'lowercase Spanish', input: 'la pelicula de prueba con acentos', expected: 'La Pelicula de Prueba con Acentos' },
  { label: 'uppercase Spanish with accents', input: 'LA PELÍCULA DE PRUEBA', expected: 'La Película de Prueba' },
  { label: 'parenthesized year', input: 'Sample Film Eight (2019)', expected: 'Sample Film Eight' },
  { label: 'parentheses that are part of the title', input: 'Sample Film Nine (Part 2)', expected: 'Sample Film Nine (Part 2)' },
  { label: 'dvd tags', input: 'Sample.Film.Ten.DVDRip.XviD', expected: 'Sample Film Ten' },
  { label: 'trailing dash', input: 'Sample Film Eleven - ', expected: 'Sample Film Eleven' },
  { label: 'dolby audio tag', input: 'Sample Film Twelve DD5.1 x264', expected: 'Sample Film Twelve' },
  { label: 'dotted codec', input: 'Sample.Film.Thirteen.H.264.AAC', expected: 'Sample Film Thirteen' },
  { label: 'repack tag', input: 'Sample Film Fourteen REPACK 1080p', expected: 'Sample Film Fourteen' },
  { label: 'word that resembles a tag', input: 'Sample Web Show', expected: 'Sample Web Show' },
  { label: 'hyphenated lowercase', input: 'sample-man returns', expected: 'Sample-Man Returns' },
  { label: 'hyphenated mixed case', input: 'Sample-Man Returns', expected: 'Sample-Man Returns' },
  { label: 'dots between words', input: 'Dr.Sample.Film', expected: 'Dr Sample Film' },
  { label: 'extra spaces', input: '  Sample   Spaces  ', expected: 'Sample Spaces' },
  { label: 'leading tag', input: '1080p Sample Film', expected: 'Sample Film' },
  { label: 'year is the whole name', input: '2012', expected: '' },
  { label: 'year inside a title', input: 'Sample 2049', expected: 'Sample' },
  { label: 'only tags', input: '[1080p] [x264]', expected: '' },
  { label: 'only separators', input: '---', expected: '' },
];

/** Extra inputs for the idempotence property. Their output is not asserted. */
export const idempotenceExtras: readonly string[] = [
  '((2010))',
  '[[nested]] Title',
  'A',
  'a',
  'I',
  "don't stop",
  'ÑANDÚ FILM',
  '!!!',
  'Sample (1080p) (2010) Film',
  'THE END',
  'of',
  '1 of 2',
  '2 fast 2 sample',
  'x264 Sample',
  'Sample - - Film',
  '   ',
  '',
];

export const titledStems: readonly string[] = [
  'Sample Film One',
  'Sample.Film.Two.2011.1080p',
  '12 Angry Samples',
  'Apollo 13 Sample',
  'PXL_20230101_Birthday Sample',
];

export const untitledStems: readonly { stem: string; reason: string }[] = [
  { stem: 'VID_20230415_123456', reason: 'mostly-digits' },
  { stem: 'IMG_0001', reason: 'mostly-digits' },
  { stem: 'DSC01234', reason: 'mostly-digits' },
  { stem: 'MOV_final', reason: 'camera-prefix' },
  { stem: 'video', reason: 'generic-words' },
  { stem: 'New Recording 3', reason: 'generic-words' },
  { stem: 'Untitled', reason: 'generic-words' },
  { stem: '20230415', reason: 'mostly-digits' },
  { stem: '2012', reason: 'empty' },
];

/** A small library tree. Empty files stand in for videos and subtitles. */
export const libraryTree: readonly string[] = [
  'Family Clips\\VID_20230101_120000.mp4',
  'Family Clips\\VID_20230101_120000.en.srt',
  'Family Clips\\sample.film.one.2011.1080p.bluray.x264-grp.mkv',
  'Family Clips\\sample.film.one.2011.1080p.bluray.x264-grp.en.srt',
  'Family Clips\\sample.film.one.2011.1080p.bluray.x264-grp.es.forced.srt',
  'Family Clips\\Sample Film One.avi',
  'Trips\\Beach Day\\IMG_0001.mov',
  'Trips\\Beach Day\\IMG_0002.mov',
  'Trips\\SAMPLE FILM TWO.mkv',
  'Trips\\sample_film_three_720p.mp4',
  'Trips\\La Película de Prueba.mkv',
  '[Group] Sample Film Four [1080p].mkv',
  '2013.mkv',
  'Notes\\readme.txt',
  'Notes\\cover.jpg',
];

/** Counts for `libraryTree`. */
export const libraryTreeCounts = { files: 10, sidecars: 3, untitled: 4 };
