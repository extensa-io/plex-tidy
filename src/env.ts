import { z } from 'zod';
import { AppError } from './errors.ts';

const noWhitespace = (name: string) =>
  z.string().refine((value) => !/\s/.test(value), `${name} must not contain spaces or line breaks.`);

// A TMDB Read Access Token has three dot-separated segments. The shorter
// TMDB "API Key" does not, and is the usual wrong value to paste here.
const tmdbTokenShape = /^[\w-]+\.[\w-]+\.[\w-]+$/;

export const envSchema = z.object({
  ANTHROPIC_API_KEY: noWhitespace('ANTHROPIC_API_KEY'),
  TMDB_READ_ACCESS_TOKEN: noWhitespace('TMDB_READ_ACCESS_TOKEN').refine(
    (value) => tmdbTokenShape.test(value),
    'TMDB_READ_ACCESS_TOKEN does not look like a Read Access Token. Use the long API Read Access Token, not the short API Key.',
  ),
});

export type Env = z.infer<typeof envSchema>;
export type EnvKey = keyof Env;
export const envKeys = Object.keys(envSchema.shape) as EnvKey[];

type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Validates one key on demand, so commands that need no key run without one.
 * Messages name the key and never include its value.
 */
export function requireEnv(key: EnvKey, source: EnvSource = process.env): string {
  const value = source[key]?.trim();
  if (value === undefined || value === '') {
    throw new AppError('ENV_MISSING', `${key} is not set. Add it to .env (see .env.example).`);
  }
  const result = envSchema.shape[key].safeParse(value);
  if (!result.success) {
    const message = result.error.issues[0]?.message ?? `${key} is invalid.`;
    throw new AppError('ENV_INVALID', message);
  }
  return result.data;
}

/** Reports which keys are set, without reading or returning their values. */
export function envPresence(source: EnvSource = process.env): Record<EnvKey, boolean> {
  return {
    ANTHROPIC_API_KEY: isSet(source.ANTHROPIC_API_KEY),
    TMDB_READ_ACCESS_TOKEN: isSet(source.TMDB_READ_ACCESS_TOKEN),
  };
}

/** Values to scrub from any log output. */
export function secretValues(source: EnvSource = process.env): string[] {
  return envKeys.map((key) => source[key]?.trim() ?? '').filter((value) => value.length >= 8);
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '';
}
