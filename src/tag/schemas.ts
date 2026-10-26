import { z } from 'zod';

/**
 * What a file should say about itself. Only `title` is required. Videos mode
 * fills only `title`; movies and TV fill the rest in later phases.
 */
export const tagRecordSchema = z.object({
  title: z.string().trim().min(1),
  originalTitle: z.string().trim().min(1).optional(),
  dateReleased: z.string().trim().min(1).optional(),
  synopsis: z.string().trim().min(1).optional(),
  genre: z.array(z.string().trim().min(1)).min(1).optional(),
  director: z.array(z.string().trim().min(1)).min(1).optional(),
  actor: z.array(z.string().trim().min(1)).min(1).optional(),
  /** A TMDB reference such as `movie/603`. */
  tmdb: z.string().trim().min(1).optional(),
  show: z.string().trim().min(1).optional(),
  season: z.number().int().min(0).optional(),
  episode: z.number().int().min(0).optional(),
  airDate: z.string().trim().min(1).optional(),
});
export type TagRecord = z.infer<typeof tagRecordSchema>;
export type TagField = keyof TagRecord;

export const writerSchema = z.enum(['mkvpropedit', 'exiftool']);
export type Writer = z.infer<typeof writerSchema>;

/**
 * The tag values of one file that the tool touches: the title, and the
 * container-native fields it sets. A field with an empty list is not present.
 */
export const tagSnapshotSchema = z.object({
  title: z.string().nullable(),
  fields: z.record(z.string(), z.array(z.string())),
});
export type TagSnapshot = z.infer<typeof tagSnapshotSchema>;

/** Journal data for a tag operation. Carries the previous values so `undo` can restore them. */
export const tagIntentDataSchema = z.object({
  entryId: z.string().min(1),
  /** Path relative to the root, as it was when the file was tagged. */
  path: z.string().min(1),
  writer: writerSchema,
  previous: tagSnapshotSchema,
  next: tagSnapshotSchema,
});
export type TagIntentData = z.infer<typeof tagIntentDataSchema>;

export const undoTagIntentDataSchema = tagIntentDataSchema.extend({
  /** The id of the journal intent that this undo reverses. */
  undoes: z.uuid(),
});

export const TAG_ACTION = 'tag';
export const UNDO_TAG_ACTION = 'undo-tag';

export interface SkippedField {
  field: TagField;
  reason: string;
}
