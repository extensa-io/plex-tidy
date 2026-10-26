import { describe, expect, it } from 'vitest';
import { buildRequest } from '../../src/llm/anthropic.ts';
import { PARSE_PROMPT_VERSION, TITLE_TOOL_NAME } from '../../src/llm/prompts.ts';
import { cacheKey, memoryParseCache, proposeTitles, type TitleInput } from '../../src/llm/title-parser.ts';
import { createStubModel } from '../helpers/stub-model.ts';

function inputs(count: number, kind: TitleInput['kind'] = 'filename'): TitleInput[] {
  return Array.from({ length: count }, (_, index) => ({ key: `k${index}`, kind, sources: [`Sample Film ${index}`] }));
}

describe('proposeTitles', () => {
  it('splits requests into batches of the configured size', async () => {
    const model = createStubModel();
    const { answers, stats } = await proposeTitles(inputs(120), { model, cache: memoryParseCache(), batchSize: 50 });
    expect(model.batches.map((batch) => batch.items.length).sort((a, b) => b - a)).toEqual([50, 50, 20]);
    expect(stats).toMatchObject({ requested: 120, batches: 3, cached: 0, inputTokens: 30, outputTokens: 15 });
    expect(answers.size).toBe(120);
  });

  it('maps each answer back to the caller key through the batch position', async () => {
    const model = createStubModel();
    const { answers } = await proposeTitles(inputs(60), { model, cache: memoryParseCache(), batchSize: 50 });
    expect(answers.get('k0')).toBe('Sample Film 0');
    expect(answers.get('k59')).toBe('Sample Film 59');
  });

  it('keeps file names and folder lists in separate requests', async () => {
    const model = createStubModel();
    const mixed: TitleInput[] = [
      { key: 'a', kind: 'filename', sources: ['Sample Film'] },
      { key: 'b', kind: 'folders', sources: ['Beach Day', 'Trips'] },
    ];
    await proposeTitles(mixed, { model, cache: memoryParseCache(), batchSize: 50 });
    expect(model.batches.map((batch) => batch.kind).sort()).toEqual(['filename', 'folders']);
  });

  it('answers a second run from the cache without calling the model', async () => {
    const cache = memoryParseCache();
    await proposeTitles(inputs(5), { model: createStubModel(), cache, batchSize: 50 });

    const second = createStubModel();
    const { answers, stats } = await proposeTitles(inputs(5), { model: second, cache, batchSize: 50 });
    expect(second.batches).toHaveLength(0);
    expect(stats).toMatchObject({ cached: 5, batches: 0 });
    expect(answers.size).toBe(5);
  });

  it('invalidates the cache when the prompt version changes', async () => {
    const cache = memoryParseCache();
    await proposeTitles(inputs(3), { model: createStubModel(), cache, batchSize: 50, promptVersion: 'v1' });
    const second = createStubModel();
    await proposeTitles(inputs(3), { model: second, cache, batchSize: 50, promptVersion: 'v2' });
    expect(second.batches).toHaveLength(1);
  });

  it.each([
    ['refused', 'refusedBatches'],
    ['failed', 'failedBatches'],
    ['invalid', 'invalidBatches'],
  ] as const)('treats a %s batch as no result and does not cache it', async (status, counter) => {
    const cache = memoryParseCache();
    const { answers, stats } = await proposeTitles(inputs(4), { model: createStubModel({ status }), cache, batchSize: 50 });
    expect(answers.size).toBe(0);
    expect(stats[counter]).toBe(1);
    expect(cache.get(cacheKey('filename', ['Sample Film 0'], PARSE_PROMPT_VERSION))).toBeUndefined();
  });

  it('keeps a null title as an answer so the file falls back to the rules-only cleaner', async () => {
    const model = createStubModel({ answer: () => null });
    const { answers } = await proposeTitles(inputs(2), { model, cache: memoryParseCache(), batchSize: 50 });
    expect(answers.get('k0')).toBeNull();
  });

  it('ignores a result whose id is outside the batch', async () => {
    const { answers } = await proposeTitles(inputs(2), {
      model: {
        proposeBatch: () =>
          Promise.resolve({
            status: 'ok',
            results: [
              { id: 0, title: 'Sample Film 0' },
              { id: 99, title: 'Invented' },
            ],
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
      },
      cache: memoryParseCache(),
      batchSize: 50,
    });
    expect([...answers.keys()]).toEqual(['k0']);
  });
});

describe('buildRequest', () => {
  const request = buildRequest('parse-model', {
    kind: 'folders',
    items: [{ id: 0, sources: ['Beach Day', 'Trips'] }],
  });

  it('forces the title tool and sends no temperature, which current models reject', () => {
    expect(request).not.toHaveProperty('temperature');
    expect(request.tool_choice).toEqual({ type: 'tool', name: TITLE_TOOL_NAME });
    expect(request.tools[0]?.name).toBe(TITLE_TOOL_NAME);
    expect(request.tools[0]?.input_schema.type).toBe('object');
  });

  it('has a tool schema with one nullable title per result', () => {
    const schema = JSON.stringify(request.tools[0]?.input_schema);
    expect(schema).toContain('"title"');
    expect(schema).toContain('"null"');
  });

  it('sends names as JSON data in the user message', () => {
    expect(JSON.parse(request.messages[0]?.content ?? '')).toEqual({
      items: [{ id: 0, folders: ['Beach Day', 'Trips'] }],
    });
  });
});
