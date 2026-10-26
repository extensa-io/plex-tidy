import { z } from 'zod';

export const toolNameSchema = z.enum(['ffprobe', 'mkvpropedit', 'mkvextract', 'exiftool']);
export type ToolName = z.infer<typeof toolNameSchema>;

/** Parses a tool's version output into the version string captured by `pattern`. */
export function versionOutputSchema(pattern: RegExp) {
  return z.string().transform((output, ctx) => {
    const version = pattern.exec(output)?.[1];
    if (version === undefined) {
      ctx.addIssue('The version output was not recognized.');
      return z.NEVER;
    }
    return version;
  });
}
