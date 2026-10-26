import { applyCasing } from './casing.ts';

export interface CleanerRule {
  /** What the rule removes or changes, so a reader can tell without reading the code. */
  name: string;
  apply: (text: string) => string;
}

const YEAR = /^(?:19|20)\d{2}$/;

// Tokens that mark where a release name stops being a title. Words that are
// also common in titles (web, cam, internal, proper, dual) are left out on purpose.
const releaseTagWords: ReadonlySet<string> = new Set([
  // source
  'bluray',
  'blu-ray',
  'bdrip',
  'brrip',
  'bdremux',
  'remux',
  'webrip',
  'web-rip',
  'webdl',
  'web-dl',
  'hdrip',
  'hdtv',
  'pdtv',
  'dvdrip',
  'dvdscr',
  'dvdr',
  'dvd5',
  'dvd9',
  'bd25',
  'bd50',
  'hdcam',
  'camrip',
  'telesync',
  'hdts',
  'vhsrip',
  'tvrip',
  'satrip',
  // codec
  'x264',
  'x265',
  'h264',
  'h265',
  'hevc',
  'avc',
  'xvid',
  'divx',
  'av1',
  'vp9',
  '10bit',
  '8bit',
  // audio
  'atmos',
  'truehd',
  'dtshd',
  'dts-hd',
  // other
  'hdr',
  'hdr10',
  'hdr10plus',
  'repack',
  'rerip',
]);

const resolutionTag = /^(?:\d{3,4}[pi]|4k|8k|uhd|fhd|qhd)$/;
const audioTag = /^(?:dd|ddp|aac|ac3|eac3|dts|flac|opus|mp3)\+?\d{0,2}$/;

export function isReleaseTag(token: string): boolean {
  const lower = token.toLowerCase();
  if (releaseTagWords.has(lower) || resolutionTag.test(lower) || audioTag.test(lower)) {
    return true;
  }
  // A tag followed by a group name, such as x264-GROUP or DTS-HD.
  const [head = '', ...rest] = lower.split('-');
  return rest.length > 0 && head !== '' && (releaseTagWords.has(head) || resolutionTag.test(head) || audioTag.test(head));
}

function isYear(token: string): boolean {
  return YEAR.test(token);
}

function tokens(text: string): string[] {
  return text.split(/\s+/).filter((token) => token !== '');
}

const squareOrCurlySource = /\[[^[\]]*\]|\{[^{}]*\}/.source;

/** Applied in order. Each rule is small enough to explain in one line. */
export const cleanerRules: readonly CleanerRule[] = [
  {
    name: 'strip-site-prefix',
    apply: (text) =>
      text
        .replace(/^\s*www\.[a-z0-9-]+\.[a-z]{2,}[\s._-]*/i, '')
        .replace(/^\s*[a-z0-9-]+\.(?:com|net|org|info|tv|cc)(?=[\s_-])[\s_-]*/i, ''),
  },
  {
    name: 'strip-square-and-curly-bracket-segments',
    apply: (text) => {
      // Nested brackets need more than one pass.
      let current = text;
      for (let pass = 0; pass < 5; pass += 1) {
        const next = current.replace(new RegExp(squareOrCurlySource, 'g'), ' ');
        if (next === current) {
          break;
        }
        current = next;
      }
      return current;
    },
  },
  {
    name: 'strip-parenthesized-year-or-release-tag',
    apply: (text) =>
      text.replace(/\(([^()]*)\)/g, (whole, inner: string) => {
        const parts = tokens(inner.replace(/[._]+/g, ' '));
        const removable = parts.every((part) => isYear(part) || isReleaseTag(part));
        return removable ? ' ' : whole;
      }),
  },
  {
    name: 'join-codec-dots',
    apply: (text) => text.replace(/\b([hx])[. ]?(26[45])\b/gi, '$1$2'),
  },
  {
    name: 'dots-and-underscores-to-spaces',
    apply: (text) => text.replace(/[._]+/g, ' '),
  },
  {
    name: 'collapse-whitespace-before-tokens',
    apply: (text) => tokens(text).join(' '),
  },
  {
    name: 'cut-at-first-release-tag',
    apply: (text) => {
      const words = tokens(text);
      const cut = words.findIndex(
        (word, index) => index > 0 && isReleaseTag(word) && words.slice(0, index).some((before) => !isYear(before)),
      );
      return (cut === -1 ? words : words.slice(0, cut)).join(' ');
    },
  },
  {
    name: 'remove-remaining-release-tags',
    apply: (text) =>
      tokens(text)
        .filter((word) => !isReleaseTag(word))
        .join(' '),
  },
  {
    name: 'remove-years-1900-to-2099',
    apply: (text) =>
      tokens(text)
        .filter((word) => !isYear(word))
        .join(' '),
  },
  {
    name: 'remove-stray-brackets',
    apply: (text) => text.replace(/[[\]{}]/g, ' '),
  },
  {
    name: 'trim-edge-punctuation',
    apply: (text) => tokens(text).join(' ').replace(/^[\s\-–—,;:]+|[\s\-–—,;:]+$/g, ''),
  },
  {
    name: 'title-case-uniform-casing',
    apply: (text) => applyCasing(text),
  },
];

const MAX_PASSES = 6;

/**
 * Cleans one name (a file stem or a folder name) with the rule list. The list
 * runs again on its own output until nothing changes, so the result is a fixed point.
 */
export function cleanText(text: string): string {
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = cleanerRules.reduce((value, rule) => rule.apply(value), current);
    if (next === current) {
      return next;
    }
    current = next;
  }
  return current;
}
