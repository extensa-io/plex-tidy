import { sanitizeName } from '../fs-win/sanitize.ts';
import { applyCasing } from '../parse/casing.ts';
import { cleanText } from '../parse/cleaner.ts';
import { sourcesFor } from '../parse/videos.ts';
import type { ScanFile } from '../scan/schemas.ts';
import type { ParseResult, Resolution } from './schemas.ts';

/** Casing rule, then Windows-safe characters. An empty result means "no usable title". */
export function finalizeTitle(title: string): string {
  return sanitizeName(applyCasing(title.replace(/\s+/g, ' ').trim()));
}

/** True when the text has letters and they are all lowercase or all uppercase. */
function hasUniformCase(text: string): boolean {
  return text.toLowerCase() !== text.toUpperCase() && (text === text.toLowerCase() || text === text.toUpperCase());
}

/**
 * A title from the model. Dots and underscores become spaces, because models
 * keep the separators of the name. When the name it came from has one case
 * throughout, the title gets Title Case, as the casing rule asks.
 */
export function finalizeModelTitle(title: string, sourceText: string): string {
  const spaced = title.replace(/[._]+/g, ' ');
  return finalizeTitle(hasUniformCase(sourceText) ? spaced.toLowerCase() : spaced);
}

const fallbackReasons: Record<Exclude<ParseResult['outcome'], 'valid'>, string> = {
  'no-result': 'the model gave no usable result; rules-only cleaner used',
  invalid: 'the model title failed the word check; rules-only cleaner used',
  'no-source': 'no folder to read; rules-only cleaner used',
};

/**
 * The videos provider. The title comes from the file name first, then from a
 * folder. When the model gave nothing usable, the rules-only cleaner runs on
 * the same source text and the entry is marked low confidence.
 */
export function resolveVideos(file: ScanFile, parse: ParseResult): Resolution {
  if (parse.outcome === 'valid' && parse.title !== null) {
    const sourceText = sourcesFor(file)[parse.sourceIndex ?? 0] ?? '';
    const title = finalizeModelTitle(parse.title, sourceText);
    if (title !== '') {
      const source = file.titled ? 'filename' : 'folder';
      return {
        title,
        source,
        confidence: 'high',
        reason: file.titled ? 'title from the file name, confirmed by the word check' : 'title from a folder name, confirmed by the word check',
      };
    }
  }

  const reason = parse.outcome === 'valid' ? fallbackReasons['no-result'] : fallbackReasons[parse.outcome];
  for (const source of sourcesFor(file)) {
    const title = finalizeTitle(cleanText(source));
    if (title !== '') {
      return { title, source: 'rules-only', confidence: 'low', reason };
    }
  }
  return { title: null, source: 'none', confidence: 'low', reason: 'no title could be found' };
}
