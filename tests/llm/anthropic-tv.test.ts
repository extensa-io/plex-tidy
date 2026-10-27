import { describe, expect, it } from 'vitest';
import { buildShowJudgeRequest, buildTvParseRequest } from '../../src/llm/anthropic-tv.ts';
import { showJudgeToolInputSchema } from '../../src/llm/tv-judge.ts';
import { tvToolInputSchema } from '../../src/llm/tv-parser.ts';

describe('the TV parse request', () => {
  const items = [
    { id: 0, name: 'show.name.s01e10.720p' },
    { id: 1, name: 'Another Show - 11 - Title' },
  ];

  it('forces the tool and sends only the names as JSON data', () => {
    const request = buildTvParseRequest('parse-model', items);
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'report_episode_names' });
    expect('temperature' in request).toBe(false);
    expect(JSON.parse(request.messages[0]?.content ?? '')).toEqual({ items });
    expect(JSON.stringify(request)).not.toContain('\\\\');
  });

  it('describes every field as nullable', () => {
    expect(
      tvToolInputSchema.safeParse({
        results: [{ id: 0, show: null, year: null, season: null, episode: null, episodeEnd: null, episodeTitle: null }],
      }).success,
    ).toBe(true);
    expect(tvToolInputSchema.safeParse({ results: [{ id: 0, show: 'x' }] }).success).toBe(false);
  });
});

describe('the show judge request', () => {
  const request = {
    fileNames: ['show.name.s01e10.720p', 'show.name.s01e11.720p'],
    episodeCount: 12,
    candidates: [{ id: 9400, name: 'Twin Show', originalName: 'Twin Show', year: 1994, seasons: 2, episodes: 40, overview: 'A plot.' }],
  };

  it('offers the tool without forcing it, and sends file names and candidates with no path or folder', () => {
    const built = buildShowJudgeRequest('judge-model', request);
    expect(built.tool_choice).toEqual({ type: 'auto' });
    expect(built.tools[0]?.name).toBe('choose_show');
    const sent = JSON.parse(built.messages[0]?.content ?? '') as { files: unknown; episodeFiles: number; candidates: unknown };
    expect(sent.files).toEqual(request.fileNames);
    expect(sent.episodeFiles).toBe(12);
    expect(sent.candidates).toEqual(request.candidates);
    expect(JSON.stringify(built)).not.toMatch(/[A-Z]:\\\\/);
  });

  it('allows an abstention', () => {
    expect(showJudgeToolInputSchema.safeParse({ id: null }).success).toBe(true);
    expect(showJudgeToolInputSchema.safeParse({ id: 9400 }).success).toBe(true);
    expect(showJudgeToolInputSchema.safeParse({}).success).toBe(false);
  });
});
