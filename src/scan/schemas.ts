import { z } from 'zod';
import { untitledReasons } from '../parse/detector.ts';
import { versionedSchema } from '../state/schemas.ts';

export const videoExtensions = ['.mkv', '.mp4', '.avi', '.mov', '.m4v', '.wmv'] as const;
export const sidecarExtensions = ['.srt', '.ass', '.ssa', '.sub', '.vtt'] as const;

export const SCAN_SCHEMA_VERSION = 1;

export const sidecarSchema = z.object({
  /** Path relative to the root. */
  path: z.string().min(1),
  /** Everything after the video stem, such as `.en.srt`. */
  suffix: z.string().min(1),
});

export const scanFileSchema = z.object({
  id: z.string().min(1),
  /** Path relative to the root, with backslash separators. */
  path: z.string().min(1),
  stem: z.string().min(1),
  /** Extension with its dot, in its original case. */
  ext: z.string().min(1),
  /** Folder names between the root and the file, nearest first. */
  folders: z.array(z.string().min(1)),
  sidecars: z.array(sidecarSchema),
  titled: z.boolean(),
  untitledReason: z.enum(untitledReasons).nullable(),
});

export const scanSchema = versionedSchema(SCAN_SCHEMA_VERSION, {
  scanId: z.uuid(),
  root: z.string().min(1),
  scannedAt: z.iso.datetime(),
  files: z.array(scanFileSchema),
});

export type Sidecar = z.infer<typeof sidecarSchema>;
export type ScanFile = z.infer<typeof scanFileSchema>;
export type Scan = z.infer<typeof scanSchema>;
