import type { TitleModel } from '../llm/model-client.ts';
import { proposeTitles, type ParseCache, type ParseStats, type TitleInput } from '../llm/title-parser.ts';
import type { ParseResult, ResolveEntry } from '../resolve/schemas.ts';
import type { Scan, ScanFile } from '../scan/schemas.ts';
import { validateTitle } from './validator.ts';

/** Folder names sent to the model for one file with no title, nearest first. */
export const MAX_FOLDER_SOURCES = 5;

/** The text a title can come from: the file name for a titled file, folder names otherwise. */
export function sourcesFor(file: ScanFile): string[] {
  return file.titled ? [file.stem] : file.folders.slice(0, MAX_FOLDER_SOURCES);
}

export interface ParseVideosOptions {
  model: TitleModel;
  cache: ParseCache;
  batchSize: number;
  onBatch?: (done: number, total: number) => void;
}

export interface ParseVideosOutput {
  entries: ResolveEntry[];
  stats: ParseStats;
  outcomes: Record<ParseResult['outcome'], number>;
}

/**
 * Asks the model for a title per file. A titled file sends only its base
 * filename. A file with no title sends its folder names. Nothing else is sent.
 */
export async function parseVideos(scan: Scan, options: ParseVideosOptions): Promise<ParseVideosOutput> {
  const inputs: TitleInput[] = [];
  for (const file of scan.files) {
    const sources = sourcesFor(file);
    if (sources.length > 0) {
      inputs.push({ key: file.id, kind: file.titled ? 'filename' : 'folders', sources });
    }
  }

  const { answers, stats } = await proposeTitles(inputs, options);

  const outcomes: ParseVideosOutput['outcomes'] = { valid: 0, invalid: 0, 'no-result': 0, 'no-source': 0 };
  const entries = scan.files.map((file): ResolveEntry => {
    const parse = parseResultFor(file, answers.get(file.id));
    outcomes[parse.outcome] += 1;
    return { id: file.id, parse, resolution: null };
  });
  return { entries, stats, outcomes };
}

function parseResultFor(file: ScanFile, answer: string | null | undefined): ParseResult {
  const kind = file.titled ? 'filename' : 'folders';
  const sources = sourcesFor(file);
  if (sources.length === 0) {
    return { kind, outcome: 'no-source', title: null, sourceIndex: null };
  }
  const title = answer?.trim();
  if (title === undefined || title === '') {
    return { kind, outcome: 'no-result', title: null, sourceIndex: null };
  }
  const validation = validateTitle(title, sources);
  return validation.valid
    ? { kind, outcome: 'valid', title, sourceIndex: validation.sourceIndex }
    : { kind, outcome: 'invalid', title: null, sourceIndex: null };
}
