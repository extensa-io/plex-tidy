import { win32 } from 'node:path';
import { applyManualTitle } from '../plan/edit.ts';
import type { PathExists } from '../plan/build.ts';
import type { Plan, PlanEntry } from '../plan/schemas.ts';
import { isOpenForReview } from '../plan/status.ts';
import { folderOf } from '../plan/targets.ts';
import type { ScanFile } from '../scan/schemas.ts';

export interface Choice {
  value: string;
  label: string;
}

/** The terminal, behind an interface so tests can script the answers. */
export interface ReviewIO {
  print(line: string): void;
  /** `defaultYes` is the answer when the owner just presses Enter. */
  confirm(message: string, defaultYes?: boolean): Promise<boolean>;
  choose(message: string, choices: readonly Choice[]): Promise<string>;
  ask(message: string): Promise<string>;
}

/** A movie the owner can pick for an entry in movies mode. */
export interface MovieOption {
  id: number;
  /** One line, such as `Title (2010), 120 min, score 0.82`. */
  label: string;
}

/** What movies mode adds to review: TMDB candidates, a search, and an id lookup. */
export interface MovieReviewDeps {
  /** The scored candidates the resolve step found for an entry. */
  optionsFor(entryId: string): readonly MovieOption[];
  /** Searches TMDB for a typed title. */
  search(query: string): Promise<readonly MovieOption[]>;
  /** Checks that TMDB has a movie with this id. */
  lookup(id: number): Promise<MovieOption | undefined>;
  /** Builds the entry for the picked movie, or says why it cannot be used. */
  choose(plan: Plan, entry: PlanEntry, movieId: number): Promise<{ ok: true; entry: PlanEntry } | { ok: false; message: string }>;
}

export interface ReviewDeps {
  io: ReviewIO;
  /** Set in movies mode. Replaces typing a title with picking a movie. */
  movies?: MovieReviewDeps;
  /** Scan data by entry id, for the extension and sidecars of a file whose title is typed. */
  files: ReadonlyMap<string, Pick<ScanFile, 'path' | 'ext' | 'sidecars'>>;
  exists: PathExists;
  /** Called after every decision, so quitting loses nothing. */
  save: (plan: Plan) => Promise<void>;
}

export interface ReviewSummary {
  plan: Plan;
  bulkApproved: number;
  accepted: number;
  edited: number;
  skipped: number;
  left: number;
}

/** A filename title that passed the word check and collides with nothing. */
export function isBulkApprovable(entry: PlanEntry): boolean {
  return entry.status === 'pending' && entry.titleSource === 'filename' && entry.confidence === 'high' && !entry.collision;
}

export async function runReview(initial: Plan, deps: ReviewDeps): Promise<ReviewSummary> {
  const { io } = deps;
  const summary: ReviewSummary = { plan: initial, bulkApproved: 0, accepted: 0, edited: 0, skipped: 0, left: 0 };

  const replace = async (entry: PlanEntry): Promise<void> => {
    summary.plan = { ...summary.plan, entries: summary.plan.entries.map((other) => (other.id === entry.id ? entry : other)) };
    await deps.save(summary.plan);
  };

  const bulk = summary.plan.entries.filter(isBulkApprovable);
  if (bulk.length > 0) {
    io.print(`${bulk.length} entries have a title from the file name, passed the word check, and collide with nothing:`);
    for (const entry of bulk) {
      io.print(`  ${win32.basename(entry.source)}  ->  ${win32.basename(entry.target)}`);
    }
    if (await io.confirm(`Approve all ${bulk.length} of them?`)) {
      const ids = new Set(bulk.map((entry) => entry.id));
      summary.plan = {
        ...summary.plan,
        entries: summary.plan.entries.map((entry) => (ids.has(entry.id) ? { ...entry, status: 'approved' } : entry)),
      };
      summary.bulkApproved = bulk.length;
      await deps.save(summary.plan);
    }
  }

  const open = summary.plan.entries.filter(isOpenForReview);
  for (const [index, listed] of open.entries()) {
    let entry = summary.plan.entries.find((other) => other.id === listed.id) ?? listed;
    if (deps.movies !== undefined) {
      const result = await reviewMovie(io, deps.movies, () => summary.plan, entry, index + 1, open.length, replace);
      if (result === 'quit') {
        summary.left = open.length - index;
        return summary;
      }
      summary[result] += 1;
      continue;
    }
    for (;;) {
      show(io, entry, index + 1, open.length);
      const choices: Choice[] = [
        ...(entry.title === null ? [] : [{ value: 'accept', label: 'Accept this name' }]),
        { value: 'edit', label: 'Edit: type a title' },
        { value: 'skip', label: 'Skip: leave this file as it is' },
        { value: 'quit', label: 'Quit and keep my decisions so far' },
      ];
      const action = await io.choose('What should happen to this file?', choices);

      if (action === 'quit') {
        summary.left = open.length - index;
        return summary;
      }
      if (action === 'accept') {
        if (entry.title === null) {
          io.print('This file has no proposed name. Type a title or skip it.');
          continue;
        }
        await replace({ ...entry, status: 'approved' });
        summary.accepted += 1;
        break;
      }
      if (action === 'skip') {
        await replace({ ...entry, status: 'rejected' });
        summary.skipped += 1;
        break;
      }

      const file = deps.files.get(entry.id);
      if (file === undefined) {
        io.print('This file is not in the scan. Run scan, parse, resolve, and plan again.');
        continue;
      }
      const typed = await io.ask('Title (without the extension):');
      const edit = await applyManualTitle(summary.plan, entry, typed, file, deps.exists);
      if (!edit.ok) {
        io.print(edit.message);
        continue;
      }
      entry = edit.entry;
      await replace(entry);
      summary.edited += 1;
      break;
    }
  }
  return summary;
}

/** Reviews one movie: accept the proposal, pick a candidate, search TMDB, enter an id, or skip. */
async function reviewMovie(
  io: ReviewIO,
  movies: MovieReviewDeps,
  currentPlan: () => Plan,
  initial: PlanEntry,
  position: number,
  total: number,
  replace: (entry: PlanEntry) => Promise<void>,
): Promise<'accepted' | 'edited' | 'skipped' | 'quit'> {
  let entry = initial;
  let options = movies.optionsFor(entry.id);
  for (;;) {
    show(io, entry, position, total);
    const choices: Choice[] = [
      ...(entry.status === 'pending' && entry.title !== null && !entry.collision
        ? [{ value: 'accept', label: 'Accept this name' }]
        : []),
      ...options.map((option) => ({ value: `pick:${option.id}`, label: `Use ${option.label}` })),
      { value: 'search', label: 'Search TMDB by title' },
      { value: 'id', label: 'Enter a TMDB id' },
      { value: 'skip', label: 'Skip: leave this file as it is' },
      { value: 'quit', label: 'Quit and keep my decisions so far' },
    ];
    const action = await io.choose('What should happen to this file?', choices);

    if (action === 'quit') {
      return 'quit';
    }
    if (action === 'skip') {
      await replace({ ...entry, status: 'rejected' });
      return 'skipped';
    }
    if (action === 'accept') {
      await replace({ ...entry, status: 'approved' });
      return 'accepted';
    }
    if (action.startsWith('pick:')) {
      const result = await movies.choose(currentPlan(), entry, Number(action.slice('pick:'.length)));
      if (!result.ok) {
        io.print(result.message);
        continue;
      }
      entry = result.entry;
      await replace(entry);
      return 'edited';
    }
    if (action === 'search') {
      const query = (await io.ask('Title to search for:')).trim();
      const found = query === '' ? [] : await movies.search(query);
      io.print(found.length === 0 ? 'TMDB found nothing for that title.' : `TMDB found ${found.length} movies.`);
      options = found.length === 0 ? options : found;
      continue;
    }
    const typed = Number((await io.ask('TMDB movie id:')).trim());
    const found = Number.isInteger(typed) && typed > 0 ? await movies.lookup(typed) : undefined;
    if (found === undefined) {
      io.print('TMDB has no movie with that id.');
    } else {
      options = [found];
    }
  }
}

function show(io: ReviewIO, entry: PlanEntry, position: number, total: number): void {
  const folder = folderOf(entry.source);
  io.print('');
  io.print(`[${position}/${total}]${folder === '' ? '' : ` in ${folder}`}`);
  io.print(`  old: ${win32.basename(entry.source)}`);
  const renamedFolder = entry.folder === null ? '' : `${win32.basename(entry.folder.target)}\\`;
  io.print(`  new: ${entry.title === null ? '(no title found)' : `${renamedFolder}${win32.basename(entry.target)}`}`);
  io.print(`  ${entry.confidence} confidence: ${entry.reason}`);
}
