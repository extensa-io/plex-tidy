import { z } from 'zod';
import { versionedSchema } from '../state/schemas.ts';

export const titleKindSchema = z.enum(['filename', 'folders']);
export type TitleKind = z.infer<typeof titleKindSchema>;

/** What the model must return through the forced tool call. One nullable `title` per item. */
export const titleToolInputSchema = z.object({
  results: z.array(
    z.object({
      id: z.number().int().min(0),
      title: z.string().nullable(),
    }),
  ),
});
export type TitleToolInput = z.infer<typeof titleToolInputSchema>;

export const PARSE_CACHE_SCHEMA_VERSION = 1;

/**
 * One cached answer. Videos mode stores only `title`. Movies mode also stores
 * the other fields it parses, so the shared file keeps them when videos mode
 * saves it.
 */
export const parseCacheEntrySchema = z.object({
  title: z.string().nullable(),
  year: z.number().int().nullable().optional(),
  edition: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  part: z.string().nullable().optional(),
});
export type ParseCacheEntry = z.infer<typeof parseCacheEntrySchema>;

export const parseCacheSchema = versionedSchema(PARSE_CACHE_SCHEMA_VERSION, {
  entries: z.record(z.string(), parseCacheEntrySchema),
});
export type ParseCacheFile = z.infer<typeof parseCacheSchema>;
