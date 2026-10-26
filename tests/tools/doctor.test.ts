import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.ts';
import { AppError } from '../../src/errors.ts';
import { compareVersions, doctorHasProblems, formatDoctorReport, runDoctor, type DoctorDeps } from '../../src/tools/doctor.ts';
import type { ToolStatus } from '../../src/tools/run.ts';

const anthropicKey = 'sk-test-doctor-0000000000';
const tmdbToken = 'dddddddddd.eeeeeeeeee.ffffffffff';

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: '24.1.0',
    loadConfig: () => Promise.resolve(parseConfig({ models: { parse: 'parse-model', judge: 'judge-model' } })),
    probeTool: (tool) =>
      Promise.resolve<ToolStatus>({ tool, found: true, path: `C:\\Bin\\${tool}.exe`, source: 'path', version: '1.0' }),
    env: { ANTHROPIC_API_KEY: anthropicKey, TMDB_READ_ACCESS_TOKEN: tmdbToken },
    ...overrides,
  };
}

describe('runDoctor', () => {
  it('reports a healthy setup with no problems', async () => {
    const report = await runDoctor(deps());
    expect(report.node).toEqual({ version: '24.1.0', minimum: '20.6.0', ok: true });
    expect(report.config).toEqual({ ok: true });
    expect(report.tools.map((tool) => tool.tool)).toEqual(['ffprobe', 'mkvpropedit', 'mkvextract', 'exiftool']);
    expect(report.keys).toEqual({ ANTHROPIC_API_KEY: 'present', TMDB_READ_ACCESS_TOKEN: 'present' });
    expect(doctorHasProblems(report)).toBe(false);
  });

  it('flags a Node version below the minimum', async () => {
    const report = await runDoctor(deps({ nodeVersion: '20.5.1' }));
    expect(report.node.ok).toBe(false);
    expect(doctorHasProblems(report)).toBe(true);
  });

  it('reports a missing tool with its winget install hint', async () => {
    const report = await runDoctor(
      deps({
        probeTool: (tool) =>
          Promise.resolve<ToolStatus>(
            tool === 'exiftool'
              ? { tool, found: false, reason: 'not found' }
              : { tool, found: true, path: `C:\\Bin\\${tool}.exe`, source: 'path', version: '1.0' },
          ),
      }),
    );
    expect(doctorHasProblems(report)).toBe(true);
    const line = formatDoctorReport(report).find((entry) => entry.includes('exiftool'));
    expect(line).toContain('[problem]');
    expect(line).toContain('winget install --id OliverBetz.ExifTool -e');
  });

  it('reports missing and invalid keys', async () => {
    const report = await runDoctor(deps({ env: { TMDB_READ_ACCESS_TOKEN: 'short-api-key' } }));
    expect(report.keys).toEqual({ ANTHROPIC_API_KEY: 'missing', TMDB_READ_ACCESS_TOKEN: 'invalid' });
    expect(doctorHasProblems(report)).toBe(true);
  });

  it('still checks tools when config.json is missing', async () => {
    const report = await runDoctor(
      deps({ loadConfig: () => Promise.reject(new AppError('CONFIG_MISSING', 'config.json was not found.')) }),
    );
    expect(report.config).toEqual({ ok: false, message: 'config.json was not found.' });
    expect(report.tools).toHaveLength(4);
  });

  it('never prints key values', async () => {
    const output = formatDoctorReport(await runDoctor(deps())).join('\n');
    expect(output).toContain('ANTHROPIC_API_KEY');
    expect(output).not.toContain(anthropicKey);
    expect(output).not.toContain(tmdbToken);
  });
});

describe('compareVersions', () => {
  it.each([
    ['24.22.1', '20.6.0', 1],
    ['20.6.0', '20.6.0', 0],
    ['v20.6.0', '20.6', 0],
    ['20.10.0', '20.6.0', 1],
    ['18.20.4', '20.6.0', -1],
  ])('compares %s with %s', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});
