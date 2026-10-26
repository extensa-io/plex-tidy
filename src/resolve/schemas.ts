import { z } from 'zod';
import { titleKindSchema } from '../llm/schemas.ts';
import { versionedSchema } from '../state/schemas.ts';

export const RESOLVE_SCHEMA_VERSION = 1;

export const parseOutcomes = ['valid', 'invalid', 'no-result', 'no-source'] as const;

/** What the `parse` command learned about one file. */
export const parseResultSchema = z.object({
  kind: titleKindSchema,
  outcome: z.enum(parseOutcomes),
  /** The model's title. Set only when `outcome` is `valid`. */
  title: z.string().nullable(),
  /** Which source held the title: always 0 for a file name, the folder position otherwise. */
  sourceIndex: z.number().int().min(0).nullable(),
});

export const confidenceSchema = z.enum(['high', 'low']);
export const titleSourceSchema = z.enum(['filename', 'folder', 'rules-only', 'manual', 'none']);

/** What the `resolve` command decided for one file. */
export const resolutionSchema = z.object({
  title: z.string().nullable(),
  source: titleSourceSchema,
  confidence: confidenceSchema,
  reason: z.string().min(1),
});

export const resolveEntrySchema = z.object({
  id: z.string().min(1),
  parse: parseResultSchema,
  resolution: resolutionSchema.nullable(),
});

export const resolveFileSchema = versionedSchema(RESOLVE_SCHEMA_VERSION, {
  scanId: z.uuid(),
  entries: z.array(resolveEntrySchema),
});

export type ParseResult = z.infer<typeof parseResultSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type TitleSource = z.infer<typeof titleSourceSchema>;
export type Resolution = z.infer<typeof resolutionSchema>;
export type ResolveEntry = z.infer<typeof resolveEntrySchema>;
export type ResolveFile = z.infer<typeof resolveFileSchema>;
