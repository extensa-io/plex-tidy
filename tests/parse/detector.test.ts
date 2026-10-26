import { describe, expect, it } from 'vitest';
import { detectTitle } from '../../src/parse/detector.ts';
import { titledStems, untitledStems } from '../fixtures/videos-corpus.ts';

describe('detectTitle', () => {
  it.each(titledStems)('finds a title in %s', (stem) => {
    expect(detectTitle(stem)).toEqual({ titled: true });
  });

  it.each(untitledStems)('finds no title in $stem ($reason)', ({ stem, reason }) => {
    expect(detectTitle(stem)).toEqual({ titled: false, reason });
  });
});
