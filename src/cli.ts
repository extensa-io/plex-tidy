import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import type { CliContext, CommandRegistry, TopLevelCommand } from './cli-types.ts';
import { videosCommands } from './commands/videos.ts';
import { isAppError } from './errors.ts';
import { createLogger } from './logger.ts';
import { createProgress } from './progress.ts';
import { modeSchema } from './state/schemas.ts';
import { doctorHasProblems, formatDoctorReport, runDoctor } from './tools/doctor.ts';

export type { CliContext, CommandRegistry, ModeCommand, TopLevelCommand } from './cli-types.ts';

const doctorCommand: TopLevelCommand = {
  name: 'doctor',
  description: 'check the Node version, external tools, config.json, and keys',
  register: (command, context) => {
    command.action(async () => {
      const report = await runDoctor();
      for (const line of formatDoctorReport(report)) {
        context.logger.info(line);
      }
      if (doctorHasProblems(report)) {
        process.exitCode = 1;
      }
    });
  },
};

// Later phases add their commands here.
export const commandRegistry: CommandRegistry = {
  topLevel: [doctorCommand],
  mode: [...videosCommands],
};

export function buildProgram(context: CliContext, registry: CommandRegistry = commandRegistry): Command {
  const program = new Command('plex-tidy')
    .description('Rename video files and their subtitles so Plex shows them correctly.')
    .option('--verbose', 'print debug output');

  for (const entry of registry.topLevel) {
    entry.register(program.command(entry.name).description(entry.description), context);
  }

  for (const mode of modeSchema.options) {
    const commands = registry.mode.filter((entry) => entry.modes.includes(mode));
    if (commands.length === 0) {
      continue;
    }
    const modeCommand = program.command(mode).description(`${mode} mode`);
    for (const entry of commands) {
      entry.register(modeCommand.command(entry.name).description(entry.description), mode, context);
    }
  }
  return program;
}

export async function main(argv: readonly string[]): Promise<number> {
  const logger = createLogger({ level: argv.includes('--verbose') ? 'debug' : 'info' });
  try {
    await buildProgram({ logger, progress: createProgress() }).parseAsync([...argv]);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      // The owner pressed Ctrl+C at a prompt. Every decision is saved as it is made.
      logger.info('Stopped. Decisions already made are saved.');
      return 130;
    }
    if (isAppError(error)) {
      logger.error(`error: ${error.message} (${error.code})`);
    } else {
      logger.error('error: an unexpected problem stopped the command. Run again with --verbose for details.');
      if (error instanceof Error && error.stack !== undefined) {
        logger.debug(error.stack);
      }
    }
    return 1;
  }
}

const entryScript = process.argv[1];
if (entryScript !== undefined && import.meta.url === pathToFileURL(entryScript).href) {
  process.exitCode = await main(process.argv);
}
