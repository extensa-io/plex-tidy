import { secretValues } from './env.ts';

export const logLevels = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof logLevels)[number];

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Prints a count at info level; prints the items themselves only at debug level. */
  list(label: string, items: readonly string[]): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  secrets?: readonly string[];
  write?: (level: LogLevel, line: string) => void;
}

const REDACTED = '[redacted]';

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = logLevels.indexOf(options.level ?? 'info');
  const secrets = options.secrets ?? secretValues();
  const write = options.write ?? writeToConsole;

  const emit = (level: LogLevel, message: string): void => {
    if (logLevels.indexOf(level) < threshold) {
      return;
    }
    write(level, redact(message, secrets));
  };

  return {
    debug: (message) => {
      emit('debug', message);
    },
    info: (message) => {
      emit('info', message);
    },
    warn: (message) => {
      emit('warn', message);
    },
    error: (message) => {
      emit('error', message);
    },
    list: (label, items) => {
      emit('info', `${label}: ${items.length}`);
      for (const item of items) {
        emit('debug', `  ${item}`);
      }
    },
  };
}

export function redact(message: string, secrets: readonly string[]): string {
  let result = message;
  for (const secret of secrets) {
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

function writeToConsole(level: LogLevel, line: string): void {
  if (level === 'warn' || level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}
