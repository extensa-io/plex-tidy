import { Anthropic } from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { BatchOutcome, TitleBatch, TitleModel, TokenUsage } from './model-client.ts';
import { systemPromptFor, TITLE_TOOL_DESCRIPTION, TITLE_TOOL_NAME, userMessageFor } from './prompts.ts';
import { titleToolInputSchema } from './schemas.ts';

const MAX_OUTPUT_TOKENS = 4096;

export interface AnthropicTitleModelOptions {
  apiKey: string;
  model: string;
}

const toolJsonSchema = z.toJSONSchema(titleToolInputSchema);

/** The request for one batch. Exported so tests can inspect exactly what leaves the machine. */
export function buildRequest(model: string, batch: TitleBatch) {
  return {
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    // No `temperature`: the current models reject it. The forced tool call, the parse
    // cache, and the word check keep results consistent instead.
    system: systemPromptFor(batch.kind),
    messages: [{ role: 'user' as const, content: userMessageFor(batch) }],
    tools: [
      {
        name: TITLE_TOOL_NAME,
        description: TITLE_TOOL_DESCRIPTION,
        input_schema: {
          type: 'object' as const,
          properties: toolJsonSchema.properties,
          required: toolJsonSchema.required ?? [],
        },
      },
    ],
    tool_choice: { type: 'tool' as const, name: TITLE_TOOL_NAME },
  };
}

export function createAnthropicTitleModel(options: AnthropicTitleModelOptions): TitleModel {
  const client = new Anthropic({ apiKey: options.apiKey });

  return {
    async proposeBatch(batch): Promise<BatchOutcome> {
      const noUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
      try {
        const response = await client.messages.create(buildRequest(options.model, batch));
        const usage: TokenUsage = {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        };

        if (response.stop_reason === 'refusal') {
          return { status: 'refused', usage };
        }
        if (response.stop_reason === 'max_tokens') {
          return { status: 'invalid', usage };
        }
        const block = response.content.find((part) => part.type === 'tool_use' && part.name === TITLE_TOOL_NAME);
        const parsed = titleToolInputSchema.safeParse(block?.type === 'tool_use' ? block.input : undefined);
        return parsed.success ? { status: 'ok', results: parsed.data.results, usage } : { status: 'invalid', usage };
      } catch {
        // An API error for one batch is a normal outcome, never a failure of the run.
        return { status: 'failed', usage: noUsage };
      }
    },
  };
}
