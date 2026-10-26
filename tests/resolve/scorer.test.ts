import { describe, expect, it } from 'vitest';
import { normalizeTitle, scoreCandidate, titleSimilarity, SCORE_WEIGHTS, type CandidateFacts } from '../../src/resolve/scorer.ts';

const movie = (overrides: Partial<CandidateFacts> = {}): CandidateFacts => ({
  title: 'Sample Film',
  originalTitle: 'Sample Film',
  altTitles: [],
  year: 2010,
  runtimeMinutes: 100,
  ...overrides,
});

describe('normalizeTitle', () => {
  it.each([
    ['Película de Prueba', 'pelicula de prueba'],
    ['Sample: The Film!', 'sample the film'],
    ['Fish & Chips', 'fish and chips'],
    ["Directors' Cut", 'directors cut'],
    ['  Sample   Film  ', 'sample film'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });
});

describe('titleSimilarity', () => {
  it('ignores case, accents, and punctuation', () => {
    expect(titleSimilarity('SAMPLE: film', 'Sample Film')).toBe(1);
    expect(titleSimilarity('Pelicula', 'Película')).toBe(1);
  });

  it('falls as the titles differ', () => {
    expect(titleSimilarity('Sample Film', 'Sample Film Two')).toBeLessThan(0.8);
    expect(titleSimilarity('Sample Film', 'Other Words')).toBeLessThan(0.4);
  });
});

describe('scoreCandidate', () => {
  it('weights the title, the year, and the length 0.6, 0.25, and 0.15', () => {
    expect(SCORE_WEIGHTS).toEqual({ title: 0.6, year: 0.25, runtime: 0.15 });
    expect(scoreCandidate({ title: 'Sample Film', year: 2010, runtimeMinutes: 100 }, movie()).score).toBe(1);
  });

  it('accepts a year that is one off, but scores it lower', () => {
    const exact = scoreCandidate({ title: 'Sample Film', year: 2010, runtimeMinutes: 100 }, movie()).score;
    const oneOff = scoreCandidate({ title: 'Sample Film', year: 2011, runtimeMinutes: 100 }, movie()).score;
    const twoOff = scoreCandidate({ title: 'Sample Film', year: 2012, runtimeMinutes: 100 }, movie()).score;
    expect(oneOff).toBeCloseTo(exact - 0.25 * 0.4, 3);
    expect(twoOff).toBeCloseTo(exact - 0.25, 3);
  });

  it('accepts a length within two minutes in full', () => {
    const base = { title: 'Sample Film', year: 2010 };
    expect(scoreCandidate({ ...base, runtimeMinutes: 102 }, movie()).score).toBe(1);
    expect(scoreCandidate({ ...base, runtimeMinutes: 98 }, movie()).score).toBe(1);
    expect(scoreCandidate({ ...base, runtimeMinutes: 105 }, movie()).score).toBeLessThan(1);
    expect(scoreCandidate({ ...base, runtimeMinutes: 140 }, movie()).score).toBeCloseTo(1 - 0.15, 3);
  });

  it('counts an unknown year or length as half', () => {
    const noYear = scoreCandidate({ title: 'Sample Film', year: null, runtimeMinutes: 100 }, movie());
    expect(noYear.score).toBeCloseTo(1 - 0.25 * 0.5, 3);
    expect(noYear.reason).toContain('no year in the name');
    const noLength = scoreCandidate({ title: 'Sample Film', year: 2010, runtimeMinutes: null }, movie());
    expect(noLength.score).toBeCloseTo(1 - 0.15 * 0.5, 3);
    expect(noLength.reason).toContain('length unknown');
  });

  it('matches across accents and punctuation', () => {
    const score = scoreCandidate(
      { title: 'LA PELICULA: DE PRUEBA', year: 2010, runtimeMinutes: 100 },
      movie({ title: 'La Película de Prueba', originalTitle: 'La Película de Prueba' }),
    );
    expect(score.score).toBe(1);
  });

  it('uses the best of the title, the original title, and the other titles', () => {
    const facts = { title: 'El Laberinto', year: 2010, runtimeMinutes: 100 };
    const english = movie({ title: 'The Labyrinth', originalTitle: 'Original Words' });
    expect(scoreCandidate(facts, english).score).toBeLessThan(0.8);
    expect(scoreCandidate(facts, { ...english, altTitles: ['El Laberinto'] }).score).toBe(1);
  });

  it('tells a remake pair apart by length when the name has no year', () => {
    const file = { title: 'Sample Remake', year: null, runtimeMinutes: 118 };
    const older = scoreCandidate(file, movie({ title: 'Sample Remake', originalTitle: 'Sample Remake', year: 1990, runtimeMinutes: 113 }));
    const newer = scoreCandidate(file, movie({ title: 'Sample Remake', originalTitle: 'Sample Remake', year: 2012, runtimeMinutes: 118 }));
    expect(newer.score).toBeGreaterThan(older.score);
    expect(newer.score - older.score).toBeGreaterThanOrEqual(0.05);
  });

  it('tells a remake pair apart by year when the name has one', () => {
    const file = { title: 'Sample Remake', year: 1990, runtimeMinutes: null };
    const older = scoreCandidate(file, movie({ year: 1990, runtimeMinutes: 113 }));
    const newer = scoreCandidate(file, movie({ year: 2012, runtimeMinutes: 118 }));
    expect(older.score).toBeGreaterThan(newer.score);
  });

  it('explains the score in words', () => {
    const { reason } = scoreCandidate({ title: 'Sample Film', year: 2011, runtimeMinutes: 95 }, movie());
    expect(reason).toBe('title 100%, year differs by 1, length differs by 5 min');
  });
});
