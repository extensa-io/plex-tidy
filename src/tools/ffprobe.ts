import { z } from 'zod';
import { AppError } from '../errors.ts';
import { runTool, type RunToolOptions } from './run.ts';

export interface MediaTrack {
  index: number;
  type: string;
  codec: string | null;
  language: string | null;
}

export interface MediaProbe {
  durationSeconds: number | null;
  /** The container title tag, if any. */
  title: string | null;
  tracks: MediaTrack[];
}

const tagsSchema = z.record(z.string(), z.unknown());

// Every field is optional and unknown fields are ignored, because ffprobe
// output differs between containers and versions.
const ffprobeJsonSchema = z.object({
  format: z
    .object({
      duration: z.union([z.string(), z.number()]).optional(),
      tags: tagsSchema.optional(),
    })
    .optional(),
  streams: z
    .array(
      z.object({
        index: z.number().int().optional(),
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        tags: tagsSchema.optional(),
      }),
    )
    .optional(),
});

/** Reads a tag value without regard to the case of its key. Container tags come as TITLE, Title, or title. */
export function tagValue(tags: Record<string, unknown> | undefined, name: string): string | null {
  if (tags === undefined) {
    return null;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(tags)) {
    if (key.toLowerCase() === wanted && typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }
  return null;
}

function toProbe(raw: z.infer<typeof ffprobeJsonSchema>): MediaProbe {
  const duration = raw.format?.duration === undefined ? Number.NaN : Number(raw.format.duration);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : null,
    title: tagValue(raw.format?.tags, 'title'),
    tracks: (raw.streams ?? []).map((stream, position) => ({
      index: stream.index ?? position,
      type: stream.codec_type ?? 'unknown',
      codec: stream.codec_name ?? null,
      language: tagValue(stream.tags, 'language'),
    })),
  };
}

/** Turns ffprobe's JSON text into a `MediaProbe`. Throws a ZodError-free issue message on bad input. */
export const ffprobeOutputSchema = z.string().transform((text, ctx): MediaProbe => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    ctx.addIssue('ffprobe did not return JSON.');
    return z.NEVER;
  }
  const parsed = ffprobeJsonSchema.safeParse(json);
  if (!parsed.success) {
    ctx.addIssue('ffprobe returned JSON in an unexpected shape.');
    return z.NEVER;
  }
  return toProbe(parsed.data);
});

/** Reads ffprobe's output text. A bad shape is an `AppError`, never a raw parse error. */
export function parseProbe(text: string): MediaProbe {
  const result = ffprobeOutputSchema.safeParse(text);
  if (!result.success) {
    throw new AppError('TOOL_OUTPUT_INVALID', 'ffprobe returned output that could not be read.', { cause: result.error });
  }
  return result.data;
}

export function ffprobeArgs(file: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file];
}

export async function probeMedia(ffprobe: string, file: string, options: RunToolOptions = {}): Promise<MediaProbe> {
  return runTool(ffprobe, ffprobeArgs(file), ffprobeOutputSchema, options);
}
