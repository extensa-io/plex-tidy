import { z } from 'zod';

export const modeSchema = z.enum(['local', 'movies', 'tv']);
export type Mode = z.infer<typeof modeSchema>;

/** Builds a state file schema that carries a fixed `schemaVersion`. */
export function versionedSchema<const Version extends number, Shape extends z.ZodRawShape>(
  version: Version,
  shape: Shape,
) {
  return z.object({ schemaVersion: z.literal(version), ...shape });
}

export const JOURNAL_SCHEMA_VERSION = 1;

export const journalIntentSchema = z.object({
  schemaVersion: z.literal(JOURNAL_SCHEMA_VERSION),
  kind: z.literal('intent'),
  id: z.uuid(),
  at: z.iso.datetime(),
  action: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
});

export const journalDoneSchema = z.object({
  schemaVersion: z.literal(JOURNAL_SCHEMA_VERSION),
  kind: z.literal('done'),
  id: z.uuid(),
  at: z.iso.datetime(),
});

/** Closes an intent that reconciliation found never started, so it stops being reported. */
export const journalVoidSchema = z.object({
  schemaVersion: z.literal(JOURNAL_SCHEMA_VERSION),
  kind: z.literal('void'),
  id: z.uuid(),
  at: z.iso.datetime(),
  reason: z.string().min(1),
});

export const journalRecordSchema = z.discriminatedUnion('kind', [
  journalIntentSchema,
  journalDoneSchema,
  journalVoidSchema,
]);

export type JournalIntent = z.infer<typeof journalIntentSchema>;
export type JournalDone = z.infer<typeof journalDoneSchema>;
export type JournalVoid = z.infer<typeof journalVoidSchema>;
export type JournalRecord = z.infer<typeof journalRecordSchema>;
