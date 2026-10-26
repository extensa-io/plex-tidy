import { describe, expect, it } from 'vitest';
import { isSanitized, sanitizeName } from '../../src/fs-win/sanitize.ts';

describe('sanitizeName', () => {
  it.each([
    ['Sample<Title>.mkv', 'SampleTitle.mkv'],
    ['Sample "Title".mkv', 'Sample Title.mkv'],
    ['Sample Title?.mkv', 'Sample Title.mkv'],
    ['Sample*Title.mkv', 'SampleTitle.mkv'],
  ])('removes forbidden character in %s', (input, expected) => {
    expect(sanitizeName(input)).toBe(expected);
  });

  it('replaces a colon with a space and a dash', () => {
    expect(sanitizeName('Sample Title: Part Two.mkv')).toBe('Sample Title - Part Two.mkv');
  });

  it.each([
    ['Sample/Title.mkv', 'Sample-Title.mkv'],
    ['Sample\\Title.mkv', 'Sample-Title.mkv'],
    ['Sample|Title.mkv', 'Sample-Title.mkv'],
  ])('replaces slash, backslash, and pipe in %s with a dash', (input, expected) => {
    expect(sanitizeName(input)).toBe(expected);
  });

  it('removes control characters', () => {
    expect(sanitizeName('Sample\u0007Title\u0000.mkv')).toBe('SampleTitle.mkv');
  });

  it('collapses whitespace and trims the ends', () => {
    expect(sanitizeName('  Sample \t  Title  .mkv')).toBe('Sample Title .mkv');
  });

  it.each([
    ['Sample Folder.', 'Sample Folder'],
    ['Sample Folder...', 'Sample Folder'],
    ['Sample Folder . . ', 'Sample Folder'],
    ['Sample Folder   ', 'Sample Folder'],
  ])('trims trailing dots and spaces from %j', (input, expected) => {
    expect(sanitizeName(input)).toBe(expected);
  });

  it.each([
    ['CON', 'CON_'],
    ['con.mkv', 'con_.mkv'],
    ['NUL.srt', 'NUL_.srt'],
    ['Aux', 'Aux_'],
    ['PRN.en.srt', 'PRN_.en.srt'],
    ['COM1.mkv', 'COM1_.mkv'],
    ['lpt9', 'lpt9_'],
  ])('suffixes reserved device name %s', (input, expected) => {
    expect(sanitizeName(input)).toBe(expected);
  });

  it.each(['Console.mkv', 'COM10.mkv', 'Nullable Title.mkv', 'Auxiliary.mkv'])(
    'leaves non-reserved name %s unchanged',
    (input) => {
      expect(sanitizeName(input)).toBe(input);
    },
  );

  it('returns an empty string when nothing usable remains', () => {
    expect(sanitizeName('???')).toBe('');
    expect(sanitizeName(' . . ')).toBe('');
  });

  it.each(['Sample: Title?.mkv', ' CON . ', 'A/B\\C|D.mkv', 'Title...', 'Sample   "Quoted"  Name.mp4'])(
    'is idempotent for %j',
    (input) => {
      const once = sanitizeName(input);
      expect(sanitizeName(once)).toBe(once);
    },
  );
});

describe('isSanitized', () => {
  it('accepts a legal name and rejects an illegal or empty one', () => {
    expect(isSanitized('Sample Title.mkv')).toBe(true);
    expect(isSanitized('Sample?.mkv')).toBe(false);
    expect(isSanitized('')).toBe(false);
  });
});
