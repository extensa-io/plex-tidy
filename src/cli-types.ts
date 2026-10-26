import type { Command } from 'commander';
import type { Logger } from './logger.ts';
import type { Mode } from './state/schemas.ts';

export interface CliContext {
  logger: Logger;
}

/** A command that stands alone, such as `doctor`. */
export interface TopLevelCommand {
  name: string;
  description: string;
  register: (command: Command, context: CliContext) => void;
}

/** A command that runs under a mode, such as `videos scan`. */
export interface ModeCommand {
  name: string;
  description: string;
  modes: readonly Mode[];
  register: (command: Command, mode: Mode, context: CliContext) => void;
}

export interface CommandRegistry {
  topLevel: readonly TopLevelCommand[];
  mode: readonly ModeCommand[];
}
