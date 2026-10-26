import { Anthropic } from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  JUDGE_SYSTEM_PROMPT,
  JUDGE_TOOL_DESCRIPTION,
  JUDGE_TOOL_NAME,
  judgeToolInputSchema,
  judgeUserMessage,
  type JudgeOutcome,
  type JudgeRequest,
  type MovieJudge,
} from './movie-judge.ts';
import {
  MOVIE_SYSTEM_PROMPT,
  MOVIE_TOOL_DESCRIPTION,
  MOVIE_TOOL_NAME,
  movieToolInputSchema,
  movieUserMessage,
  type MovieBatchOutcome,
  type MovieNameItem,
  type MovieParseModel,
} from './movie-parser.ts';
import type { TokenUsage } from './model-client.ts';

const MAX_OUTPUT_TOKENS = 4096;
const JUDGE_MAX_OUTPUT_TOKENS = 256;

export interface AnthropicMovieOptions {
  apiKey: string;
  model: string;
}

function inputSchemaOf(schema: z.ZodType) {
  const json = z.toJSONSchema(schema) as { properties?: Record<string, unknown>; required?: string[] };
  return { type: 'object' as const, properties: json.properties ?? {}, required: json.required ?? [] };
}

const movieInputSchema = inputSchemaOf(movieToolInputSchema);
const judgeInputSchema = inputSchemaOf(judgeToolInputSchema);

/** The request for one parse batch. Exported so tests can inspect exactly what leaves the machine. */
export function buildMovieParseRequest(model: string, items: readonly MovieNameItem[]) {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: MOVIE_SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content: movieUserMessage(items) }],
    tools: [{ name: MOVIE_TOOL_NAME, description: MOVIE_TOOL_DESCRIPTION, input_schema: movieInputSchema }],
    tool_choice: { type: 'tool' as const, name: MOVIE_TOOL_NAME },
  };
}

/** The request for one judge call. Exported so tests can inspect exactly what leaves the machine. */
export function buildJudgeRequest(model: string, request: JudgeRequest) {
  return {
    model,
    max_tokens: JUDGE_MAX_OUTPUT_TOKENS,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: 'user' as const, content: judgeUserMessage(request) }],
    tools: [{ name: JUDGE_TOOL_NAME, description: JUDGE_TOOL_DESCRIPTION, input_schema: judgeInputSchema }],
    // The Sonnet-tier models reject a forced tool choice. The prompt tells the model to call the
    // tool, and an answer without a tool call is treated as invalid.
    tool_choice: { type: 'auto' as const },
  };
}

/** A short, secret-free description of an API failure, for the console. */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

export function createAnthropicMovieParseModel(options: AnthropicMovieOptions): MovieParseModel {
  const client = new Anthropic({ apiKey: options.apiKey });
  return {
    async parseBatch(items): Promise<MovieBatchOutcome> {
      try {
        const response = await client.messages.create(buildMovieParseRequest(options.model, items));
        const usage: TokenUsage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
        if (response.stop_reason === 'refusal') {
          return { status: 'refused', usage };
        }
        if (response.stop_reason === 'max_tokens') {
          return { status: 'invalid', usage };
        }
        const block = response.content.find((part) => part.type === 'tool_use' && part.name === MOVIE_TOOL_NAME);
        const parsed = movieToolInputSchema.safeParse(block?.type === 'tool_use' ? block.input : undefined);
        return parsed.success ? { status: 'ok', results: parsed.data.results, usage } : { status: 'invalid', usage };
      } catch (error) {
        // An API error for one batch is a normal outcome, never a failure of the run.
        return { status: 'failed', usage: { inputTokens: 0, outputTokens: 0 }, detail: describeFailure(error) };
      }
    },
  };
}

export function createAnthropicMovieJudge(options: AnthropicMovieOptions): MovieJudge {
  const client = new Anthropic({ apiKey: options.apiKey });
  return {
    async choose(request): Promise<JudgeOutcome> {
      try {
        const response = await client.messages.create(buildJudgeRequest(options.model, request));
        const usage: TokenUsage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
        if (response.stop_reason === 'refusal') {
          return { status: 'refused', usage };
        }
        const block = response.content.find((part) => part.type === 'tool_use' && part.name === JUDGE_TOOL_NAME);
        const parsed = judgeToolInputSchema.safeParse(block?.type === 'tool_use' ? block.input : undefined);
        return parsed.success ? { status: 'ok', id: parsed.data.id, usage } : { status: 'invalid', usage };
      } catch (error) {
        return { status: 'failed', usage: { inputTokens: 0, outputTokens: 0 }, detail: describeFailure(error) };
      }
    },
  };
}
