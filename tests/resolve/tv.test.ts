import { describe, expect, it } from 'vitest';
import { SHOW_SCORE_WEIGHTS, scoreShow } from '../../src/resolve/tv.ts';

const show = { name: 'Sample Show', originalName: 'Sample Show', altNames: [] as string[], year: 2010 };

describe('scoreShow', () => {
  it('weights the name 0.8 and the first air year 0.2', () => {
    expect(SHOW_SCORE_WEIGHTS).toEqual({ title: 0.8, year: 0.2 });
    expect(scoreShow({ title: 'Sample Show', year: 2010 }, show).score).toBe(1);
  });

  it('counts a missing year in the folder name as no contradiction', () => {
    const { score, reason } = scoreShow({ title: 'Sample Show', year: null }, show);
    expect(score).toBe(1);
    expect(reason).toContain('no year in the folder name');
  });

  it('lowers the score for a year that is one off, and more for one that is far off', () => {
    const exact = scoreShow({ title: 'Sample Show', year: 2010 }, show).score;
    expect(scoreShow({ title: 'Sample Show', year: 2011 }, show).score).toBeCloseTo(exact - 0.2 * 0.4, 3);
    expect(scoreShow({ title: 'Sample Show', year: 1999 }, show).score).toBeCloseTo(exact - 0.2, 3);
  });

  it('tells two shows with the same name apart by year', () => {
    const older = scoreShow({ title: 'Sample Show', year: 1994 }, { ...show, year: 1994 });
    const newer = scoreShow({ title: 'Sample Show', year: 1994 }, { ...show, year: 2014 });
    expect(older.score).toBeGreaterThan(newer.score);
  });

  it('matches across accents and punctuation, and across the original name', () => {
    expect(scoreShow({ title: 'EL SHOW: de Prueba', year: null }, { ...show, name: 'The Show', originalName: 'El Show de Prueba' }).score).toBe(1);
  });

  it('uses the other names a search matched', () => {
    const facts = { title: 'Le Spectacle', year: null };
    expect(scoreShow(facts, { ...show, name: 'The Show', originalName: 'The Show' }).score).toBeLessThan(0.7);
    expect(scoreShow(facts, { ...show, name: 'The Show', originalName: 'The Show', altNames: ['Le Spectacle'] }).score).toBe(1);
  });
});
