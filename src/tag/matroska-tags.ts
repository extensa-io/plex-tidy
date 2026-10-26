import Builder from 'fast-xml-builder';
import { XMLParser } from 'fast-xml-parser';

/** A `Simple` element: a name and a value, possibly with nested children. */
export interface SimpleNode {
  Name: string;
  String?: string;
  [key: string]: unknown;
}

/** A `Tag` element: what it targets, and the simple tags under it. */
export interface TagNode {
  Targets: unknown;
  Simple?: SimpleNode[];
  [key: string]: unknown;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name) => name === 'Tag' || name === 'Simple',
});

const builder = new Builder({
  ignoreAttributes: false,
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
  processEntities: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSimple(value: unknown): SimpleNode[] {
  return Array.isArray(value) ? value.filter(isRecord).filter((node): node is SimpleNode => typeof node.Name === 'string') : [];
}

/** All `Tag` elements of the XML that `mkvextract tags` prints. A leading byte-order mark is ignored. */
export function parseTagsXml(xml: string): TagNode[] {
  const text = (xml.codePointAt(0) === 0xfeff ? xml.slice(1) : xml).trim();
  if (text === '') {
    return [];
  }
  const parsed: unknown = parser.parse(text);
  const root = isRecord(parsed) ? parsed.Tags : undefined;
  const tags = isRecord(root) ? root.Tag : undefined;
  if (!Array.isArray(tags)) {
    return [];
  }
  return tags.filter(isRecord).map((tag) => ({ ...tag, Targets: tag.Targets ?? '', Simple: asSimple(tag.Simple) }));
}

/** A global tag belongs to the file, not to a track, chapter, edition, or attachment. */
export function isGlobalTag(tag: TagNode): boolean {
  return !isRecord(tag.Targets) || !Object.keys(tag.Targets).some((key) => key.endsWith('UID'));
}

function hasNoTargets(tag: TagNode): boolean {
  return !isRecord(tag.Targets) || Object.keys(tag.Targets).length === 0;
}

/** The values of the named top-level simple tags, across all global tags, in file order. */
export function globalValues(tags: readonly TagNode[], names: readonly string[]): Record<string, string[]> {
  const wanted = new Set(names);
  const values: Record<string, string[]> = Object.fromEntries(names.map((name) => [name, []]));
  for (const tag of tags.filter(isGlobalTag)) {
    for (const simple of tag.Simple ?? []) {
      if (wanted.has(simple.Name) && typeof simple.String === 'string') {
        values[simple.Name]?.push(simple.String);
      }
    }
  }
  return values;
}

/**
 * The global tags the file should have after writing `desired`. Other global
 * tags stay as they are. A name in `desired` with no values is removed.
 * `mkvpropedit --tags global:` replaces the whole set, so this returns all of it.
 */
export function mergeGlobalTags(tags: readonly TagNode[], desired: Readonly<Record<string, string[]>>): TagNode[] {
  const managed = new Set(Object.keys(desired));
  const globals = tags.filter(isGlobalTag).map(
    (tag): TagNode => ({
      ...tag,
      Simple: (tag.Simple ?? []).filter((simple) => !managed.has(simple.Name)),
    }),
  );

  const added = Object.entries(desired).flatMap(([name, values]) =>
    values.map((value): SimpleNode => ({ Name: name, String: value })),
  );
  if (added.length > 0) {
    const home = globals.find(hasNoTargets);
    if (home === undefined) {
      globals.push({ Targets: '', Simple: added });
    } else {
      home.Simple = [...(home.Simple ?? []), ...added];
    }
  }
  return globals.filter((tag) => (tag.Simple?.length ?? 0) > 0);
}

export function buildTagsXml(tags: readonly TagNode[]): string {
  // `Targets` comes first in every `Tag` element, as the Matroska format expects.
  const body = builder.build({ Tags: { Tag: tags.map(({ Targets, ...rest }) => ({ Targets, ...rest })) } });
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}
