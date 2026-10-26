import type { TitleKind } from './schemas.ts';

export interface TitleRequestItem {
  /** Position inside the batch. The model echoes it back. */
  id: number;
  /** One entry for a file name; folder names, nearest first, for a file with no title. */
  sources: readonly string[];
}

export interface TitleBatch {
  kind: TitleKind;
  items: readonly TitleRequestItem[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type BatchOutcome =
  | { status: 'ok'; results: readonly { id: number; title: string | null }[]; usage: TokenUsage }
  | { status: 'refused' | 'failed' | 'invalid'; usage: TokenUsage };

/**
 * One request to a hosted model. Implementations never throw for a refusal,
 * an API error, or an invalid response; they return a non-`ok` status.
 */
export interface TitleModel {
  proposeBatch(batch: TitleBatch): Promise<BatchOutcome>;
}
