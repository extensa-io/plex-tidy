import { describe, expect, it } from 'vitest';
import { envPresence, requireEnv, secretValues } from '../src/env.ts';
import { AppError } from '../src/errors.ts';

const anthropicKey = 'sk-test-0000000000000000';
const tmdbToken = 'aaaaaaaaaa.bbbbbbbbbb.cccccccccc';

function captureError(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('requireEnv', () => {
  it('returns a valid key', () => {
    expect(requireEnv('ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: anthropicKey })).toBe(anthropicKey);
    expect(requireEnv('TMDB_READ_ACCESS_TOKEN', { TMDB_READ_ACCESS_TOKEN: tmdbToken })).toBe(tmdbToken);
  });

  it('trims surrounding whitespace', () => {
    expect(requireEnv('ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: `  ${anthropicKey}\n` })).toBe(anthropicKey);
  });

  it.each([undefined, '', '   '])('reports %j as missing', (value) => {
    const error = captureError(() => requireEnv('ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: value }));
    expect(error.code).toBe('ENV_MISSING');
    expect(error.message).toContain('ANTHROPIC_API_KEY');
  });

  it('rejects a key with inner whitespace without echoing its value', () => {
    const value = 'sk-test-0000 1111';
    const error = captureError(() => requireEnv('ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: value }));
    expect(error.code).toBe('ENV_INVALID');
    expect(error.message).not.toContain(value);
    expect(error.message).not.toContain('1111');
  });

  it('rejects a TMDB API key pasted in place of the Read Access Token', () => {
    const value = '0123456789abcdef0123456789abcdef';
    const error = captureError(() => requireEnv('TMDB_READ_ACCESS_TOKEN', { TMDB_READ_ACCESS_TOKEN: value }));
    expect(error.code).toBe('ENV_INVALID');
    expect(error.message).toMatch(/Read Access Token/);
    expect(error.message).not.toContain(value);
  });
});

describe('envPresence and secretValues', () => {
  it('reports which keys are set', () => {
    expect(envPresence({ ANTHROPIC_API_KEY: anthropicKey, TMDB_READ_ACCESS_TOKEN: ' ' })).toEqual({
      ANTHROPIC_API_KEY: true,
      TMDB_READ_ACCESS_TOKEN: false,
    });
  });

  it('lists set key values for redaction', () => {
    expect(secretValues({ ANTHROPIC_API_KEY: anthropicKey, TMDB_READ_ACCESS_TOKEN: tmdbToken })).toEqual([
      anthropicKey,
      tmdbToken,
    ]);
    expect(secretValues({})).toEqual([]);
  });
});
