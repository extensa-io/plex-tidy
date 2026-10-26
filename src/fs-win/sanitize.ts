interface NameRule {
  name: string;
  apply: (value: string) => string;
}

// Windows reserves these device names with or without an extension.
const reservedDeviceNames = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].flatMap((digit) => [`COM${digit}`, `LPT${digit}`]),
]);

/** Applied in order. Each rule removes or replaces one kind of character Windows refuses in a name. */
export const sanitizeRules: readonly NameRule[] = [
  {
    name: 'remove-control-characters',
    // eslint-disable-next-line no-control-regex
    apply: (value) => value.replace(/[\u0000-\u001f]/g, ''),
  },
  {
    name: 'remove-angle-brackets-quote-question-asterisk',
    apply: (value) => value.replace(/[<>"?*]/g, ''),
  },
  {
    name: 'colon-to-space-dash',
    apply: (value) => value.replace(/:/g, ' -'),
  },
  {
    name: 'slashes-and-pipe-to-dash',
    apply: (value) => value.replace(/[/\\|]/g, '-'),
  },
  {
    name: 'collapse-whitespace',
    apply: (value) => value.replace(/\s+/g, ' ').trim(),
  },
  {
    name: 'trim-trailing-dots-and-spaces',
    apply: (value) => value.replace(/[. ]+$/, ''),
  },
  {
    name: 'suffix-reserved-device-name',
    apply: (value) => {
      const dot = value.indexOf('.');
      const stem = dot === -1 ? value : value.slice(0, dot);
      if (!reservedDeviceNames.has(stem.trimEnd().toUpperCase())) {
        return value;
      }
      return `${stem.trimEnd()}_${dot === -1 ? '' : value.slice(dot)}`;
    },
  },
];

/**
 * Makes one file or folder name legal on Windows. Takes a single name, not a
 * path. May return an empty string; callers treat that as "no usable name".
 */
export function sanitizeName(name: string): string {
  return sanitizeRules.reduce((value, rule) => rule.apply(value), name);
}

export function isSanitized(name: string): boolean {
  return name !== '' && sanitizeName(name) === name;
}
