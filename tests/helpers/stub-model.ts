import { cleanText } from '../../src/parse/cleaner.ts';
import type { BatchOutcome, TitleBatch, TitleModel } from '../../src/llm/model-client.ts';

export interface StubModelOptions {
  /** Return this status for every batch instead of answering. */
  status?: 'refused' | 'failed' | 'invalid';
  /** Replace the answer for a source text. Return `undefined` to use the default. */
  answer?: (batch: TitleBatch['kind'], sources: readonly string[]) => string | null | undefined;
}

export interface StubModel extends TitleModel {
  /** Every batch received, exactly as it would be sent. */
  batches: TitleBatch[];
}

/** A model that answers with the rules-only cleaner, so tests need no network. */
export function createStubModel(options: StubModelOptions = {}): StubModel {
  const batches: TitleBatch[] = [];
  return {
    batches,
    proposeBatch(batch): Promise<BatchOutcome> {
      batches.push(batch);
      const usage = { inputTokens: 10, outputTokens: 5 };
      if (options.status !== undefined) {
        return Promise.resolve({ status: options.status, usage });
      }
      const results = batch.items.map((item) => {
        const custom = options.answer?.(batch.kind, item.sources);
        const title = custom !== undefined ? custom : cleanText(item.sources[0] ?? '');
        return { id: item.id, title: title === '' ? null : title };
      });
      return Promise.resolve({ status: 'ok', results, usage });
    },
  };
}
