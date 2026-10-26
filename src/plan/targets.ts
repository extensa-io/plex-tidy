import { win32 } from 'node:path';
import type { ScanFile } from '../scan/schemas.ts';
import type { PlanEntry, SidecarRename } from './schemas.ts';

export interface TargetNames {
  target: string;
  sidecars: SidecarRename[];
}

/** The folder part of a path relative to the root. Empty for a file directly in the root. */
export function folderOf(relativePath: string): string {
  const folder = win32.dirname(relativePath);
  return folder === '.' ? '' : folder;
}

/** New names for a video and its sidecars, in the same folder. Sidecars keep everything after the video stem. */
export function targetNames(file: Pick<ScanFile, 'path' | 'ext' | 'sidecars'>, newStem: string): TargetNames {
  const folder = folderOf(file.path);
  return {
    target: win32.join(folder, `${newStem}${file.ext}`),
    sidecars: file.sidecars.map((sidecar) => ({
      source: sidecar.path,
      target: win32.join(folder, `${newStem}${sidecar.suffix}`),
    })),
  };
}

/** Every path an entry would write: the video target and each sidecar target. */
export function entryTargets(entry: Pick<PlanEntry, 'target' | 'sidecars'>): string[] {
  return [entry.target, ...entry.sidecars.map((sidecar) => sidecar.target)];
}

/** Every path an entry would read: the video and each sidecar. */
export function entrySources(entry: Pick<PlanEntry, 'source' | 'sidecars'>): string[] {
  return [entry.source, ...entry.sidecars.map((sidecar) => sidecar.source)];
}

/** Windows paths compare without regard to case. */
export function pathKey(relativePath: string): string {
  return relativePath.toLowerCase();
}
