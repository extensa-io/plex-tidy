import { describe, expect, it } from 'vitest';
import { buildProgram, commandRegistry, type CommandRegistry } from '../src/cli.ts';
import { createLogger } from '../src/logger.ts';

const context = { logger: createLogger({ secrets: [], write: () => undefined }) };

describe('buildProgram', () => {
  it('registers doctor and no mode commands in this phase', () => {
    const program = buildProgram(context);
    expect(program.commands.map((command) => command.name())).toEqual(['doctor']);
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
