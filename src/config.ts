import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AppError, nodeErrorCode } from './errors.ts';

export const CONFIG_FILE = 'config.json';

const toolPathSchema = z.string().trim().min(1).optional();

export const configSchema = z
  .object({
    stateDir: z.string().trim().min(1).default('./state'),
    models: z
      .object({
        parse: z.string().trim().min(1),
        judge: z.string().trim().min(1),
      })
      .strict(),
    autoApplyThreshold: z.number().min(0).max(1).default(0.9),
    tmdbConcurrency: z.number().int().min(1).max(20).default(4),
    parseBatchSize: z.number().int().min(50).max(100).default(50),
    tools: z
      .object({
        ffprobe: toolPathSchema,
        mkvpropedit: toolPathSchema,
        mkvextract: toolPathSchema,
        exiftool: toolPathSchema,
      })
      .strict()
      .default({}),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;
export type ToolOverrides = Config['tools'];

export function parseConfig(raw: unknown): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new AppError('CONFIG_INVALID', `${CONFIG_FILE} is invalid:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function loadConfig(file: string = CONFIG_FILE): Promise<Config> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      throw new AppError(
        'CONFIG_MISSING',
        `${CONFIG_FILE} was not found. Copy config.example.json to ${CONFIG_FILE} and edit it.`,
        { cause: error },
      );
    }
    throw new AppError('CONFIG_INVALID', `${CONFIG_FILE} could not be read.`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AppError('CONFIG_INVALID', `${CONFIG_FILE} is not valid JSON.`, { cause: error });
  }
  return parseConfig(raw);
}
