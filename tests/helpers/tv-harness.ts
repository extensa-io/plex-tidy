import { afterEach } from 'vitest';
import { buildProgram } from '../../src/cli.ts';
import { createTvCommands, type TvDeps } from '../../src/commands/tv.ts';
import { createVideosCommands } from '../../src/commands/videos.ts';
import { parseConfig } from '../../src/config.ts';
import type { ShowJudge, ShowJudgeRequest } from '../../src/llm/tv-judge.ts';
import type { TvNameItem, TvParseModel } from '../../src/llm/tv-parser.ts';
import { createLogger } from '../../src/logger.ts';
import type { ReviewIO } from '../../src/review/review.ts';
import { rootStatePaths } from '../../src/state/paths.ts';
import { createBackends } from '../../src/tag/backends.ts';
import { createToolLocator, realRunner } from '../../src/tag/runner.ts';
import { episodesOf, shows, tvModelAnswers, tvTree } from '../fixtures/tv-corpus.ts';
import { approvingIO } from './cli-harness.ts';
import { createFakeTmdb, type FakeTmdb } from './fake-tmdb.ts';
import { useTempDirs } from './temp-dir.ts';
import { createTree } from './tree.ts';

const makeTempDir = useTempDirs();

afterEach(() => {
  process.exitCode = undefined;
});

export interface StubTvModel extends TvParseModel {
  /** Every batch received, exactly as it would be sent. */
  batches: (readonly TvNameItem[])[];
}

export function createStubTvModel(status?: 'refused' | 'failed' | 'invalid'): StubTvModel {
  const batches: (readonly TvNameItem[])[] = [];
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
          ...(tvModelAnswers[item.name] ?? { show: null, year: null, season: null, episode: null, episodeEnd: null, episodeTitle: null }),
        })),
      });
    },
  };
}

export interface StubShowJudge extends ShowJudge {
  requests: ShowJudgeRequest[];
}

export type ShowJudgeScript = (request: ShowJudgeRequest) => number | null | 'refused' | 'failed' | 'invalid';

/** A judge that follows a script. By default it abstains. */
export function createStubShowJudge(script: ShowJudgeScript = () => null): StubShowJudge {
  const requests: ShowJudgeRequest[] = [];
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

export interface TvHarnessOptions {
  tree?: readonly string[];
  io?: ReviewIO;
  judge?: ShowJudgeScript | 'none';
  modelStatus?: 'refused' | 'failed' | 'invalid';
}

export async function tvHarness(options: TvHarnessOptions = {}) {
  const root = await makeTempDir();
  const stateDir = await makeTempDir();
  await createTree(root, options.tree ?? tvTree);
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', secrets: [], write: (_level, line) => void lines.push(line) });
  const model = createStubTvModel(options.modelStatus);
  const tmdb: FakeTmdb = createFakeTmdb([], {}, { shows, episodes: episodesOf });
  const judge = options.judge === 'none' ? undefined : createStubShowJudge(options.judge);
  let io = options.io ?? approvingIO;

  const deps: TvDeps = {
    loadConfig: () => Promise.resolve(parseConfig({ models: { parse: 'parse-model', judge: 'judge-model' } })),
    createParseModel: () => model,
    createJudge: () => judge,
    createTmdb: () => Promise.resolve(tmdb),
    createReviewIO: () => io,
    createBackends: () => createBackends({ runner: realRunner, locate: createToolLocator({}) }),
  };
  const run = async (command: string, ...flags: string[]) => {
    const program = buildProgram(
      { logger },
      {
        topLevel: [],
        mode: [
          // The shared commands (scan, apply, tag, undo) are registered by the videos factory for every mode.
          ...createVideosCommands({
            loadConfig: deps.loadConfig,
            createTitleModel: () => {
              throw new Error('videos mode is not used here');
            },
            createReviewIO: deps.createReviewIO,
            createBackends: deps.createBackends,
          }),
          ...createTvCommands(deps),
        ],
      },
    );
    await program.parseAsync(['node', 'plex-tidy', 'tv', command, '--root', root, '--state-dir', stateDir, ...flags]);
  };
  const useIO = (next: ReviewIO) => {
    io = next;
  };
  return { root, stateDir, lines, model, tmdb, judge, run, paths: rootStatePaths(stateDir, 'tv', root), useIO };
}

export type TvHarness = Awaited<ReturnType<typeof tvHarness>>;

export async function buildTvPlanFiles(h: TvHarness): Promise<void> {
  await h.run('scan');
  await h.run('parse');
  await h.run('resolve');
  await h.run('plan');
}
