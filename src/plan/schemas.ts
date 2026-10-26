import { z } from 'zod';
import { confidenceSchema, titleSourceSchema } from '../resolve/schemas.ts';
import { versionedSchema } from '../state/schemas.ts';
import { tagRecordSchema } from '../tag/schemas.ts';

export const PLAN_SCHEMA_VERSION = 1;

export const planStatuses = ['pending', 'approved', 'rejected', 'skipped', 'applied', 'failed'] as const;
export const planStatusSchema = z.enum(planStatuses);
export type PlanStatus = z.infer<typeof planStatusSchema>;

export const tagStatusSchema = z.enum(['untagged', 'tagged', 'tag-skipped', 'tag-failed']);

export const sidecarRenameSchema = z.object({
  /** Paths are relative to the root. */
  source: z.string().min(1),
  target: z.string().min(1),
});

/** A folder renamed together with the video. Paths are relative to the root. */
export const folderRenameSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
});

export const planEntrySchema = z.object({
  id: z.string().min(1),
  /** Video path relative to the root, before any rename. */
  source: z.string().min(1),
  /** Video path relative to the root after every rename, including the folder rename. */
  target: z.string().min(1),
  sidecars: z.array(sidecarRenameSchema),
  /** The folder that apply renames after the files inside it. Only movies and TV use it. */
  folder: folderRenameSchema.nullable().default(null),
  /** What `tag` writes into the file. When null, `tag` writes only the title. */
  tagRecord: tagRecordSchema.nullable().default(null),
  title: z.string().nullable(),
  titleSource: titleSourceSchema,
  confidence: confidenceSchema,
  reason: z.string().min(1),
  status: planStatusSchema,
  tagStatus: tagStatusSchema,
  /** Why the file was not tagged: the container is rename-only, or the write failed. */
  tagReason: z.string().nullable().default(null),
  /** True when the name collides with another file in the folder or with an existing file. */
  collision: z.boolean(),
});

export const planSchema = versionedSchema(PLAN_SCHEMA_VERSION, {
  scanId: z.uuid(),
  root: z.string().min(1),
  builtAt: z.iso.datetime(),
  entries: z.array(planEntrySchema),
});

export type SidecarRename = z.infer<typeof sidecarRenameSchema>;
export type PlanEntry = z.infer<typeof planEntrySchema>;
export type Plan = z.infer<typeof planSchema>;
