import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { AppError, nodeErrorCode } from '../errors.ts';

type VersionedSchema = z.ZodType<{ schemaVersion: number }>;

export interface JsonFileOps {
  rename: (from: string, to: string) => Promise<void>;
}

const defaultOps: JsonFileOps = { rename };

// Antivirus and search indexers briefly lock new files on Windows, which makes
// a rename fail with one of these codes. A short retry clears it.
const transientRenameCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_MS = 50;

/** Reads and validates a state file. Returns `undefined` when the file does not exist. */
export async function readJsonFile<Schema extends VersionedSchema>(
  file: string,
  schema: Schema,
): Promise<z.infer<Schema> | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      return undefined;
    }
    throw new AppError('STATE_INVALID', `State file ${basename(file)} could not be read.`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AppError('STATE_INVALID', `State file ${basename(file)} is not valid JSON.`, { cause: error });
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new AppError(
      'STATE_INVALID',
      `State file ${basename(file)} does not match its schema:\n${z.prettifyError(result.error)}`,
      { cause: result.error },
    );
  }
  return result.data;
}

/**
 * Validates `value`, writes it to a temporary file in the same directory, and
 * renames that over `file`. A failure at any step leaves the previous file intact.
 */
export async function writeJsonFile<Schema extends VersionedSchema>(
  file: string,
  schema: Schema,
  value: z.input<Schema>,
  ops: JsonFileOps = defaultOps,
): Promise<void> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      'STATE_INVALID',
      `Refusing to write ${basename(file)}: the data does not match its schema:\n${z.prettifyError(result.error)}`,
      { cause: result.error },
    );
  }

  const dir = dirname(file);
  const temp = join(dir, `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(result.data, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, file, ops);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw new AppError('STATE_WRITE_FAILED', `State file ${basename(file)} could not be written.`, { cause: error });
  }
}

async function renameWithRetry(from: string, to: string, ops: JsonFileOps): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await ops.rename(from, to);
      return;
    } catch (error) {
      const code = nodeErrorCode(error);
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !transientRenameCodes.has(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS * attempt));
    }
  }
}
