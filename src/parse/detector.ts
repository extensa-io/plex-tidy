import { cleanText } from './cleaner.ts';

export const untitledReasons = ['empty', 'mostly-digits', 'camera-prefix', 'generic-words'] as const;
export type UntitledReason = (typeof untitledReasons)[number];

export type TitleDetection = { titled: true } | { titled: false; reason: UntitledReason };

// Prefixes that cameras, phones, and capture tools put on file names.
const cameraToken = /^(?:vid|img|mov|mvi|dsc|dscn|dscf|pxl|gopr|wp|cam)\d*$/i;

// Words that name a kind of file and say nothing about its content.
const genericWords: ReadonlySet<string> = new Set([
  'capture',
  'clip',
  'copy',
  'file',
  'film',
  'final',
  'footage',
  'movie',
  'new',
  'record',
  'recording',
  'screen',
  'screenrecording',
  'temp',
  'test',
  'tmp',
  'unknown',
  'untitled',
  'video',
]);

const DIGIT_SHARE_LIMIT = 0.5;

/**
 * Decides whether a base filename (no extension) contains a title. The rules
 * run in order and the first match wins.
 */
export function detectTitle(stem: string): TitleDetection {
  const cleaned = cleanText(stem);
  if (cleaned === '') {
    return { titled: false, reason: 'empty' };
  }

  const alphanumeric = cleaned.match(/[\p{L}\p{N}]/gu) ?? [];
  const digits = cleaned.match(/\p{N}/gu) ?? [];
  if (alphanumeric.length > 0 && digits.length / alphanumeric.length > DIGIT_SHARE_LIMIT) {
    return { titled: false, reason: 'mostly-digits' };
  }

  const words = cleaned.split(/[\s-]+/).filter((word) => word !== '');
  const hasCameraToken = words.some((word) => cameraToken.test(word));
  const onlyNoise = words.every(
    (word) => /^\d+$/.test(word) || cameraToken.test(word) || genericWords.has(word.toLowerCase()),
  );
  if (onlyNoise) {
    return { titled: false, reason: hasCameraToken ? 'camera-prefix' : 'generic-words' };
  }
  return { titled: true };
}
