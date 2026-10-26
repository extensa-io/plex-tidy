import { describe, expect, it } from 'vitest';
import { isOrderedSubset, validateTitle, wordsOf } from '../../src/parse/validator.ts';

const source = 'Sample.Film.Two.2011.1080p.BluRay-GRP';

describe('wordsOf', () => {
  it('ignores case, accents, and punctuation', () => {
    expect(wordsOf("La Película, de Prueba: Don't!")).toEqual(['la', 'pelicula', 'de', 'prueba', 'don', 't']);
  });
});

describe('isOrderedSubset', () => {
  it('accepts a title that only removes words', () => {
    expect(isOrderedSubset('Sample Film Two', source)).toBe(true);
    expect(isOrderedSubset('Sample Two', source)).toBe(true);
    expect(isOrderedSubset('Sample Film Two 2011', source)).toBe(true);
  });

  it('accepts a different case and accents removed', () => {
    expect(isOrderedSubset('SAMPLE FILM TWO', source)).toBe(true);
    expect(isOrderedSubset('Pelicula', 'La Película')).toBe(true);
  });

  it('rejects a title that adds a word', () => {
    expect(isOrderedSubset('Sample Film Two Extended', source)).toBe(false);
  });

  it('rejects a title that invents a word', () => {
    expect(isOrderedSubset('Sample Movie Two', source)).toBe(false);
  });

  it('rejects a title that drops and reorders words', () => {
    expect(isOrderedSubset('Two Sample', source)).toBe(false);
    expect(isOrderedSubset('Film Sample Two', source)).toBe(false);
  });

  it('rejects a repeated word that the source has once', () => {
    expect(isOrderedSubset('Sample Sample', source)).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(isOrderedSubset('', source)).toBe(false);
    expect(isOrderedSubset('...', source)).toBe(false);
  });
});

describe('validateTitle', () => {
  it('reports the first source that holds all the words', () => {
    expect(validateTitle('Beach Day', ['Trips', 'Beach Day 2019', 'Beach Day'])).toEqual({ valid: true, sourceIndex: 1 });
  });

  it('does not combine words from two sources', () => {
    expect(validateTitle('Beach Trips', ['Trips', 'Beach Day'])).toEqual({ valid: false });
  });

  it('fails when there are no sources', () => {
    expect(validateTitle('Beach Day', [])).toEqual({ valid: false });
  });
});
