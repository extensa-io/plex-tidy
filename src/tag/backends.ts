import { win32 } from 'node:path';
import type { IntentChecker } from '../apply/reconcile.ts';
import type { BackendDeps, TagBackend } from './backend.ts';
import { createExifBackend, type ExifHooks } from './exif.ts';
import { snapshotSatisfies } from './fields.ts';
import { createMkvBackend } from './mkv.ts';
import { TAG_ACTION, UNDO_TAG_ACTION, tagIntentDataSchema, type Writer } from './schemas.ts';

export type Backends = Record<Writer, TagBackend>;

export function createBackends(deps: BackendDeps, exifHooks?: ExifHooks): Backends {
  return { mkvpropedit: createMkvBackend(deps), exiftool: createExifBackend(deps, exifHooks) };
}

/**
 * Checks unfinished `tag` and `undo-tag` intents by reading the file's tags.
 * If the file shows the new values the operation finished; if it shows the
 * previous values it never started. Anything else, or a file that cannot be
 * read, is `unknown`.
 */
export function tagChecker(root: string, backends: Backends): IntentChecker {
  return async (intent) => {
    if (intent.action !== TAG_ACTION && intent.action !== UNDO_TAG_ACTION) {
      return undefined;
    }
    const data = tagIntentDataSchema.safeParse(intent.data);
    if (!data.success) {
      return 'unknown';
    }
    try {
      const names = [...new Set([...Object.keys(data.data.next.fields), ...Object.keys(data.data.previous.fields)])];
      const current = await backends[data.data.writer].read(win32.join(root, data.data.path), names);
      if (snapshotSatisfies(current, data.data.next)) {
        return 'completed';
      }
      return snapshotSatisfies(current, data.data.previous) ? 'not-started' : 'unknown';
    } catch {
      return 'unknown';
    }
  };
}
