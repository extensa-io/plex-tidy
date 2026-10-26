import type { ToolLocator, ToolRunner } from './runner.ts';
import type { SkippedField, TagRecord, TagSnapshot, Writer } from './schemas.ts';

export interface BackendDeps {
  runner: ToolRunner;
  locate: ToolLocator;
}

/**
 * The steps of an ExifTool write. `downloading` brings the original to this machine, `building` is
 * ExifTool writing the tags there, and `uploading` moves the finished copy next to the original.
 */
export type CopyPhase = 'downloading' | 'building' | 'uploading';

export interface WriteOptions {
  /** Called about once a second while a copy is made, with the bytes written and the size expected. */
  onCopyProgress?: (copiedBytes: number, totalBytes: number, phase: CopyPhase) => void;
}

/** A tag writer for one family of containers. */
export interface TagBackend {
  readonly writer: Writer;
  /** The values to write for a record, and the fields this container cannot hold. */
  desired(record: TagRecord): { desired: TagSnapshot; skipped: SkippedField[] };
  /** The file's current title, and the current values of the named fields. */
  read(file: string, fieldNames: readonly string[]): Promise<TagSnapshot>;
  /**
   * Makes the file hold `target` (a null title removes the title, an empty
   * field list removes the field), then reads it back. Throws
   * `TAG_VERIFY_FAILED` when the read-back differs. A failed write never
   * leaves the file without its previous values.
   */
  write(file: string, target: TagSnapshot, options?: WriteOptions): Promise<void>;
}
