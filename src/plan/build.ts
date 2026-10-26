import { win32 } from 'node:path';
import { AppError } from '../errors.ts';
import type { ResolveFile } from '../resolve/schemas.ts';
import type { Scan, ScanFile } from '../scan/schemas.ts';
import { PLAN_SCHEMA_VERSION, type Plan, type PlanEntry } from './schemas.ts';
import { entryTargets, folderOf, pathKey, targetNames } from './targets.ts';

export type PathExists = (absolutePath: string) => Promise<boolean>;

export interface BuildPlanOptions {
  exists: PathExists;
  /** A plan from an earlier run. Review decisions on entries that did not change carry over. */
  previous?: Plan | undefined;
  now?: Date;
}

const MAX_NUMBER = 999;

interface Draft {
  file: ScanFile;
  title: string | null;
  titleSource: PlanEntry['titleSource'];
  confidence: PlanEntry['confidence'];
  reason: string;
  stem: string | null;
  collision: boolean;
}

export async function buildPlan(scan: Scan, resolved: ResolveFile, options: BuildPlanOptions): Promise<Plan> {
  if (resolved.scanId !== scan.scanId) {
    throw new AppError('STAGE_STALE', 'resolve.json was made from an older scan. Run parse and resolve again.');
  }
  const resolutions = new Map(resolved.entries.map((entry) => [entry.id, entry.resolution]));

  const drafts = scan.files.map((file): Draft => {
    const resolution = resolutions.get(file.id);
    if (resolution === undefined || resolution === null) {
      throw new AppError('STAGE_MISSING', 'Some files have no resolution. Run resolve first.');
    }
    return {
      file,
      title: resolution.title,
      titleSource: resolution.source,
      confidence: resolution.confidence,
      reason: resolution.reason,
      stem: resolution.title,
      collision: false,
    };
  });

  numberCollidingTitles(drafts);
  await avoidExistingFiles(drafts, scan.root, options.exists);

  const entries = drafts.map((draft) => toEntry(draft));
  markDuplicateTargets(entries);

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    scanId: scan.scanId,
    root: scan.root,
    builtAt: (options.now ?? new Date()).toISOString(),
    entries: carryOverDecisions(entries, options.previous),
  };
}

/**
 * Two or more files in one folder with the same title (ignoring case) all get
 * a number, ordered by original file name.
 */
function numberCollidingTitles(drafts: Draft[]): void {
  const groups = new Map<string, Draft[]>();
  for (const draft of drafts) {
    if (draft.title === null) {
      continue;
    }
    const key = `${pathKey(folderOf(draft.file.path))}\0${draft.title.toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), draft]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const ordered = [...group].sort(
      (a, b) => a.file.stem.toLowerCase().localeCompare(b.file.stem.toLowerCase()) || a.file.stem.localeCompare(b.file.stem),
    );
    for (const [index, draft] of ordered.entries()) {
      draft.stem = numbered(draft.title ?? '', index + 1);
      draft.collision = true;
    }
  }
}

/**
 * A target that already exists on disk is a collision. The entry takes the
 * first free number instead, and review sees it.
 */
async function avoidExistingFiles(drafts: Draft[], root: string, exists: PathExists): Promise<void> {
  // Every path any entry reads or writes is taken, including files about to be renamed away.
  const taken = new Set<string>();
  for (const draft of drafts) {
    for (const path of sourcePaths(draft.file)) {
      taken.add(pathKey(path));
    }
  }
  for (const draft of drafts) {
    if (draft.stem !== null) {
      for (const path of entryTargets(targetNames(draft.file, draft.stem))) {
        taken.add(pathKey(path));
      }
    }
  }

  for (const draft of drafts) {
    if (draft.title === null || draft.stem === null) {
      continue;
    }
    const own = new Set(sourcePaths(draft.file).map(pathKey));
    const blocked = async (stem: string): Promise<boolean> => {
      for (const path of entryTargets(targetNames(draft.file, stem))) {
        if (!own.has(pathKey(path)) && (await exists(win32.join(root, path)))) {
          return true;
        }
      }
      return false;
    };
    if (!(await blocked(draft.stem))) {
      continue;
    }
    for (let number = 1; number <= MAX_NUMBER; number += 1) {
      const stem = numbered(draft.title, number);
      const paths = entryTargets(targetNames(draft.file, stem)).map(pathKey);
      if (!(await blocked(stem)) && !paths.some((path) => taken.has(path))) {
        draft.stem = stem;
        draft.collision = true;
        for (const path of paths) {
          taken.add(path);
        }
        break;
      }
    }
  }
}

function sourcePaths(file: ScanFile): string[] {
  return [file.path, ...file.sidecars.map((sidecar) => sidecar.path)];
}

function numbered(title: string, number: number): string {
  return `${title} ${String(number).padStart(2, '0')}`;
}

function toEntry(draft: Draft): PlanEntry {
  const { file } = draft;
  const base = { id: file.id, title: draft.title, titleSource: draft.titleSource, confidence: draft.confidence };
  const unchangedNames = { target: file.path, sidecars: file.sidecars.map((s) => ({ source: s.path, target: s.path })) };

  if (draft.stem === null) {
    return {
      ...base,
      source: file.path,
      ...unchangedNames,
      reason: 'no-title',
      status: 'skipped',
      tagStatus: 'untagged',
      collision: false,
    };
  }

  const names = targetNames(file, draft.stem);
  const unchanged =
    names.target === file.path && names.sidecars.every((sidecar) => sidecar.source === sidecar.target);
  return {
    ...base,
    source: file.path,
    ...names,
    reason: unchanged
      ? 'unchanged'
      : draft.collision
        ? 'the name collides with another file or an existing file; numbered'
        : draft.reason,
    status: unchanged ? 'skipped' : 'pending',
    tagStatus: 'untagged',
    collision: draft.collision,
  };
}

/** Last check: two entries must never share a target. Review can edit them, and apply refuses them. */
function markDuplicateTargets(entries: PlanEntry[]): void {
  const owners = new Map<string, PlanEntry[]>();
  for (const entry of entries) {
    for (const path of entryTargets(entry)) {
      owners.set(pathKey(path), [...(owners.get(pathKey(path)) ?? []), entry]);
    }
  }
  for (const group of owners.values()) {
    const distinct = new Set(group);
    if (distinct.size < 2) {
      continue;
    }
    for (const entry of distinct) {
      entry.collision = true;
      if (entry.status === 'skipped' && entry.reason === 'unchanged') {
        entry.status = 'pending';
      }
      entry.reason = 'the name is also the target of another entry';
    }
  }
}

/** Approved and rejected decisions survive a rebuild when the proposal is the same, or was typed by the owner. */
function carryOverDecisions(entries: PlanEntry[], previous: Plan | undefined): PlanEntry[] {
  if (previous === undefined) {
    return entries;
  }
  const earlier = new Map(previous.entries.map((entry) => [entry.id, entry]));
  return entries.map((entry) => {
    const before = earlier.get(entry.id);
    const decided = before?.status === 'approved' || before?.status === 'rejected';
    if (before === undefined || !decided || before.source !== entry.source) {
      return entry;
    }
    return before.titleSource === 'manual' || before.target === entry.target ? before : entry;
  });
}
