import { z } from 'zod';
import { AppError } from '../errors.ts';
import { toolDefinitions } from '../tools/registry.ts';
import { resolveBinary, runTool, type RunToolOptions } from '../tools/run.ts';
import type { ToolOverrides } from '../config.ts';
import type { ToolName } from '../tools/schemas.ts';

/** Runs an external program and returns its standard output. Tests replace it to simulate failures. */
export interface ToolRunner {
  run(binary: string, args: readonly string[], options?: RunToolOptions): Promise<string>;
}

export const realRunner: ToolRunner = {
  run: (binary, args, options) => runTool(binary, args, z.string(), options),
};

/** Finds a tool when it is first needed, so a command that never uses a tool does not require it. */
export type ToolLocator = (tool: ToolName) => Promise<string>;

export function createToolLocator(overrides: ToolOverrides): ToolLocator {
  const found = new Map<ToolName, Promise<string>>();
  return (tool) => {
    let pending = found.get(tool);
    if (pending === undefined) {
      pending = resolveBinary(tool, { overrides }).then((binary) => {
        if (binary === undefined) {
          const definition = toolDefinitions[tool];
          throw new AppError(
            'TOOL_NOT_FOUND',
            `${tool} was not found. Install ${definition.packageName} with: winget install --id ${definition.wingetId} -e`,
          );
        }
        return binary.path;
      });
      found.set(tool, pending);
    }
    return pending;
  };
}
