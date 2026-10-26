import { z } from 'zod';
import { versionedSchema } from '../state/schemas.ts';
import { movieDetailsSchema } from '../tmdb/schemas.ts';
import { confidenceSchema } from './schemas.ts';

export const MOVIE_RESOLVE_SCHEMA_VERSION = 1;

export const movieParseVias = ['tmdb-id', 'pattern', 'model', 'none'] as const;
export const movieParseOutcomes = ['valid', 'no-result', 'invalid', 'no-answer'] as const;

/** What the `parse` command learned about one file name. */
export const movieParseSchema = z.object({
  via: z.enum(movieParseVias),
  outcome: z.enum(movieParseOutcomes),
  title: z.string().nullable(),
  year: z.number().int().nullable(),
  edition: z.string().nullable(),
  /** A two letter language code, such as `es`. */
  language: z.string().nullable(),
  part: z.string().nullable(),
  /** Set when the name already carries a `{tmdb-<id>}` tag. */
  tmdbId: z.number().int().positive().nullable(),
});
export type MovieParse = z.infer<typeof movieParseSchema>;

/** What ffprobe found in the video. */
export const movieProbeSchema = z.object({
  durationSeconds: z.number().nullable(),
  title: z.string().nullable(),
});
export type MovieProbe = z.infer<typeof movieProbeSchema>;

export const scoredCandidateSchema = z.object({
  details: movieDetailsSchema,
  score: z.number().min(0).max(1),
  reason: z.string().min(1),
});
export type ScoredCandidate = z.infer<typeof scoredCandidateSchema>;

export const movieResolutionVias = ['tmdb-id', 'score', 'judge', 'none'] as const;

/** What the `resolve` command decided for one file. */
export const movieResolutionSchema = z.object({
  /** The TMDB id the entry is renamed for, or null when no candidate was chosen. */
  chosenId: z.number().int().positive().nullable(),
  via: z.enum(movieResolutionVias),
  confidence: confidenceSchema,
  /** The score of the chosen candidate, or null when the id came from the name. */
  score: z.number().min(0).max(1).nullable(),
  reason: z.string().min(1),
});
export type MovieResolution = z.infer<typeof movieResolutionSchema>;

export const movieResolveEntrySchema = z.object({
  id: z.string().min(1),
  parse: movieParseSchema,
  /** Null until the file is probed, or when ffprobe could not read it. */
  probe: movieProbeSchema.nullable(),
  /** The best candidates, best first. */
  candidates: z.array(scoredCandidateSchema),
  resolution: movieResolutionSchema.nullable(),
});
export type MovieResolveEntry = z.infer<typeof movieResolveEntrySchema>;

export const movieResolveFileSchema = versionedSchema(MOVIE_RESOLVE_SCHEMA_VERSION, {
  scanId: z.uuid(),
  entries: z.array(movieResolveEntrySchema),
});
export type MovieResolveFile = z.infer<typeof movieResolveFileSchema>;
