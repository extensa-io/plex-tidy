import { describe, expect, it } from 'vitest';
import { buildJudgeRequest, buildMovieParseRequest } from '../../src/llm/anthropic-movies.ts';
import { judgeToolInputSchema } from '../../src/llm/movie-judge.ts';
import { movieToolInputSchema } from '../../src/llm/movie-parser.ts';

describe('the movie parse request', () => {
  const items = [
    { id: 0, name: 'Sample.Film.2010.1080p' },
    { id: 1, name: 'Another Sample' },
  ];

  it('forces the tool, sends only the names as JSON data, and sets no temperature', () => {
    const request = buildMovieParseRequest('parse-model', items);
    expect(request.model).toBe('parse-model');
    expect(request.tool_choice).toEqual({ type: 'tool', name: 'report_movie_names' });
    expect(request.tools).toHaveLength(1);
    expect('temperature' in request).toBe(false);
    expect(JSON.parse(request.messages[0]?.content ?? '')).toEqual({ items });
    expect(JSON.stringify(request)).not.toContain('\\\\');
  });

  it('describes every field as nullable and all of them as required', () => {
    const schema = buildMovieParseRequest('m', items).tools[0]?.input_schema;
    expect(schema?.required).toEqual(['results']);
    const result = movieToolInputSchema.safeParse({
      results: [{ id: 0, title: null, year: null, edition: null, language: null, part: null }],
    });
    expect(result.success).toBe(true);
    expect(movieToolInputSchema.safeParse({ results: [{ id: 0, title: 'x' }] }).success).toBe(false);
  });
});

describe('the judge request', () => {
  const request = {
    fileName: 'Sample Remake HD',
    containerTitle: null,
    durationMinutes: 118,
    candidates: [
      { id: 202, title: 'Sample Remake', originalTitle: 'Sample Remake', year: 2012, runtimeMinutes: 118, overview: 'A plot.' },
    ],
  };

  it('offers the tool without forcing it, and sends the file name, the length, and the candidates, with no path', () => {
    const built = buildJudgeRequest('judge-model', request);
    expect(built.model).toBe('judge-model');
    // The Sonnet-tier models answer a forced tool choice with a 400 error.
    expect(built.tool_choice).toEqual({ type: 'auto' });
    expect(built.tools[0]?.name).toBe('choose_movie');
    const sent = JSON.parse(built.messages[0]?.content ?? '') as { file: unknown; candidates: unknown[] };
    expect(sent.file).toEqual({ name: 'Sample Remake HD', containerTitle: null, durationMinutes: 118 });
    expect(sent.candidates).toEqual(request.candidates);
    expect(JSON.stringify(built)).not.toMatch(/[A-Z]:\\\\/);
  });

  it('allows an abstention', () => {
    expect(judgeToolInputSchema.safeParse({ id: null }).success).toBe(true);
    expect(judgeToolInputSchema.safeParse({ id: 202 }).success).toBe(true);
    expect(judgeToolInputSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(judgeToolInputSchema.safeParse({}).success).toBe(false);
  });
});
