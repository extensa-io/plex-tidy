import { describe, expect, it } from 'vitest';
import { searchTitles } from '../../src/resolve/movies.ts';

describe('searchTitles', () => {
  it('starts with the title, then drops trailing words down to two words', () => {
    expect(searchTitles('Sample Film Extra Hd Cut', [])).toEqual([
      'Sample Film Extra Hd Cut',
      'Sample Film Extra Hd',
      'Sample Film Extra',
      'Sample Film',
    ]);
  });

  it('never shortens a two word title to one word', () => {
    expect(searchTitles('Sample Film', [])).toEqual(['Sample Film']);
    expect(searchTitles('Sample', [])).toEqual(['Sample']);
  });

  it('ends with the title read from the nearest folder that has one', () => {
    expect(searchTitles('Sample Film', ['---', '21.Sample.Remake.(2006)'])).toEqual(['Sample Film', 'Sample Remake']);
  });

  it('uses only the folder when the name has no title', () => {
    expect(searchTitles('', ['Sample Folder (2010)'])).toEqual(['Sample Folder']);
    expect(searchTitles('', [])).toEqual([]);
  });

  it('does not repeat a title, ignoring case', () => {
    expect(searchTitles('Sample Film', ['sample film (2010)'])).toEqual(['Sample Film']);
  });
});
