import { createHash } from 'node:crypto';
import pLimit from 'p-limit';
import { readJsonFile, writeJsonFile } from '../state/json-file.ts';
import type { TitleModel, TokenUsage } from './model-client.ts';
import { PARSE_PROMPT_VERSION } from './prompts.ts';
import { PARSE_CACHE_SCHEMA_VERSION, parseCacheSchema, type ParseCacheFile, type TitleKind } from './schemas.ts';

const MODEL_CONCURRENCY = 3;
const CACHE_MODE = 'local';

export interface ParseCache {
  get(key: string): { title: string | null } | undefined;
  set(key: string, title: string | null): void;
  save(): Promise<void>;
}

export async function loadParseCache(file: string): Promise<ParseCache> {
  const stored = await readJsonFile(file, parseCacheSchema);
  const entries: ParseCacheFile['entries'] = { ...stored?.entries };
  let dirty = false;
  return {
    get: (key) => entries[key],
    set: (key, title) => {
      entries[key] = { title };
      dirty = true;
    },
    save: async () => {
      if (dirty) {
        await writeJsonFile(file, parseCacheSchema, { schemaVersion: PARSE_CACHE_SCHEMA_VERSION, entries });
        dirty = false;
      }
    },
  };
}

/** In-memory cache for tests and for runs that do not persist. */
export function memoryParseCache(): ParseCache {
  const entries = new Map<string, { title: string | null }>();
  return {
    get: (key) => entries.get(key),
    set: (key, title) => {
      entries.set(key, { title });
    },
    save: () => Promise.resolve(),
  };
}

export function cacheKey(kind: TitleKind, sources: readonly string[], promptVersion: string): string {
  return createHash('sha256')
    .update(JSON.stringify([CACHE_MODE, kind, promptVersion, sources]))
    .digest('hex')
    .slice(0, 32);
}

export interface TitleInput {
  /** The caller's id for the entry. */
  key: string;
  kind: TitleKind;
  sources: readonly string[];
}

export interface ParseStats extends TokenUsage {
  requested: number;
  cached: number;
  batches: number;
  refusedBatches: number;
  failedBatches: number;
  invalidBatches: number;
}

export interface ParseOptions {
  model: TitleModel;
  cache: ParseCache;
  batchSize: number;
  promptVersion?: string;
}

export interface ParseOutput {
  /** Keys the model answered. A `null` title means the model found none. Missing keys have no result. */
  answers: Map<string, string | null>;
  stats: ParseStats;
}

export async function proposeTitles(inputs: readonly TitleInput[], options: ParseOptions): Promise<ParseOutput> {
  const promptVersion = options.promptVersion ?? PARSE_PROMPT_VERSION;
  const answers = new Map<string, string | null>();
  const stats: ParseStats = {
    requested: inputs.length,
    cached: 0,
    batches: 0,
    refusedBatches: 0,
    failedBatches: 0,
    invalidBatches: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  const pending: { input: TitleInput; cacheKey: string }[] = [];
  for (const input of inputs) {
    const key = cacheKey(input.kind, input.sources, promptVersion);
    const hit = options.cache.get(key);
    if (hit === undefined) {
      pending.push({ input, cacheKey: key });
    } else {
      answers.set(input.key, hit.title);
      stats.cached += 1;
    }
  }

  const limit = pLimit(MODEL_CONCURRENCY);
  const jobs: Promise<void>[] = [];
  for (const kind of ['filename', 'folders'] as const) {
    const ofKind = pending.filter((entry) => entry.input.kind === kind);
    for (let start = 0; start < ofKind.length; start += options.batchSize) {
      const chunk = ofKind.slice(start, start + options.batchSize);
      jobs.push(
        limit(async () => {
          const outcome = await options.model.proposeBatch({
            kind,
            items: chunk.map((entry, id) => ({ id, sources: entry.input.sources })),
          });
          stats.batches += 1;
          stats.inputTokens += outcome.usage.inputTokens;
          stats.outputTokens += outcome.usage.outputTokens;

          if (outcome.status === 'ok') {
            for (const result of outcome.results) {
              const entry = chunk[result.id];
              if (entry !== undefined && !answers.has(entry.input.key)) {
                answers.set(entry.input.key, result.title);
                options.cache.set(entry.cacheKey, result.title);
              }
            }
          } else if (outcome.status === 'refused') {
            stats.refusedBatches += 1;
          } else if (outcome.status === 'failed') {
            stats.failedBatches += 1;
          } else {
            stats.invalidBatches += 1;
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
  await options.cache.save();
  return { answers, stats };
}
