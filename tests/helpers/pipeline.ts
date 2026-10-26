import { memoryParseCache } from '../../src/llm/title-parser.ts';
import { parseLocal } from '../../src/parse/local.ts';
import { buildPlan } from '../../src/plan/build.ts';
import type { Plan } from '../../src/plan/schemas.ts';
import { pathExists } from '../../src/fs-win/exists.ts';
import { resolveLocal } from '../../src/resolve/local.ts';
import { RESOLVE_SCHEMA_VERSION, type ResolveFile } from '../../src/resolve/schemas.ts';
import { scanRoot } from '../../src/scan/scan.ts';
import type { Scan } from '../../src/scan/schemas.ts';
import { createStubModel, type StubModelOptions } from './stub-model.ts';

/** Runs parse and resolve for a scan with a stub model. */
export async function resolveScan(scan: Scan, options: StubModelOptions = {}): Promise<ResolveFile> {
  const { entries } = await parseLocal(scan, {
    model: createStubModel(options),
    cache: memoryParseCache(),
    batchSize: 50,
  });
  const files = new Map(scan.files.map((file) => [file.id, file]));
  return {
    schemaVersion: RESOLVE_SCHEMA_VERSION,
    scanId: scan.scanId,
    entries: entries.map((entry) => {
      const file = files.get(entry.id);
      if (file === undefined) {
        throw new Error('scan and parse results disagree');
      }
      return { ...entry, resolution: resolveLocal(file, entry.parse) };
    }),
  };
}

/** scan, parse, resolve, and plan for a folder on disk. */
export async function planFor(root: string, options: StubModelOptions = {}): Promise<{ scan: Scan; plan: Plan }> {
  const scan = await scanRoot(root);
  const resolved = await resolveScan(scan, options);
  const plan = await buildPlan(scan, resolved, { exists: pathExists });
  return { scan, plan };
}

export function approveAll(plan: Plan): Plan {
  return {
    ...plan,
    entries: plan.entries.map((entry) => (entry.status === 'pending' ? { ...entry, status: 'approved' } : entry)),
  };
}
