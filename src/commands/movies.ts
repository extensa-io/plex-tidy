import type { Command } from 'commander';
import type { CliContext, ModeCommand } from '../cli-types.ts';
import { loadConfig, type Config } from '../config.ts';
import { isAppError } from '../errors.ts';
import { requireEnv } from '../env.ts';
import { createAnthropicMovieJudge, createAnthropicMovieParseModel } from '../llm/anthropic-movies.ts';
import type { MovieJudge } from '../llm/movie-judge.ts';
import type { MovieParseModel } from '../llm/movie-parser.ts';
import { planSchema } from '../plan/schemas.ts';
import { movieResolveFileSchema } from '../resolve/movie-schemas.ts';
import { createTerminalIO } from '../review/prompts.ts';
import type { ReviewIO } from '../review/review.ts';
import { scanSchema } from '../scan/schemas.ts';
import { readJsonFile } from '../state/json-file.ts';
import { openJournal } from '../state/journal.ts';
import type { Mode } from '../state/schemas.ts';
import { createBackends, type Backends } from '../tag/backends.ts';
import { createToolLocator, realRunner } from '../tag/runner.ts';
import { createTmdbClient, type TmdbClient } from '../tmdb/client.ts';
import { probeMedia } from '../tools/ffprobe.ts';
import { guidedRun } from './guided.ts';
import { parseMoviesStage, planMoviesStage, resolveMoviesStage, reviewMoviesStage, type ProbeVideo } from './movie-stages.ts';
import { addRunOptions, createRunContext, type RunContext } from './shared.ts';
import { logPlanSummary, scanStage } from './stages.ts';

/** What the movies commands need from outside, so tests can replace the model, TMDB, the terminal, and config.json. */
export interface MoviesDeps {
  loadConfig: () => Promise<Config>;
  createParseModel: (run: RunContext) => MovieParseModel;
  /** Returns undefined when the judge cannot run, so entries that need it go to review. */
  createJudge: (run: RunContext) => MovieJudge | undefined;
  createTmdb: (run: RunContext) => Promise<TmdbClient>;
  createProbe: (run: RunContext) => ProbeVideo;
  createReviewIO: () => ReviewIO;
  createBackends: (run: RunContext) => Backends;
}

const defaultDeps: MoviesDeps = {
  loadConfig: () => loadConfig(),
  createParseModel: (run) =>
    createAnthropicMovieParseModel({ apiKey: requireEnv('ANTHROPIC_API_KEY'), model: run.config.models.parse }),
  createJudge: (run) => {
    try {
      return createAnthropicMovieJudge({ apiKey: requireEnv('ANTHROPIC_API_KEY'), model: run.config.models.judge });
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
  createProbe: (run) => {
    const locate = createToolLocator(run.config.tools);
    return async (path) => {
      // A missing ffprobe stops the run; an unreadable file only has no probe.
      const ffprobe = await locate('ffprobe');
      try {
        const probe = await probeMedia(ffprobe, path);
        return { durationSeconds: probe.durationSeconds, title: probe.title };
      } catch (error) {
        if (isAppError(error) && error.code !== 'TOOL_NOT_FOUND') {
          return null;
        }
        throw error;
      }
    };
  },
  createReviewIO: createTerminalIO,
  createBackends: (run) => createBackends({ runner: realRunner, locate: createToolLocator(run.config.tools) }),
};

type Action = (run: RunContext, command: Command) => Promise<void>;

export function createMoviesCommands(deps: MoviesDeps = defaultDeps): ModeCommand[] {
  const modeCommand = (name: string, description: string, withYes: boolean, action: Action): ModeCommand => ({
    name,
    description,
    modes: ['movies'],
    register: (command: Command, mode: Mode, cli: CliContext) => {
      addRunOptions(command, withYes);
      command.action(async () => {
        await action(await createRunContext(command, mode, cli, deps.loadConfig), command);
      });
    },
  });

  const resolveDeps = async (run: RunContext) => ({
    tmdb: await deps.createTmdb(run),
    judge: deps.createJudge(run),
    probe: deps.createProbe(run),
  });

  const parseCommand = modeCommand('parse', 'read the movie title and year from each file name', false, async (run) => {
    await parseMoviesStage(run, deps.createParseModel(run));
  });

  const resolveCommand = modeCommand('resolve', 'match each file to a movie on TMDB', false, async (run) => {
    await resolveMoviesStage(run, await resolveDeps(run));
  });

  const planCommand = modeCommand('plan', 'write the list of renames', false, planMoviesStage);

  const reviewCommand = modeCommand('review', 'go through the proposed names and decide', false, async (run) => {
    await reviewMoviesStage(run, deps.createReviewIO(), await deps.createTmdb(run));
  });

  const statusCommand = modeCommand('status', 'show what stage the root is at', false, async (run) => {
    const [scan, resolved, plan] = await Promise.all([
      readJsonFile(run.paths.scan, scanSchema),
      readJsonFile(run.paths.resolve, movieResolveFileSchema),
      readJsonFile(run.paths.plan, planSchema),
    ]);
    const stage = (done: boolean) => (done ? 'done' : 'not done');
    run.logger.info(
      `scan: ${stage(scan !== undefined)}; parse: ${stage(resolved !== undefined)}; resolve: ${stage(resolved?.entries.some((entry) => entry.resolution !== null) ?? false)}; plan: ${stage(plan !== undefined)}`,
    );
    if (plan !== undefined) {
      logPlanSummary(run, plan);
    }
    const open = await openJournal(run.paths.journal).unmatchedIntents();
    if (open.length > 0) {
      run.logger.warn(`${open.length} journal intents have no done record; apply or undo will check them`);
    }
  });

  const runCommand = modeCommand('run', 'prepare, review, and rename, asking before each step', false, async (run) => {
    const io = deps.createReviewIO();
    // The client is made when a step first needs it, so answering No to step 1 needs no token.
    let pending: Promise<TmdbClient> | undefined;
    const tmdbFor = (current: RunContext): Promise<TmdbClient> => (pending ??= deps.createTmdb(current));
    await guidedRun(run, {
      io,
      createBackends: deps.createBackends,
      prepareQuestion:
        'Step 1 of 3, prepare: scan the folder, find each movie on TMDB, and build the rename plan.\n  The model sees file names only, never paths. TMDB sees titles and years. No file changes. Run it now?',
      prepare: async (current) => {
        await scanStage(current);
        await parseMoviesStage(current, deps.createParseModel(current));
        await resolveMoviesStage(current, {
          tmdb: await tmdbFor(current),
          judge: deps.createJudge(current),
          probe: deps.createProbe(current),
        });
        await planMoviesStage(current);
      },
      review: async (current, reviewIO) => reviewMoviesStage(current, reviewIO, await tmdbFor(current)),
    });
  });

  return [runCommand, parseCommand, resolveCommand, planCommand, reviewCommand, statusCommand];
}

export const moviesCommands: readonly ModeCommand[] = createMoviesCommands();
