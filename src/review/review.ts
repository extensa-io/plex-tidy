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

export interface ReviewDeps {
  io: ReviewIO;
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

function show(io: ReviewIO, entry: PlanEntry, position: number, total: number): void {
  const folder = folderOf(entry.source);
  io.print('');
  io.print(`[${position}/${total}]${folder === '' ? '' : ` in ${folder}`}`);
  io.print(`  old: ${win32.basename(entry.source)}`);
  io.print(`  new: ${entry.title === null ? '(no title found)' : win32.basename(entry.target)}`);
  io.print(`  ${entry.confidence} confidence: ${entry.reason}`);
}
