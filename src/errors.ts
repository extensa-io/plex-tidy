export const errorCodes = [
  'CONFIG_MISSING',
  'CONFIG_INVALID',
  'ENV_MISSING',
  'ENV_INVALID',
  'STATE_INVALID',
  'STATE_WRITE_FAILED',
  'PATH_OUTSIDE_ROOT',
  'PATH_TOO_LONG',
  'CROSS_VOLUME',
  'DESTINATION_EXISTS',
  'DESTINATION_PARENT_MISSING',
  'SOURCE_MISSING',
  'NAME_INVALID',
  'RENAME_FAILED',
  'TOOL_NOT_FOUND',
  'TOOL_FAILED',
  'TOOL_OUTPUT_INVALID',
  'ROOT_INVALID',
  'OPTION_INVALID',
  'STAGE_MISSING',
  'STAGE_STALE',
  'PREFLIGHT_FAILED',
  'ENTRY_NOT_FOUND',
  'TAG_VERIFY_FAILED',
  'TAG_NO_SPACE',
  'TAG_UNSUPPORTED',
  'TMDB_FAILED',
  'MKDIR_FAILED',
] as const;

export type ErrorCode = (typeof errorCodes)[number];

/**
 * An error whose message is safe to show the owner. Internal detail goes in
 * `cause`, which the CLI never prints.
 */
export class AppError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** The `code` of a Node.js system error, such as `ENOENT`. */
export function nodeErrorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}
