import { describe, expect, it } from 'vitest';
import { planOperations, type Operation } from '../../src/apply/operations.ts';
import type { Plan, PlanEntry } from '../../src/plan/schemas.ts';

const planOf = (...entries: PlanEntry[]): Plan => ({
  schemaVersion: 1,
  scanId: '00000000-0000-4000-8000-000000000000',
  root: 'D:\\Library',
  builtAt: '2026-01-01T00:00:00.000Z',
  entries,
});

function entry(id: string, source: string, target: string, overrides: Partial<PlanEntry> = {}): PlanEntry {
  return {
    id,
    source,
    target,
    sidecars: [],
    folder: null,
    tagRecord: null,
    title: 'Title',
    titleSource: 'tmdb',
    confidence: 'high',
    reason: 'test',
    status: 'approved',
    tagStatus: 'untagged',
    tagReason: null,
    collision: false,
    ...overrides,
  };
}

const describeOps = (operations: readonly Operation[]): string[] =>
  operations.map((operation) => (operation.kind === 'mkdir' ? `mkdir ${operation.path}` : `rename ${operation.from} -> ${operation.to}`));

describe('planOperations', () => {
  it('renames a file in place and nothing else when the folders stay', () => {
    const operations = planOperations(planOf(entry('a', 'Show\\a.mkv', 'Show\\b.mkv')));
    expect(describeOps(operations)).toEqual(['rename Show\\a.mkv -> Show\\b.mkv']);
  });

  it('creates the season folder and moves the file into it', () => {
    const operations = planOperations(planOf(entry('a', 'Show\\a.mkv', 'Show\\Season 01\\b.mkv')));
    expect(describeOps(operations)).toEqual(['mkdir Show\\Season 01', 'rename Show\\a.mkv -> Show\\Season 01\\b.mkv']);
  });

  it('creates a folder only once for several files', () => {
    const operations = planOperations(
      planOf(entry('a', 'Show\\a.mkv', 'Show\\Season 01\\a2.mkv'), entry('b', 'Show\\b.mkv', 'Show\\Season 01\\b2.mkv')),
    );
    expect(describeOps(operations).filter((line) => line.startsWith('mkdir'))).toEqual(['mkdir Show\\Season 01']);
  });

  it('creates every missing folder of a new path, outermost first', () => {
    const operations = planOperations(planOf(entry('a', 'a.mkv', 'New Show\\Season 01\\a.mkv')));
    expect(describeOps(operations)).toEqual(['mkdir New Show', 'mkdir New Show\\Season 01', 'rename a.mkv -> New Show\\Season 01\\a.mkv']);
  });

  it('moves the files inside the old folder first and renames the folder last, once', () => {
    const folder = { source: 'Old', target: 'New (2000) {tmdb-1}' };
    const operations = planOperations(
      planOf(
        entry('a', 'Old\\Season 1\\a.mkv', 'New (2000) {tmdb-1}\\Season 01\\a2.mkv', { folder }),
        entry('b', 'Old\\Season 1\\b.mkv', 'New (2000) {tmdb-1}\\Season 01\\b2.mkv', {
          folder,
          sidecars: [{ source: 'Old\\Season 1\\b.en.srt', target: 'New (2000) {tmdb-1}\\Season 01\\b2.en.srt' }],
        }),
      ),
    );
    expect(describeOps(operations)).toEqual([
      'mkdir Old\\Season 01',
      'rename Old\\Season 1\\a.mkv -> Old\\Season 01\\a2.mkv',
      'rename Old\\Season 1\\b.mkv -> Old\\Season 01\\b2.mkv',
      'rename Old\\Season 1\\b.en.srt -> Old\\Season 01\\b2.en.srt',
      'rename Old -> New (2000) {tmdb-1}',
    ]);
  });

  it('moves the approved files one by one when the group is only partly approved', () => {
    const folder = { source: 'Old', target: 'New' };
    const operations = planOperations(
      planOf(
        entry('a', 'Old\\a.mkv', 'New\\Season 01\\a2.mkv', { folder }),
        entry('b', 'Old\\b.mkv', 'New\\Season 01\\b2.mkv', { folder, status: 'pending' }),
      ),
    );
    expect(describeOps(operations)).toEqual(['mkdir New', 'mkdir New\\Season 01', 'rename Old\\a.mkv -> New\\Season 01\\a2.mkv']);
  });

  it('moves files one by one when two folders would take the same name', () => {
    const operations = planOperations(
      planOf(
        entry('a', 'Old A\\a.mkv', 'New\\a2.mkv', { folder: { source: 'Old A', target: 'New' } }),
        entry('b', 'Old B\\b.mkv', 'New\\b2.mkv', { folder: { source: 'Old B', target: 'New' } }),
      ),
    );
    expect(describeOps(operations)).toEqual(['mkdir New', 'rename Old A\\a.mkv -> New\\a2.mkv', 'rename Old B\\b.mkv -> New\\b2.mkv']);
  });

  it('keeps the movie order: the file in the old folder, then the folder', () => {
    const operations = planOperations(
      planOf(entry('a', 'Old\\a.mkv', 'New {tmdb-1}\\New {tmdb-1}.mkv', { folder: { source: 'Old', target: 'New {tmdb-1}' } })),
    );
    expect(describeOps(operations)).toEqual(['rename Old\\a.mkv -> Old\\New {tmdb-1}.mkv', 'rename Old -> New {tmdb-1}']);
  });

  it('leaves out entries that are not approved, and renames that change nothing', () => {
    expect(planOperations(planOf(entry('a', 'a.mkv', 'b.mkv', { status: 'pending' })))).toEqual([]);
    expect(planOperations(planOf(entry('a', 'a.mkv', 'a.mkv')))).toEqual([]);
  });

  it('does not create folders for a target that leaves the root, so the rename reports it', () => {
    const operations = planOperations(planOf(entry('a', 'a.mkv', '..\\outside\\a.mkv')));
    expect(operations.every((operation) => operation.kind === 'rename')).toBe(true);
  });
});
