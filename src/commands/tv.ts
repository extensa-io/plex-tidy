import type { Command } from 'commander';
import type { CliContext, ModeCommand } from '../cli-types.ts';
import { loadConfig, type Config } from '../config.ts';
import { isAppError } from '../errors.ts';
import { requireEnv } from '../env.ts';
import { createAnthropicShowJudge, createAnthropicTvParseModel } from '../llm/anthropic-tv.ts';
import type { ShowJudge } from '../llm/tv-judge.ts';
import type { TvParseModel } from '../llm/tv-parser.ts';
import { planSchema } from '../plan/schemas.ts';
import { tvResolveFileSchema } from '../resolve/tv-schemas.ts';
import { createTerminalIO } from '../review/prompts.ts';
import type { ReviewIO } from '../review/review.ts';
import { scanSchema } from '../scan/schemas.ts';
import { readJsonFile } from '../state/json-file.ts';
import { openJournal } from '../state/journal.ts';
import type { Mode } from '../state/schemas.ts';
import { createBackends, type Backends } from '../tag/backends.ts';
import { createToolLocator, realRunner } from '../tag/runner.ts';
import { createTmdbClient, type TmdbClient } from '../tmdb/client.ts';
import { guidedRun } from './guided.ts';
import { addFolderOption, addRunOptions, createRunContext, type RunContext } from './shared.ts';
import { logPlanSummary, scanStage } from './stages.ts';
import { parseTvStage, planTvStage, resolveTvStage, reviewTvStage } from './tv-stages.ts';

/** What the TV commands need from outside, so tests can replace the model, TMDB, the terminal, and config.json. */
export interface TvDeps {
  loadConfig: () => Promise<Config>;
  createParseModel: (run: RunContext) => TvParseModel;
  /** Returns undefined when the judge cannot run, so shows that need it go to review. */
  createJudge: (run: RunContext) => ShowJudge | undefined;
  createTmdb: (run: RunContext) => Promise<TmdbClient>;
  createReviewIO: () => ReviewIO;
  createBackends: (run: RunContext) => Backends;
}

const defaultDeps: TvDeps = {
  loadConfig: () => loadConfig(),
  createParseModel: (run) =>
    createAnthropicTvParseModel({ apiKey: requireEnv('ANTHROPIC_API_KEY'), model: run.config.models.parse }),
  createJudge: (run) => {
    try {
      return createAnthropicShowJudge({ apiKey: requireEnv('ANTHROPIC_API_KEY'), model: run.config.models.judge });
    } catch (error) {
      if (isAppError(error)) {
        run.logger.warn(`${error.message} The judge is skipped.`);
        return undefined;
      }
      throw error;
    }
  },
  createTmdb: (run) =>
    createTmdbClient({
      token: requireEnv('TMDB_READ_ACCESS_TOKEN'),
      concurrency: run.config.tmdbConcurrency,
      cacheFile: run.caches.tmdb,
    }),
  createReviewIO: createTerminalIO,
  createBackends: (run) => createBackends({ runner: realRunner, locate: createToolLocator(run.config.tools) }),
};

type Action = (run: RunContext, command: Command) => Promise<void>;

export function createTvCommands(deps: TvDeps = defaultDeps): ModeCommand[] {
  const modeCommand = (name: string, description: string, action: Action, withOnly = false): ModeCommand => ({
    name,
    description,
    modes: ['tv'],
    register: (command: Command, mode: Mode, cli: CliContext) => {
      addRunOptions(command, false);
      if (withOnly) {
        addFolderOption(command);
      }
      command.action(async () => {
        await action(await createRunContext(command, mode, cli, deps.loadConfig), command);
      });
    },
  });

  const parseCommand = modeCommand('parse', 'read the season and episode from each file name', async (run) => {
    await parseTvStage(run, deps.createParseModel(run));
  });

  const resolveCommand = modeCommand('resolve', 'match each show and episode to TMDB', async (run) => {
    await resolveTvStage(run, { tmdb: await deps.createTmdb(run), judge: deps.createJudge(run) });
  });

  const planCommand = modeCommand('plan', 'write the list of renames', planTvStage);

  const reviewCommand = modeCommand('review', 'go through the proposed names and decide', async (run) => {
    await reviewTvStage(run, deps.createReviewIO(), await deps.createTmdb(run));
  });

  const statusCommand = modeCommand('status', 'show what stage the root is at', async (run) => {
    const [scan, resolved, plan] = await Promise.all([
      readJsonFile(run.paths.scan, scanSchema),
      readJsonFile(run.paths.resolve, tvResolveFileSchema),
      readJsonFile(run.paths.plan, planSchema),
    ]);
    const stage = (done: boolean) => (done ? 'done' : 'not done');
    run.logger.info(
      `scan: ${stage(scan !== undefined)}; parse: ${stage(resolved !== undefined)}; resolve: ${stage(resolved?.entries.some((entry) => entry.episode !== null) ?? false)}; plan: ${stage(plan !== undefined)}`,
    );
    if (plan !== undefined) {
      logPlanSummary(run, plan);
    }
    const open = await openJournal(run.paths.journal).unmatchedIntents();
    if (open.length > 0) {
      run.logger.warn(`${open.length} journal intents have no done record; apply or undo will check them`);
    }
  });

  const runCommand = modeCommand('run', 'prepare, review, and rename, asking before each step', async (run) => {
    const io = deps.createReviewIO();
    // The client is made when a step first needs it, so answering No to step 1 needs no token.
    let pending: Promise<TmdbClient> | undefined;
    const tmdbFor = (current: RunContext): Promise<TmdbClient> => (pending ??= deps.createTmdb(current));
    await guidedRun(run, {
      io,
      createBackends: deps.createBackends,
      prepareQuestion:
        'Step 1 of 4, prepare: scan the folder, find each show and episode on TMDB, and build the rename plan.\n  The model sees file names only, never paths or folder names. TMDB sees show titles and years. No file changes. Run it now?',
      prepare: async (current) => {
        await scanStage(current);
        await parseTvStage(current, deps.createParseModel(current));
        await resolveTvStage(current, { tmdb: await tmdbFor(current), judge: deps.createJudge(current) });
        await planTvStage(current);
      },
      review: async (current, reviewIO) => reviewTvStage(current, reviewIO, await tmdbFor(current)),
    });
  }, true);

  return [runCommand, parseCommand, resolveCommand, planCommand, reviewCommand, statusCommand];
}

export const tvCommands: readonly ModeCommand[] = createTvCommands();
