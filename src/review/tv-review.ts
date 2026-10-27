import { win32 } from 'node:path';
import { parseEpisodeName } from '../parse/tv.ts';
import type { PathExists } from '../plan/build.ts';
import type { Plan, PlanEntry } from '../plan/schemas.ts';
import { isOpenForReview } from '../plan/status.ts';
import { buildTvPlan } from '../plan/tv.ts';
import { resolveEpisodes } from '../resolve/tv.ts';
import type { TvResolveFile, TvShowCandidate, TvShowGroup } from '../resolve/tv-schemas.ts';
import type { Scan } from '../scan/schemas.ts';
import type { TmdbClient } from '../tmdb/client.ts';
import type { ShowDetails } from '../tmdb/schemas.ts';
import type { Choice, ReviewIO } from './review.ts';

export interface TvReviewDeps {
  io: ReviewIO;
  tmdb: TmdbClient;
  scan: Scan;
  exists: PathExists;
  /** Called after every decision, so quitting loses nothing. */
  saveResolved: (resolved: TvResolveFile) => Promise<void>;
  savePlan: (plan: Plan) => Promise<void>;
}

export interface TvReviewSummary {
  plan: Plan;
  resolved: TvResolveFile;
  shows: number;
  accepted: number;
  edited: number;
  skipped: number;
  left: number;
}

const SEARCH_RESULTS_SHOWN = 5;

function describeShow(show: ShowDetails, score?: number): string {
  const year = show.year === null ? '' : ` (${show.year})`;
  const seasons = show.seasons.filter((season) => season.season > 0).length;
  const episodes = show.episodeCount === null ? '' : `, ${show.episodeCount} episodes`;
  const scored = score === undefined ? '' : `, score ${score.toFixed(2)}`;
  return `${show.name}${year}, ${seasons} seasons${episodes}${scored}`;
}

/** A show decision is open when the show is not chosen, or the judge chose it. */
export function showNeedsDecision(group: TvShowGroup): boolean {
  return group.resolution === null || group.resolution.via === 'none' || group.resolution.via === 'judge';
}

/**
 * Review for TV: first one decision for each show that is not sure, which
 * applies to all of its episodes, then the episodes that still wait. Choosing
 * a show or typing a season and episode changes what resolve decided, so
 * both files are rewritten and the plan is built again.
 */
export async function runTvReview(initialPlan: Plan, initialResolved: TvResolveFile, deps: TvReviewDeps): Promise<TvReviewSummary> {
  const { io } = deps;
  const summary: TvReviewSummary = { plan: initialPlan, resolved: initialResolved, shows: 0, accepted: 0, edited: 0, skipped: 0, left: 0 };

  const rebuild = async (): Promise<void> => {
    summary.plan = await buildTvPlan(deps.scan, summary.resolved, { exists: deps.exists, previous: summary.plan });
    await deps.saveResolved(summary.resolved);
    await deps.savePlan(summary.plan);
  };
  const setEntry = async (entry: PlanEntry): Promise<void> => {
    summary.plan = { ...summary.plan, entries: summary.plan.entries.map((other) => (other.id === entry.id ? entry : other)) };
    await deps.savePlan(summary.plan);
  };

  // Show decisions first.
  const open = summary.resolved.shows.filter(showNeedsDecision);
  for (const [index, listed] of open.entries()) {
    const group = summary.resolved.shows.find((other) => other.key === listed.key) ?? listed;
    const result = await decideShow(io, deps.tmdb, group, index + 1, open.length);
    if (result.kind === 'quit') {
      summary.left = open.length - index;
      return summary;
    }
    if (result.kind === 'skip') {
      summary.plan = {
        ...summary.plan,
        entries: summary.plan.entries.map((entry) =>
          group.fileIds.includes(entry.id) && entry.status !== 'applied' ? { ...entry, status: 'rejected' } : entry,
        ),
      };
      await deps.savePlan(summary.plan);
      summary.skipped += group.fileIds.length;
      continue;
    }
    await applyShowChoice(summary, group, result.show, result.score, deps);
    summary.shows += 1;
    await rebuild();
  }

  // Then the episodes that wait.
  const waiting = summary.plan.entries.filter(isOpenForReview);
  for (const [index, listed] of waiting.entries()) {
    let entry = summary.plan.entries.find((other) => other.id === listed.id) ?? listed;
    for (;;) {
      showEpisode(io, entry, index + 1, waiting.length);
      const choices: Choice[] = [
        ...(entry.status === 'pending' && entry.title !== null && !entry.collision ? [{ value: 'accept', label: 'Accept this name' }] : []),
        { value: 'numbers', label: 'Set the season and episode' },
        { value: 'skip', label: 'Skip: leave this file as it is' },
        { value: 'quit', label: 'Quit and keep my decisions so far' },
      ];
      const action = await io.choose('What should happen to this file?', choices);
      if (action === 'quit') {
        summary.left = waiting.length - index;
        return summary;
      }
      if (action === 'skip') {
        await setEntry({ ...entry, status: 'rejected' });
        summary.skipped += 1;
        break;
      }
      if (action === 'accept') {
        await setEntry({ ...entry, status: 'approved' });
        summary.accepted += 1;
        break;
      }

      const typed = (await io.ask('Season and episode, for example s02e05, 2x05, or s02e05-e06:')).trim();
      const numbers = parseEpisodeName(typed);
      if (numbers?.season == null || numbers.episode === null) {
        io.print('Those are not a season and an episode. Use a form such as s02e05.');
        continue;
      }
      const resolvedEntry = summary.resolved.entries.find((other) => other.id === entry.id);
      if (resolvedEntry === undefined) {
        io.print('This file is not in the scan. Run scan, parse, resolve, and plan again.');
        continue;
      }
      const manual = { season: numbers.season, episode: numbers.episode, episodeEnd: numbers.episodeEnd };
      const updated = await resolveEpisodes(deps.scan, summary.resolved.shows, [{ ...resolvedEntry, manual }], { tmdb: deps.tmdb });
      summary.resolved = {
        ...summary.resolved,
        entries: summary.resolved.entries.map((other) => updated.find((item) => item.id === other.id) ?? other),
      };
      await rebuild();
      entry = summary.plan.entries.find((other) => other.id === entry.id) ?? entry;
      if (entry.title === null || entry.collision) {
        io.print(entry.title === null ? entry.reason : 'That episode is already used by another file.');
        continue;
      }
      await setEntry({ ...entry, status: 'approved', titleSource: 'manual', reason: 'season and episode typed in review' });
      summary.edited += 1;
      break;
    }
  }
  return summary;
}

type ShowDecision =
  | { kind: 'show'; show: ShowDetails; score: number | null }
  | { kind: 'skip' }
  | { kind: 'quit' };

async function decideShow(io: ReviewIO, tmdb: TmdbClient, group: TvShowGroup, position: number, total: number): Promise<ShowDecision> {
  let options: TvShowCandidate[] = group.candidates;
  const known = new Map(group.candidates.map((candidate) => [candidate.details.id, candidate]));
  for (;;) {
    io.print('');
    io.print(`[show ${position}/${total}] ${group.fileIds.length} episode files${group.dir === '' ? '' : ` in ${win32.basename(group.dir)}`}`);
    io.print(`  ${group.resolution?.reason ?? 'no show was chosen'}`);
    const picked = group.resolution?.via === 'judge' ? group.candidates.find((candidate) => candidate.details.id === group.resolution?.chosenId) : undefined;
    const choices: Choice[] = [
      ...(picked === undefined ? [] : [{ value: `pick:${picked.details.id}`, label: `Keep the judge's pick: ${describeShow(picked.details, picked.score)}` }]),
      ...options
        .filter((candidate) => candidate.details.id !== picked?.details.id)
        .map((candidate) => ({ value: `pick:${candidate.details.id}`, label: `Use ${describeShow(candidate.details, candidate.score)}` })),
      { value: 'search', label: 'Search TMDB by title' },
      { value: 'id', label: 'Enter a TMDB id' },
      { value: 'skip', label: 'Skip this show: leave all its files as they are' },
      { value: 'quit', label: 'Quit and keep my decisions so far' },
    ];
    const action = await io.choose('Which show is this?', choices);

    if (action === 'quit') {
      return { kind: 'quit' };
    }
    if (action === 'skip') {
      return { kind: 'skip' };
    }
    if (action.startsWith('pick:')) {
      const id = Number(action.slice('pick:'.length));
      const chosen = known.get(id)?.details ?? (await tmdb.showDetails(id));
      if (chosen !== undefined) {
        return { kind: 'show', show: chosen, score: known.get(id)?.score ?? null };
      }
      io.print('That show is no longer available.');
      continue;
    }
    if (action === 'search') {
      const query = (await io.ask('Show to search for:')).trim();
      const hits = query === '' ? [] : (await tmdb.searchShows({ query })).slice(0, SEARCH_RESULTS_SHOWN);
      const found: TvShowCandidate[] = [];
      for (const hit of hits) {
        const details = await tmdb.showDetails(hit.id);
        if (details !== undefined) {
          const candidate = { details, score: 0, reason: 'found by a search in review' };
          found.push(candidate);
          known.set(details.id, candidate);
        }
      }
      io.print(found.length === 0 ? 'TMDB found nothing for that title.' : `TMDB found ${found.length} shows.`);
      options = found.length === 0 ? options : found;
      continue;
    }
    const typed = Number((await io.ask('TMDB show id:')).trim());
    const details = Number.isInteger(typed) && typed > 0 ? await tmdb.showDetails(typed) : undefined;
    if (details === undefined) {
      io.print('TMDB has no show with that id.');
    } else {
      const candidate = { details, score: 0, reason: 'entered by id in review' };
      known.set(details.id, candidate);
      options = [candidate];
    }
  }
}

/** Records the owner's choice for a show and matches its episodes again. */
async function applyShowChoice(
  summary: TvReviewSummary,
  group: TvShowGroup,
  show: ShowDetails,
  score: number | null,
  deps: TvReviewDeps,
): Promise<void> {
  const others = group.candidates.filter((candidate) => candidate.details.id !== show.id);
  const updatedGroup: TvShowGroup = {
    ...group,
    candidates: [{ details: show, score: score ?? 1, reason: 'chosen in review' }, ...others],
    resolution: { chosenId: show.id, via: 'manual', confidence: 'high', score: null, reason: 'show chosen in review' },
  };
  const shows = summary.resolved.shows.map((other) => (other.key === group.key ? updatedGroup : other));
  const entries = await resolveEpisodes(
    deps.scan,
    shows,
    summary.resolved.entries.filter((entry) => entry.groupKey === group.key),
    { tmdb: deps.tmdb },
  );
  summary.resolved = {
    ...summary.resolved,
    shows,
    entries: summary.resolved.entries.map((entry) => entries.find((item) => item.id === entry.id) ?? entry),
  };
}

function showEpisode(io: ReviewIO, entry: PlanEntry, position: number, total: number): void {
  io.print('');
  io.print(`[${position}/${total}]`);
  io.print(`  old: ${entry.source}`);
  io.print(`  new: ${entry.title === null ? '(no episode matched)' : entry.target}`);
  io.print(`  ${entry.confidence} confidence: ${entry.reason}`);
}
