import { describe, expect, it } from 'vitest';
import { applyCasing, smallWords } from '../../src/parse/casing.ts';
import { cleanerRules, cleanText, isReleaseTag } from '../../src/parse/cleaner.ts';
import { cleanerCases, idempotenceExtras, titledStems, untitledStems } from '../fixtures/local-corpus.ts';

describe('cleanText', () => {
  it.each(cleanerCases)('$label', ({ input, expected }) => {
    expect(cleanText(input)).toBe(expected);
  });

  it('is a fixed point: cleaning its own output changes nothing', () => {
    const inputs = [
      ...cleanerCases.map((entry) => entry.input),
      ...idempotenceExtras,
      ...titledStems,
      ...untitledStems.map((entry) => entry.stem),
    ];
    for (const input of inputs) {
      const once = cleanText(input);
      expect(cleanText(once), `input ${JSON.stringify(input)} gave ${JSON.stringify(once)}`).toBe(once);
    }
  });

  it('has named rules with distinct names', () => {
    const names = cleanerRules.map((rule) => rule.name);
    expect(names.every((name) => /^[a-z]+(-[a-z0-9]+)*$/.test(name))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('isReleaseTag', () => {
  it.each(['1080p', '720P', '2160p', '4K', 'x264', 'H265', 'BluRay', 'WEB-DL', 'x264-GROUP', 'DTS-HD', 'AAC2', 'DD5', 'REPACK'])(
    'recognizes %s',
    (token) => {
      expect(isReleaseTag(token)).toBe(true);
    },
  );

  it.each(['Web', 'Cam', 'Internal', 'Proper', 'Dual', 'Spider-Man', 'Hi-Fi', 'Sample', '1984', 'HD'])(
    'leaves %s alone',
    (token) => {
      expect(isReleaseTag(token)).toBe(false);
    },
  );
});

describe('applyCasing', () => {
  it('keeps mixed case as it is', () => {
    expect(applyCasing('McSample and the SAMPLE')).toBe('McSample and the SAMPLE');
  });

  it('capitalizes the first and last word even when they are small words', () => {
    expect(applyCasing('of mice and the')).toBe('Of Mice and The');
  });

  it('keeps small words lower inside a title, in English and Spanish', () => {
    expect(applyCasing('el hombre de la casa y el perro')).toBe('El Hombre de la Casa y el Perro');
    expect(applyCasing('lord of the samples')).toBe('Lord of the Samples');
  });

  it('does nothing to text without letters', () => {
    expect(applyCasing('1 2 3')).toBe('1 2 3');
  });

  it('has a small-word list in lowercase only', () => {
    expect([...smallWords].every((word) => word === word.toLowerCase())).toBe(true);
  });
});
