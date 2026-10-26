import { describe, expect, it } from 'vitest';
import { buildProgram, commandRegistry, type CommandRegistry } from '../src/cli.ts';
import { createLogger } from '../src/logger.ts';

const context = { logger: createLogger({ secrets: [], write: () => undefined }) };

describe('buildProgram', () => {
  it('registers doctor and the videos mode', () => {
    const program = buildProgram(context);
    expect(program.commands.map((command) => command.name())).toEqual(['doctor', 'videos']);
  });

  it('registers every videos command with its options', () => {
    const videos = buildProgram(context).commands.find((command) => command.name() === 'videos');
    expect(videos?.commands.map((command) => command.name())).toEqual([
      'run',
      'scan',
      'parse',
      'resolve',
      'plan',
      'review',
      'apply',
      'tag',
      'undo',
      'status',
    ]);
    const optionNames = (name: string) =>
      videos?.commands.find((command) => command.name() === name)?.options.map((option) => option.long);
    expect(optionNames('scan')).toEqual(['--root', '--state-dir']);
    expect(optionNames('run')).toEqual(['--root', '--state-dir']);
    expect(optionNames('apply')).toEqual(['--root', '--state-dir', '--yes']);
    expect(optionNames('tag')).toEqual(['--root', '--state-dir', '--yes']);
    expect(optionNames('undo')).toEqual(['--root', '--state-dir', '--yes', '--only']);
  });

  it('adds a mode group only for modes that have commands', () => {
    const registry: CommandRegistry = {
      topLevel: commandRegistry.topLevel,
      mode: [{ name: 'scan', description: 'scan a root', modes: ['videos'], register: () => undefined }],
    };
    const program = buildProgram(context, registry);
    expect(program.commands.map((command) => command.name())).toEqual(['doctor', 'videos']);
    const videos = program.commands.find((command) => command.name() === 'videos');
    expect(videos?.commands.map((command) => command.name())).toEqual(['scan']);
  });
});
