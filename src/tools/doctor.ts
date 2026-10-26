import { loadConfig, type Config } from '../config.ts';
import { envKeys, requireEnv, type EnvKey } from '../env.ts';
import { isAppError } from '../errors.ts';
import { installHint, toolDefinitions } from './registry.ts';
import { probeTool, type ToolStatus } from './run.ts';
import { toolNameSchema } from './schemas.ts';

export const MINIMUM_NODE_VERSION = '20.6.0';

export type KeyStatus = 'present' | 'missing' | 'invalid';

export interface DoctorReport {
  node: { version: string; minimum: string; ok: boolean };
  config: { ok: true } | { ok: false; message: string };
  tools: ToolStatus[];
  keys: Record<EnvKey, KeyStatus>;
}

export interface DoctorDeps {
  nodeVersion: string;
  loadConfig: () => Promise<Config>;
  probeTool: typeof probeTool;
  env: Readonly<Record<string, string | undefined>>;
}

const defaultDeps: DoctorDeps = {
  nodeVersion: process.versions.node,
  loadConfig: () => loadConfig(),
  probeTool,
  env: process.env,
};

export async function runDoctor(deps: DoctorDeps = defaultDeps): Promise<DoctorReport> {
  let config: DoctorReport['config'] = { ok: true };
  let overrides: Config['tools'] = {};
  try {
    overrides = (await deps.loadConfig()).tools;
  } catch (error) {
    if (!isAppError(error)) {
      throw error;
    }
    config = { ok: false, message: error.message };
  }

  const tools: ToolStatus[] = [];
  for (const tool of toolNameSchema.options) {
    tools.push(await deps.probeTool(tool, { overrides }));
  }

  return {
    node: {
      version: deps.nodeVersion,
      minimum: MINIMUM_NODE_VERSION,
      ok: compareVersions(deps.nodeVersion, MINIMUM_NODE_VERSION) >= 0,
    },
    config,
    tools,
    keys: keyStatuses(deps.env),
  };
}

export function doctorHasProblems(report: DoctorReport): boolean {
  return (
    !report.node.ok ||
    !report.config.ok ||
    report.tools.some((tool) => !tool.found) ||
    Object.values(report.keys).some((status) => status !== 'present')
  );
}

export function formatDoctorReport(report: DoctorReport): string[] {
  const lines: string[] = [];
  const row = (ok: boolean, label: string, detail: string) => {
    lines.push(`${ok ? '[ok]     ' : '[problem]'} ${label.padEnd(24)} ${detail}`);
  };

  row(report.node.ok, 'Node.js', `v${report.node.version} (minimum v${report.node.minimum})`);
  row(report.config.ok, 'config.json', report.config.ok ? 'valid' : report.config.message);

  for (const status of report.tools) {
    if (status.found) {
      row(true, status.tool, `${status.version} at ${status.path}`);
    } else {
      const definition = toolDefinitions[status.tool];
      row(false, status.tool, `${status.reason}. Install ${definition.packageName}: ${installHint(definition)}`);
    }
  }

  for (const key of envKeys) {
    const status = report.keys[key];
    row(status === 'present', key, status === 'present' ? 'set' : status === 'missing' ? 'not set in .env' : 'invalid');
  }
  return lines;
}

function keyStatuses(env: DoctorDeps['env']): Record<EnvKey, KeyStatus> {
  const status = (key: EnvKey): KeyStatus => {
    try {
      requireEnv(key, env);
      return 'present';
    } catch (error) {
      return isAppError(error) && error.code === 'ENV_INVALID' ? 'invalid' : 'missing';
    }
  };
  return {
    ANTHROPIC_API_KEY: status('ANTHROPIC_API_KEY'),
    TMDB_READ_ACCESS_TOKEN: status('TMDB_READ_ACCESS_TOKEN'),
  };
}

/** Compares dotted numeric versions such as `24.22.1` and `20.6.0`. */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
