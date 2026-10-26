import { execFile } from 'node:child_process';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveBinary } from '../../src/tools/run.ts';
import type { BackendDeps } from '../../src/tag/backend.ts';
import { createToolLocator, realRunner } from '../../src/tag/runner.ts';

const run = promisify(execFile);

export interface RealTools {
  ffmpeg: string;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Finds ffmpeg, which makes the sample videos, next to ffprobe. Returns
 * `undefined` when any tool the tag tests need is missing, so those tests skip.
 */
export async function findRealTools(): Promise<RealTools | undefined> {
  const [ffprobe, mkvpropedit, mkvextract, exiftool] = await Promise.all(
    (['ffprobe', 'mkvpropedit', 'mkvextract', 'exiftool'] as const).map((tool) => resolveBinary(tool)),
  );
  if (ffprobe === undefined || mkvpropedit === undefined || mkvextract === undefined || exiftool === undefined) {
    return undefined;
  }
  const ffmpeg = join(dirname(ffprobe.path), 'ffmpeg.exe');
  return (await exists(ffmpeg)) ? { ffmpeg } : undefined;
}

export const realBackendDeps: BackendDeps = {
  runner: realRunner,
  locate: createToolLocator({}),
};

/** Writes a one second sample video in the container given by the file extension. */
export async function makeSample(tools: RealTools, file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await run(tools.ffmpeg, [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1:size=160x120:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=duration=1',
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    file,
  ]);
}

export async function copyOf(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}
