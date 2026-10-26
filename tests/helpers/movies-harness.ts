import { afterEach } from 'vitest';
import { buildProgram } from '../../src/cli.ts';
import { createMoviesCommands, type MoviesDeps } from '../../src/commands/movies.ts';
import { createVideosCommands } from '../../src/commands/videos.ts';
import { parseConfig } from '../../src/config.ts';
import type { JudgeRequest, MovieJudge } from '../../src/llm/movie-judge.ts';
import type { MovieNameItem, MovieParseModel } from '../../src/llm/movie-parser.ts';
import { createLogger } from '../../src/logger.ts';
import type { ReviewIO } from '../../src/review/review.ts';
import { rootStatePaths } from '../../src/state/paths.ts';
import { createBackends } from '../../src/tag/backends.ts';
import { createToolLocator, realRunner } from '../../src/tag/runner.ts';
import { catalog, durations, modelAnswers, moviesTree, spanishTitles } from '../fixtures/movies-corpus.ts';
import { approvingIO } from './cli-harness.ts';
import { createFakeTmdb, type FakeTmdb } from './fake-tmdb.ts';
import { useTempDirs } from './temp-dir.ts';
import { createTree } from './tree.ts';

const makeTempDir = useTempDirs();

afterEach(() => {
  process.exitCode = undefined;
});

export interface StubMovieModel extends MovieParseModel {
  /** Every batch received, exactly as it would be sent. */
  batches: (readonly MovieNameItem[])[];
}

export function createStubMovieModel(status?: 'refused' | 'failed' | 'invalid'): StubMovieModel {
  const batches: (readonly MovieNameItem[])[] = [];
  const usage = { inputTokens: 10, outputTokens: 5 };
  return {
    batches,
    parseBatch: (items) => {
      batches.push(items);
      if (status !== undefined) {
        return Promise.resolve({ status, usage });
      }
      return Promise.resolve({
        status: 'ok',
        usage,
        results: items.map((item) => ({
          id: item.id,
          ...(modelAnswers[item.name] ?? { title: null, year: null, edition: null, language: null, part: null }),
        })),
      });
    },
  };
}

export interface StubJudge extends MovieJudge {
  requests: JudgeRequest[];
}

export type JudgeScript = (request: JudgeRequest) => number | null | 'refused' | 'failed' | 'invalid';

/** A judge that follows a script. By default it abstains. */
export function createStubJudge(script: JudgeScript = () => null): StubJudge {
  const requests: JudgeRequest[] = [];
  const usage = { inputTokens: 20, outputTokens: 2 };
  return {
    requests,
    choose: (request) => {
      requests.push(request);
      const decision = script(request);
      if (decision === 'refused' || decision === 'failed' || decision === 'invalid') {
        return Promise.resolve({ status: decision, usage });
      }
      return Promise.resolve({ status: 'ok', id: decision, usage });
    },
  };
}

export interface MoviesHarnessOptions {
  tree?: readonly string[];
  io?: ReviewIO;
  judge?: JudgeScript | 'none';
  modelStatus?: 'refused' | 'failed' | 'invalid';
}

export async function moviesHarness(options: MoviesHarnessOptions = {}) {
  const root = await makeTempDir();
  const stateDir = await makeTempDir();
  await createTree(root, options.tree ?? moviesTree);
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', secrets: [], write: (_level, line) => void lines.push(line) });
  const model = createStubMovieModel(options.modelStatus);
  const tmdb: FakeTmdb = createFakeTmdb(catalog, spanishTitles);
  const judge = options.judge === 'none' ? undefined : createStubJudge(options.judge);
  let io = options.io ?? approvingIO;

  const deps: MoviesDeps = {
    loadConfig: () => Promise.resolve(parseConfig({ models: { parse: 'parse-model', judge: 'judge-model' } })),
    createParseModel: () => model,
    createJudge: () => judge,
    createTmdb: () => Promise.resolve(tmdb),
    createProbe: () => (path) => {
      const stem = /([^\\]+)\.[^.\\]+$/.exec(path)?.[1] ?? '';
      const minutes = durations[stem];
      return Promise.resolve(minutes === undefined ? null : { durationSeconds: minutes * 60, title: null });
    },
    createReviewIO: () => io,
    createBackends: () => createBackends({ runner: realRunner, locate: createToolLocator({}) }),
  };
  const run = async (command: string, ...flags: string[]) => {
    const program = buildProgram(
      { logger },
      {
        topLevel: [],
        mode: [
          // The shared commands (scan, apply, tag, undo) are registered by the videos factory for both modes.
          ...createVideosCommands({
            loadConfig: deps.loadConfig,
            createTitleModel: () => {
              throw new Error('videos mode is not used here');
            },
            createReviewIO: deps.createReviewIO,
            createBackends: deps.createBackends,
          }),
          ...createMoviesCommands(deps),
        ],
      },
    );
    await program.parseAsync(['node', 'plex-tidy', 'movies', command, '--root', root, '--state-dir', stateDir, ...flags]);
  };
  const useIO = (next: ReviewIO) => {
    io = next;
  };
  return { root, stateDir, lines, model, tmdb, judge, run, paths: rootStatePaths(stateDir, 'movies', root), useIO };
}

export type MoviesHarness = Awaited<ReturnType<typeof moviesHarness>>;

export async function buildMoviesPlan(h: MoviesHarness): Promise<void> {
  await h.run('scan');
  await h.run('parse');
  await h.run('resolve');
  await h.run('plan');
}
