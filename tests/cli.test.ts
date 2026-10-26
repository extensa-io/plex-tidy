import { describe, expect, it } from 'vitest';
import { buildProgram, commandRegistry, type CommandRegistry } from '../src/cli.ts';
import { createLogger } from '../src/logger.ts';

const context = { logger: createLogger({ secrets: [], write: () => undefined }) };

describe('buildProgram', () => {
  it('registers doctor and the local mode', () => {
    const program = buildProgram(context);
    expect(program.commands.map((command) => command.name())).toEqual(['doctor', 'local']);
  });

  it('registers every local command with its options', () => {
    const local = buildProgram(context).commands.find((command) => command.name() === 'local');
    expect(local?.commands.map((command) => command.name())).toEqual([
      'scan',
      'parse',
      'resolve',
      'plan',
      'review',
      'apply',
      'undo',
      'status',
    ]);
    const optionNames = (name: string) =>
      local?.commands.find((command) => command.name() === name)?.options.map((option) => option.long);
    expect(optionNames('scan')).toEqual(['--root', '--state-dir']);
    expect(optionNames('apply')).toEqual(['--root', '--state-dir', '--yes']);
    expect(optionNames('undo')).toEqual(['--root', '--state-dir', '--yes']);
  });

  it('adds a mode group only for modes that have commands', () => {
    const registry: CommandRegistry = {
      topLevel: commandRegistry.topLevel,
      mode: [{ name: 'scan', description: 'scan a root', modes: ['local'], register: () => undefined }],
    };
    const program = buildProgram(context, registry);
    expect(program.commands.map((command) => command.name())).toEqual(['doctor', 'local']);
    const local = program.commands.find((command) => command.name() === 'local');
    expect(local?.commands.map((command) => command.name())).toEqual(['scan']);
  });
});
