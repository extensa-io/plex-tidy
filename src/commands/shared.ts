import { stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { Command } from 'commander';
import { z } from 'zod';
import type { CliContext } from '../cli-types.ts';
import { loadConfig, type Config } from '../config.ts';
import { AppError } from '../errors.ts';
import { pathExists } from '../fs-win/exists.ts';
import { readJsonFile } from '../state/json-file.ts';
import { cachePaths, rootStatePaths, type CachePaths, type RootStatePaths } from '../state/paths.ts';
import type { Mode } from '../state/schemas.ts';
import type { Logger } from '../logger.ts';

const runOptionsSchema = z.object({
  root: z.string().trim().min(1),
  stateDir: z.string().trim().min(1).optional(),
  yes: z.boolean().default(false),
});

export function addRunOptions(command: Command, withYes: boolean): Command {
  command
    .requiredOption('--root <path>', 'library root folder; nothing outside it is changed')
    .option('--state-dir <path>', 'folder for plans, journals, and caches (default: stateDir in config.json)');
  return withYes ? command.option('--yes', 'make the changes; without it the command only reports') : command;
}

export interface RunContext {
  mode: Mode;
  config: Config;
  /** Absolute library root. */
  root: string;
  yes: boolean;
  paths: RootStatePaths;
  caches: CachePaths;
  logger: Logger;
}

/** Validates the command-line options and loads config.json. */
export async function createRunContext(
  command: Command,
  mode: Mode,
  cli: CliContext,
  readConfig: () => Promise<Config> = () => loadConfig(),
): Promise<RunContext> {
  const options = runOptionsSchema.safeParse(command.opts());
  if (!options.success) {
    throw new AppError('OPTION_INVALID', `Invalid options:\n${z.prettifyError(options.error)}`);
  }
  const config = await readConfig();
  const stateDir = options.data.stateDir ?? config.stateDir;
  const root = win32.resolve(options.data.root);
  return {
    mode,
    config,
    root,
    yes: options.data.yes,
    paths: rootStatePaths(stateDir, mode, root),
    caches: cachePaths(stateDir),
    logger: cli.logger,
  };
}

export async function requireDirectory(path: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) {
      return;
    }
  } catch {
    // Reported below.
  }
  throw new AppError('ROOT_INVALID', 'The root folder does not exist or is not a folder.');
}

/** Reads a state file that an earlier command must have written. */
export async function requireState<Schema extends z.ZodType<{ schemaVersion: number }>>(
  file: string,
  schema: Schema,
  producedBy: string,
): Promise<z.infer<Schema>> {
  const value = await readJsonFile(file, schema);
  if (value === undefined) {
    throw new AppError('STAGE_MISSING', `Run ${producedBy} first.`);
  }
  return value;
}

export { pathExists };
