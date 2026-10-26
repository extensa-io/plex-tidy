import { access } from 'node:fs/promises';
import { afterEach } from 'vitest';
import { buildProgram } from '../../src/cli.ts';
import { createVideosCommands, type VideosDeps } from '../../src/commands/videos.ts';
import { parseConfig } from '../../src/config.ts';
import { createLogger } from '../../src/logger.ts';
import type { ProgressFactory } from '../../src/progress.ts';
import type { ReviewIO } from '../../src/review/review.ts';
import { createBackends, type Backends } from '../../src/tag/backends.ts';
import { createToolLocator, realRunner } from '../../src/tag/runner.ts';
import { rootStatePaths } from '../../src/state/paths.ts';
import { libraryTree } from '../fixtures/videos-corpus.ts';
import { createStubModel, type StubModel, type StubModelOptions } from './stub-model.ts';
import { useTempDirs } from './temp-dir.ts';
import { createTree } from './tree.ts';

const makeTempDir = useTempDirs();

afterEach(() => {
  process.exitCode = undefined;
});

/** Approves every proposal and skips files that have none. */
export const approvingIO: ReviewIO = {
  print: () => undefined,
  confirm: () => Promise.resolve(true),
  choose: (_message, choices) => Promise.resolve(choices.some((choice) => choice.value === 'accept') ? 'accept' : 'skip'),
  ask: () => Promise.resolve(''),
};

export interface HarnessOptions {
  model?: StubModelOptions;
  level?: 'info' | 'debug';
  io?: ReviewIO;
  tree?: readonly string[];
  backends?: Backends;
  progress?: ProgressFactory;
}

export async function harness(options: HarnessOptions = {}) {
  const root = await makeTempDir();
  const stateDir = await makeTempDir();
  await createTree(root, options.tree ?? libraryTree);
  const lines: string[] = [];
  const logger = createLogger({ level: options.level ?? 'info', secrets: [], write: (_level, line) => void lines.push(line) });
  const models: StubModel[] = [];
  let io = options.io ?? approvingIO;
  const deps: VideosDeps = {
    loadConfig: () => Promise.resolve(parseConfig({ models: { parse: 'parse-model', judge: 'judge-model' } })),
    createTitleModel: () => {
      const model = createStubModel(options.model);
      models.push(model);
      return model;
    },
    createReviewIO: () => io,
    createBackends: () =>
      options.backends ?? createBackends({ runner: realRunner, locate: createToolLocator({}) }),
  };
  const run = async (command: string, ...flags: string[]) => {
    const program = buildProgram(
      options.progress === undefined ? { logger } : { logger, progress: options.progress },
      { topLevel: [], mode: createVideosCommands(deps) },
    );
    await program.parseAsync(['node', 'plex-tidy', 'videos', command, '--root', root, '--state-dir', stateDir, ...flags]);
  };
  const paths = rootStatePaths(stateDir, 'videos', root);
  /** Replaces the prompts for the next command, on the same folder and state. */
  const useIO = (next: ReviewIO) => {
    io = next;
  };
  return { root, stateDir, lines, models, run, paths, useIO };
}

export type Harness = Awaited<ReturnType<typeof harness>>;

export async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function buildUpToPlan(h: Harness): Promise<void> {
  await h.run('scan');
  await h.run('parse');
  await h.run('resolve');
  await h.run('plan');
}
