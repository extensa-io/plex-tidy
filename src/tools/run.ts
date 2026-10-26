import { access, constants } from 'node:fs/promises';
import { basename, win32 } from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import type { ToolOverrides } from '../config.ts';
import { AppError, isAppError } from '../errors.ts';
import { toolDefinitions } from './registry.ts';
import type { ToolName } from './schemas.ts';

export type FileExists = (path: string) => Promise<boolean>;

export type BinarySource = 'config' | 'path' | 'default-location';

export interface ResolvedBinary {
  path: string;
  source: BinarySource;
}

export interface ResolveOptions {
  overrides?: ToolOverrides;
  pathValue?: string | undefined;
  fileExists?: FileExists;
}

const executableExtensions = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Finds a tool binary: the `config.json` override if set, otherwise `PATH`,
 * otherwise the tool's default install folder. A set override that does not
 * exist is not silently replaced by another binary.
 */
export async function resolveBinary(tool: ToolName, options: ResolveOptions = {}): Promise<ResolvedBinary | undefined> {
  const fileExists = options.fileExists ?? defaultFileExists;
  const override = options.overrides?.[tool];
  if (override !== undefined) {
    return (await fileExists(override)) ? { path: override, source: 'config' } : undefined;
  }

  const onPath = await findOnPath(tool, options.pathValue ?? process.env.PATH ?? '', fileExists);
  if (onPath !== undefined) {
    return { path: onPath, source: 'path' };
  }

  for (const location of toolDefinitions[tool].defaultLocations) {
    if (await fileExists(location)) {
      return { path: location, source: 'default-location' };
    }
  }
  return undefined;
}

export async function findOnPath(
  command: string,
  pathValue: string,
  fileExists: FileExists = defaultFileExists,
): Promise<string | undefined> {
  const directories = pathValue
    .split(';')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry !== '');
  for (const directory of directories) {
    for (const extension of executableExtensions) {
      const candidate = win32.join(directory, `${command}${extension}`);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export interface RunToolOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Runs a binary, given as a path from `resolveBinary`, and returns its
 * standard output parsed by `schema`.
 */
export async function runTool<Schema extends z.ZodType<unknown, string>>(
  binary: string,
  args: readonly string[],
  schema: Schema,
  options: RunToolOptions = {},
): Promise<z.output<Schema>> {
  const name = basename(binary);
  // On Windows a missing binary surfaces as exit code 1, not ENOENT, so check first.
  if (!(await defaultFileExists(binary))) {
    throw new AppError('TOOL_NOT_FOUND', `${name} was not found.`);
  }
  const result = await execa(binary, args, {
    reject: false,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    stdin: 'ignore',
  });

  if (result.failed) {
    if (result.code === 'ENOENT') {
      throw new AppError('TOOL_NOT_FOUND', `${name} was not found.`);
    }
    const reason = result.timedOut ? 'timed out' : `exited with code ${String(result.exitCode ?? 'unknown')}`;
    throw new AppError('TOOL_FAILED', `${name} ${reason}.`, { cause: result });
  }

  const parsed = schema.safeParse(result.stdout);
  if (!parsed.success) {
    throw new AppError('TOOL_OUTPUT_INVALID', `${name} returned output that could not be read.`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export type ToolStatus =
  | { tool: ToolName; found: true; path: string; source: BinarySource; version: string }
  | { tool: ToolName; found: false; reason: string };

export async function probeTool(tool: ToolName, options: ResolveOptions = {}): Promise<ToolStatus> {
  const binary = await resolveBinary(tool, options);
  if (binary === undefined) {
    const reason =
      options.overrides?.[tool] === undefined ? 'not found' : 'not found at the path set in config.json';
    return { tool, found: false, reason };
  }
  const definition = toolDefinitions[tool];
  try {
    const version = await runTool(binary.path, definition.versionArgs, definition.versionSchema);
    return { tool, found: true, path: binary.path, source: binary.source, version };
  } catch (error) {
    if (isAppError(error)) {
      return { tool, found: false, reason: error.message };
    }
    throw error;
  }
}

async function defaultFileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
