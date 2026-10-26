import { describe, expect, it } from 'vitest';
import { createLogger, type LogLevel } from '../src/logger.ts';

function recordingLogger(level: LogLevel, secrets: string[] = []) {
  const lines: { level: LogLevel; line: string }[] = [];
  const logger = createLogger({ level, secrets, write: (lineLevel, line) => lines.push({ level: lineLevel, line }) });
  return { logger, lines };
}

describe('logger', () => {
  it('drops messages below the level', () => {
    const { logger, lines } = recordingLogger('warn');
    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');
    expect(lines.map((entry) => entry.line)).toEqual(['warn message', 'error message']);
  });

  it('redacts secret values from every message', () => {
    const secret = 'sk-test-secret-value';
    const { logger, lines } = recordingLogger('debug', [secret]);
    logger.error(`request failed with key ${secret} and again ${secret}`);
    expect(lines[0]?.line).toBe('request failed with key [redacted] and again [redacted]');
  });

  it('prints only a count at info level', () => {
    const { logger, lines } = recordingLogger('info');
    logger.list('files scanned', ['first sample.mkv', 'second sample.mkv']);
    expect(lines).toEqual([{ level: 'info', line: 'files scanned: 2' }]);
  });

  it('prints the items at debug level', () => {
    const { logger, lines } = recordingLogger('debug');
    logger.list('files scanned', ['first sample.mkv']);
    expect(lines.map((entry) => entry.line)).toEqual(['files scanned: 1', '  first sample.mkv']);
  });
});
