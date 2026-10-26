import { randomBytes } from 'node:crypto';
import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import { ffprobeArgs, parseProbe } from '../tools/ffprobe.ts';
import type { BackendDeps, CopyPhase, TagBackend } from './backend.ts';
import { copyWithProgress } from './copy.ts';
import { ITEM_LIST_TITLE, itemListDesired, snapshotSatisfies } from './fields.ts';
import { ensureFreeSpace, freeBytes, type FreeBytes } from './space.ts';
import type { TagSnapshot } from './schemas.ts';

const COPY_TIMEOUT_MS = 30 * 60 * 1000;

/** Hooks that tests replace to watch the order of events or to force a failure. */
export interface ExifHooks {
  /** Checks the finished copy. Throws when it is wrong. Runs before the original is replaced. */
  verify?: (copy: string, target: TagSnapshot) => Promise<void>;
  /** Replaces the original with the verified copy. */
  replace?: (copy: string, original: string) => Promise<void>;
  freeBytes?: FreeBytes;
  /** Where the new copy is built. The default is the system temporary folder. */
  tempDir?: string;
}

const exifJsonSchema = z.string().transform((text, ctx) => {
  try {
    const parsed: unknown = JSON.parse(text);
    return z.array(z.record(z.string(), z.unknown())).parse(parsed)[0] ?? {};
  } catch {
    ctx.addIssue('ExifTool did not return the expected JSON.');
    return z.NEVER;
  }
});

function asList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items
    .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
    .map((item) => String(item).trim())
    .filter((item) => item !== '');
}

/**
 * MP4, M4V, and MOV files. ExifTool writes a modified copy next to the file.
 * The copy is checked, and only then does it replace the original.
 */
export function createExifBackend(deps: BackendDeps, hooks: ExifHooks = {}): TagBackend {
  const { runner, locate } = deps;

  /** Runs ExifTool with its arguments in a UTF-8 arg file, so names and values keep their accents. */
  const exiftool = async (lines: readonly string[], timeoutMs?: number): Promise<string> => {
    const binary = await locate('exiftool');
    const dir = await mkdtemp(join(tmpdir(), 'plex-tidy-exif-'));
    try {
      const argFile = join(dir, 'args.txt');
      await writeFile(argFile, `${lines.join('\n')}\n`, 'utf8');
      return await runner.run(binary, ['-@', argFile], timeoutMs === undefined ? {} : { timeoutMs });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  const read = async (file: string, fieldNames: readonly string[]): Promise<TagSnapshot> => {
    const probe = parseProbe(await runner.run(await locate('ffprobe'), ffprobeArgs(file)));
    const fields: Record<string, string[]> = {};
    if (fieldNames.length > 0) {
      const output = await exiftool([
        '-charset',
        'utf8',
        '-charset',
        'filename=utf8',
        '-json',
        '-G1',
        ...fieldNames.map((name) => `-${name}`),
        file,
      ]);
      const parsed = exifJsonSchema.safeParse(output);
      if (!parsed.success) {
        throw new AppError('TOOL_OUTPUT_INVALID', 'exiftool returned output that could not be read.', { cause: parsed.error });
      }
      for (const name of fieldNames) {
        fields[name] = asList(parsed.data[name]);
      }
    }
    return { title: probe.title, fields };
  };

  const defaultVerify = async (copy: string, target: TagSnapshot): Promise<void> => {
    const copyValues = await read(copy, Object.keys(target.fields));
    if (!snapshotSatisfies(copyValues, target)) {
      throw new AppError('TAG_VERIFY_FAILED', 'The tags read back from the copy did not match what was written.');
    }
  };

  return {
    writer: 'exiftool',
    desired: itemListDesired,
    read,
    async write(file, target, writeOptions = {}) {
      const verify = hooks.verify ?? defaultVerify;
      const replace = hooks.replace ?? ((copy: string, original: string) => rename(copy, original));
      const free = hooks.freeBytes ?? freeBytes;

      const size = (await stat(file)).size;
      // Room for the finished copy next to the original, on the volume that holds it.
      await ensureFreeSpace(dirname(file), size, free);

      // ExifTool reads and writes in tiny blocks, so on a network drive every block waits for the
      // network. Measured on the owner's network: 5 MB/s writing, and about 5 MB/s reading whenever
      // the network was busy, against 40 to 90 MB/s for a plain big-block copy at the same moments.
      // So ExifTool never touches the share. The original is downloaded in big blocks, tagged on this
      // machine, and the finished copy is uploaded in big blocks.
      const workDir = await mkdtemp(join(hooks.tempDir ?? tmpdir(), `plex-tidy-copy-${process.pid}-`));
      const local = join(workDir, `copy${extname(file)}`);
      const upload = join(dirname(file), `.${basename(file)}.${randomBytes(4).toString('hex')}.plex-tidy-tag.tmp`);
      const report = (phase: CopyPhase) => (copied: number, total: number) => writeOptions.onCopyProgress?.(copied, total, phase);
      const assignments = [
        `-${ITEM_LIST_TITLE}=${target.title ?? ''}`,
        ...Object.entries(target.fields).map(([name, values]) => `-${name}=${values.join(', ')}`),
      ];

      try {
        // ExifTool rewrites the downloaded copy through a second file, so this machine needs room for two.
        await ensureFreeSpace(workDir, size * 2, free);

        await copyWithProgress(file, local, report('downloading'));
        if ((await stat(local)).size !== size) {
          throw new AppError('TAG_VERIFY_FAILED', 'The downloaded copy has a different size than the original. The file may have changed.');
        }

        // The original is not involved from here on. ExifTool changes only the downloaded copy.
        report('building')(0, size);
        await exiftool(['-charset', 'utf8', '-charset', 'filename=utf8', '-overwrite_original', ...assignments, local], COPY_TIMEOUT_MS);
        // Check it here first, so a bad copy is found before it is uploaded.
        await verify(local, target);

        await copyWithProgress(local, upload, report('uploading'));
        if ((await stat(upload)).size !== (await stat(local)).size) {
          throw new AppError('TAG_VERIFY_FAILED', 'The uploaded copy has a different size than the copy that was built.');
        }
        await verify(upload, target);
        await replace(upload, file);
      } catch (error) {
        // Only copies this call made are removed. The original is never touched before this point.
        await rm(upload, { force: true });
        throw error;
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}
