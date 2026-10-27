import { Anthropic } from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AnthropicMovieOptions } from './anthropic-movies.ts';
import type { TokenUsage } from './model-client.ts';
import {
  SHOW_JUDGE_SYSTEM_PROMPT,
  SHOW_JUDGE_TOOL_DESCRIPTION,
  SHOW_JUDGE_TOOL_NAME,
  showJudgeToolInputSchema,
  showJudgeUserMessage,
  type ShowJudge,
  type ShowJudgeOutcome,
  type ShowJudgeRequest,
} from './tv-judge.ts';
import {
  TV_SYSTEM_PROMPT,
  TV_TOOL_DESCRIPTION,
  TV_TOOL_NAME,
  tvToolInputSchema,
  tvUserMessage,
  type TvBatchOutcome,
  type TvNameItem,
  type TvParseModel,
} from './tv-parser.ts';

const MAX_OUTPUT_TOKENS = 4096;
const JUDGE_MAX_OUTPUT_TOKENS = 256;

function inputSchemaOf(schema: z.ZodType) {
  const json = z.toJSONSchema(schema) as { properties?: Record<string, unknown>; required?: string[] };
  return { type: 'object' as const, properties: json.properties ?? {}, required: json.required ?? [] };
}

const tvInputSchema = inputSchemaOf(tvToolInputSchema);
const showJudgeInputSchema = inputSchemaOf(showJudgeToolInputSchema);

/** The request for one parse batch. Exported so tests can inspect exactly what leaves the machine. */
export function buildTvParseRequest(model: string, items: readonly TvNameItem[]) {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: TV_SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content: tvUserMessage(items) }],
    tools: [{ name: TV_TOOL_NAME, description: TV_TOOL_DESCRIPTION, input_schema: tvInputSchema }],
    tool_choice: { type: 'tool' as const, name: TV_TOOL_NAME },
  };
}

/** The request for one show decision. Exported so tests can inspect exactly what leaves the machine. */
export function buildShowJudgeRequest(model: string, request: ShowJudgeRequest) {
  return {
    model,
    max_tokens: JUDGE_MAX_OUTPUT_TOKENS,
    system: SHOW_JUDGE_SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content: showJudgeUserMessage(request) }],
    tools: [{ name: SHOW_JUDGE_TOOL_NAME, description: SHOW_JUDGE_TOOL_DESCRIPTION, input_schema: showJudgeInputSchema }],
    // The Sonnet-tier models reject a forced tool choice. An answer without a tool call is invalid.
    tool_choice: { type: 'auto' as const },
  };
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

export function createAnthropicTvParseModel(options: AnthropicMovieOptions): TvParseModel {
  const client = new Anthropic({ apiKey: options.apiKey });
  return {
    async parseBatch(items): Promise<TvBatchOutcome> {
      try {
        const response = await client.messages.create(buildTvParseRequest(options.model, items));
        const usage: TokenUsage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
        if (response.stop_reason === 'refusal') {
          return { status: 'refused', usage };
        }
        if (response.stop_reason === 'max_tokens') {
          return { status: 'invalid', usage };
        }
        const block = response.content.find((part) => part.type === 'tool_use' && part.name === TV_TOOL_NAME);
        const parsed = tvToolInputSchema.safeParse(block?.type === 'tool_use' ? block.input : undefined);
        return parsed.success ? { status: 'ok', results: parsed.data.results, usage } : { status: 'invalid', usage };
      } catch (error) {
        return { status: 'failed', usage: { inputTokens: 0, outputTokens: 0 }, detail: describeFailure(error) };
      }
    },
  };
}

export function createAnthropicShowJudge(options: AnthropicMovieOptions): ShowJudge {
  const client = new Anthropic({ apiKey: options.apiKey });
  return {
    async choose(request): Promise<ShowJudgeOutcome> {
      try {
        const response = await client.messages.create(buildShowJudgeRequest(options.model, request));
        const usage: TokenUsage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
        if (response.stop_reason === 'refusal') {
          return { status: 'refused', usage };
        }
        const block = response.content.find((part) => part.type === 'tool_use' && part.name === SHOW_JUDGE_TOOL_NAME);
        const parsed = showJudgeToolInputSchema.safeParse(block?.type === 'tool_use' ? block.input : undefined);
        return parsed.success ? { status: 'ok', id: parsed.data.id, usage } : { status: 'invalid', usage };
      } catch (error) {
        return { status: 'failed', usage: { inputTokens: 0, outputTokens: 0 }, detail: describeFailure(error) };
      }
    },
  };
}
