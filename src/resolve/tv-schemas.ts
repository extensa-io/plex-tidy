import { z } from 'zod';
import { versionedSchema } from '../state/schemas.ts';
import { showDetailsSchema } from '../tmdb/schemas.ts';
import { confidenceSchema } from './schemas.ts';

export const TV_RESOLVE_SCHEMA_VERSION = 1;

export const tvParseVias = ['rules', 'model', 'none'] as const;
export const tvParseOutcomes = ['valid', 'no-result', 'invalid', 'no-answer'] as const;

/** What the `parse` command learned about one episode file name. */
export const tvParseSchema = z.object({
  via: z.enum(tvParseVias),
  outcome: z.enum(tvParseOutcomes),
  /** The name of the rule that read the file name, or null. */
  rule: z.string().nullable(),
  /** The show named in the file name. The show folder is used first. */
  show: z.string().nullable(),
  year: z.number().int().nullable(),
  season: z.number().int().min(0).nullable(),
  episode: z.number().int().min(0).nullable(),
  /** The last episode when one file holds several. */
  episodeEnd: z.number().int().min(0).nullable(),
  episodeTitle: z.string().nullable(),
});
export type TvParse = z.infer<typeof tvParseSchema>;

export const tvShowCandidateSchema = z.object({
  details: showDetailsSchema,
  score: z.number().min(0).max(1),
  reason: z.string().min(1),
});
export type TvShowCandidate = z.infer<typeof tvShowCandidateSchema>;

export const tvShowVias = ['tmdb-id', 'score', 'judge', 'manual', 'none'] as const;

export const tvShowResolutionSchema = z.object({
  chosenId: z.number().int().positive().nullable(),
  via: z.enum(tvShowVias),
  confidence: confidenceSchema,
  score: z.number().min(0).max(1).nullable(),
  reason: z.string().min(1),
});
export type TvShowResolution = z.infer<typeof tvShowResolutionSchema>;

/** One show as the library has it: the episodes that share a show folder. Resolved once for all of them. */
export const tvShowGroupSchema = z.object({
  /** The show folder path, lowercase, or an empty string for files directly in the root. */
  key: z.string(),
  /** The show folder path relative to the root, with its original case. Empty for files directly in the root. */
  dir: z.string(),
  /** The show title read from the folder name, or from the file names when there is no folder. */
  query: z.string().nullable(),
  year: z.number().int().nullable(),
  /** An id written in the folder name as `{tmdb-<id>}`. */
  tmdbId: z.number().int().positive().nullable(),
  /** The ids of the episode files in the group. */
  fileIds: z.array(z.string()),
  candidates: z.array(tvShowCandidateSchema),
  resolution: tvShowResolutionSchema.nullable(),
});
export type TvShowGroup = z.infer<typeof tvShowGroupSchema>;

/** The season and episode numbers typed in review. They replace what the name says. */
export const tvManualSchema = z.object({
  season: z.number().int().min(0),
  episode: z.number().int().min(0),
  episodeEnd: z.number().int().min(0).nullable(),
});
export type TvManual = z.infer<typeof tvManualSchema>;

export const seasonSources = ['name', 'folder', 'assumed', 'manual'] as const;

/** What the `resolve` command decided for one episode file, once its show is known. */
export const tvEpisodeResolutionSchema = z.object({
  season: z.number().int().min(0).nullable(),
  episode: z.number().int().min(0).nullable(),
  episodeEnd: z.number().int().min(0).nullable(),
  /** Where the season number came from. `assumed` means the name had none and season 1 was taken. */
  seasonSource: z.enum(seasonSources),
  /** The file name and the `Season N` folder name different seasons. */
  conflict: z.boolean(),
  /** True when TMDB lists every episode number of the file. */
  found: z.boolean(),
  /** The TMDB titles of the episodes, in order. Empty when not found. */
  titles: z.array(z.string()),
  /** The air date and the plot of the first episode. */
  airDate: z.string().nullable(),
  overview: z.string(),
  /** Why the episode needs a look, or a note on how it was matched. */
  reason: z.string().min(1),
});
export type TvEpisodeResolution = z.infer<typeof tvEpisodeResolutionSchema>;

export const tvResolveEntrySchema = z.object({
  id: z.string().min(1),
  /** The key of the show group the file belongs to. */
  groupKey: z.string(),
  parse: tvParseSchema,
  manual: tvManualSchema.nullable().default(null),
  episode: tvEpisodeResolutionSchema.nullable().default(null),
});
export type TvResolveEntry = z.infer<typeof tvResolveEntrySchema>;

export const tvResolveFileSchema = versionedSchema(TV_RESOLVE_SCHEMA_VERSION, {
  scanId: z.uuid(),
  shows: z.array(tvShowGroupSchema),
  entries: z.array(tvResolveEntrySchema),
});
export type TvResolveFile = z.infer<typeof tvResolveFileSchema>;
