import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../errors.ts';
import { ffprobeArgs, parseProbe } from '../tools/ffprobe.ts';
import type { BackendDeps, TagBackend } from './backend.ts';
import { mkvDesired, snapshotSatisfies } from './fields.ts';
import { buildTagsXml, globalValues, mergeGlobalTags, parseTagsXml } from './matroska-tags.ts';
import type { TagSnapshot } from './schemas.ts';

const EDIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Matroska files. `mkvpropedit` edits the header in place: the segment title,
 * and the global tag block for every other field. The global block is merged
 * with the tags already in the file, because `--tags global:` replaces them all.
 */
export function createMkvBackend(deps: BackendDeps): TagBackend {
  const { runner, locate } = deps;

  const read = async (file: string, fieldNames: readonly string[]): Promise<TagSnapshot> => {
    const probe = parseProbe(await runner.run(await locate('ffprobe'), ffprobeArgs(file)));
    const fields: Record<string, string[]> = {};
    if (fieldNames.length > 0) {
      const xml = await runner.run(await locate('mkvextract'), ['tags', file]);
      Object.assign(fields, globalValues(parseTagsXml(xml), fieldNames));
    }
    return { title: probe.title, fields };
  };

  /** Runs one mkvpropedit call that sets the title and merges the fields. No verification. */
  const apply = async (file: string, current: TagSnapshot, target: TagSnapshot): Promise<void> => {
    const args = [file];
    if ((current.title ?? null) !== (target.title ?? null)) {
      args.push('--edit', 'info', ...(target.title === null ? ['--delete', 'title'] : ['--set', `title=${target.title}`]));
    }

    const names = Object.keys(target.fields);
    const tempDir = names.length > 0 ? await mkdtemp(join(tmpdir(), 'plex-tidy-tags-')) : undefined;
    try {
      if (tempDir !== undefined) {
        const existing = parseTagsXml(await runner.run(await locate('mkvextract'), ['tags', file]));
        const merged = mergeGlobalTags(existing, target.fields);
        if (merged.length === 0) {
          args.push('--tags', 'global:');
        } else {
          const xmlFile = join(tempDir, 'tags.xml');
          await writeFile(xmlFile, buildTagsXml(merged), 'utf8');
          args.push('--tags', `global:${xmlFile}`);
        }
      }
      if (args.length > 1) {
        await runner.run(await locate('mkvpropedit'), args, { timeoutMs: EDIT_TIMEOUT_MS });
      }
    } finally {
      if (tempDir !== undefined) {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  };

  return {
    writer: 'mkvpropedit',
    desired: mkvDesired,
    read,
    async write(file, target) {
      const names = Object.keys(target.fields);
      const before = await read(file, names);
      await apply(file, before, target);

      const after = await read(file, names);
      if (!snapshotSatisfies(after, target)) {
        // The edit was in place, so put the previous values back before reporting.
        await apply(file, after, before).catch(() => undefined);
        throw new AppError('TAG_VERIFY_FAILED', 'The tags read back from the file did not match what was written.');
      }
    },
  };
}
