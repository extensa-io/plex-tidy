/** Lowercase words with accents removed, split on anything that is not a letter or digit. */
export function wordsOf(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/** True when every word of `title` appears in `source`, in the same order. Extra source words are fine. */
export function isOrderedSubset(title: string, source: string): boolean {
  const wanted = wordsOf(title);
  if (wanted.length === 0) {
    return false;
  }
  const available = wordsOf(source);
  let position = 0;
  for (const word of wanted) {
    const found = available.indexOf(word, position);
    if (found === -1) {
      return false;
    }
    position = found + 1;
  }
  return true;
}

export type TitleValidation = { valid: true; sourceIndex: number } | { valid: false };

/**
 * A proposed title is valid only when one single source (the file name, or
 * one folder name) holds all of its words in order. Sources are checked in
 * the order given, so the nearest folder wins.
 */
export function validateTitle(title: string, sources: readonly string[]): TitleValidation {
  const sourceIndex = sources.findIndex((source) => isOrderedSubset(title, source));
  return sourceIndex === -1 ? { valid: false } : { valid: true, sourceIndex };
}
