// Words kept in lower case inside a title, English and Spanish. The owner reviews this list.
// A Spanish word stays off the list when it is also a common English word: "sin" is one.
export const smallWords: ReadonlySet<string> = new Set([
  // English
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'in',
  'nor',
  'of',
  'on',
  'or',
  'so',
  'the',
  'to',
  'up',
  'vs',
  'yet',
  // Spanish
  'al',
  'con',
  'de',
  'del',
  'e',
  'el',
  'en',
  'la',
  'las',
  'los',
  'o',
  'para',
  'por',
  'que',
  'u',
  'un',
  'una',
  'unas',
  'unos',
  'y',
]);

/**
 * Applies Title Case only when the text is entirely lowercase or entirely
 * uppercase. Text with mixed case keeps its original casing.
 */
export function applyCasing(text: string): string {
  const hasLetters = text.toLowerCase() !== text.toUpperCase();
  if (!hasLetters || (text !== text.toLowerCase() && text !== text.toUpperCase())) {
    return text;
  }

  // Splitting on whitespace and hyphens keeps both separators in the result.
  const parts = text.split(/(\s+|-)/);
  const wordIndexes = parts.flatMap((part, index) => (/^(?:\s+|-)$/.test(part) || part === '' ? [] : [index]));
  const first = wordIndexes[0];
  const last = wordIndexes[wordIndexes.length - 1];

  return parts
    .map((part, index) => {
      if (!wordIndexes.includes(index)) {
        return part;
      }
      const lower = part.toLowerCase();
      if (index !== first && index !== last && smallWords.has(lower)) {
        return lower;
      }
      return capitalize(lower);
    })
    .join('');
}

function capitalize(word: string): string {
  const [firstCharacter = ''] = word;
  return firstCharacter.toUpperCase() + word.slice(firstCharacter.length);
}
