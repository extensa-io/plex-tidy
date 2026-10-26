import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolDefinitions } from '../../src/tools/registry.ts';
import { findOnPath, probeTool, resolveBinary, runTool } from '../../src/tools/run.ts';

const existsIn = (paths: string[]) => (path: string) => Promise.resolve(paths.includes(path));

describe('version output schemas', () => {
  it.each([
    ['ffprobe', 'ffprobe version 9.0.2-full_build Copyright (c) 2007-2026\nbuilt with gcc', '9.0.2-full_build'],
    ['mkvpropedit', "mkvpropedit v103.0.0 ('Sample Name') 64-bit", '103.0.0'],
    ['mkvextract', "mkvextract v103.0.0 ('Sample Name') 64-bit", '103.0.0'],
    ['exiftool', '13.59', '13.59'],
  ] as const)('reads the %s version', (tool, output, version) => {
    expect(toolDefinitions[tool].versionSchema.parse(output)).toBe(version);
  });

  it('rejects unrecognized output', () => {
    expect(toolDefinitions.ffprobe.versionSchema.safeParse('something else').success).toBe(false);
  });
});

describe('findOnPath', () => {
  it('returns the first directory that holds the executable', async () => {
    const pathValue = 'C:\\One;"C:\\Two Dir";;C:\\Three';
    const found = await findOnPath('exiftool', pathValue, existsIn(['C:\\Two Dir\\exiftool.exe', 'C:\\Three\\exiftool.exe']));
    expect(found).toBe('C:\\Two Dir\\exiftool.exe');
  });

  it('returns undefined when no directory holds it', async () => {
    expect(await findOnPath('exiftool', 'C:\\One', existsIn([]))).toBeUndefined();
  });
});

describe('resolveBinary', () => {
  it('uses the config override when it exists', async () => {
    const result = await resolveBinary('exiftool', {
      overrides: { exiftool: 'D:\\Tools\\exiftool.exe' },
      pathValue: 'C:\\Bin',
      fileExists: existsIn(['D:\\Tools\\exiftool.exe', 'C:\\Bin\\exiftool.exe']),
    });
    expect(result).toEqual({ path: 'D:\\Tools\\exiftool.exe', source: 'config' });
  });

  it('does not fall back to PATH when the config override is missing', async () => {
    const result = await resolveBinary('exiftool', {
      overrides: { exiftool: 'D:\\Tools\\exiftool.exe' },
      pathValue: 'C:\\Bin',
      fileExists: existsIn(['C:\\Bin\\exiftool.exe']),
    });
    expect(result).toBeUndefined();
  });

  it('finds the binary on PATH', async () => {
    const result = await resolveBinary('ffprobe', { pathValue: 'C:\\Bin', fileExists: existsIn(['C:\\Bin\\ffprobe.exe']) });
    expect(result).toEqual({ path: 'C:\\Bin\\ffprobe.exe', source: 'path' });
  });

  it('falls back to the default install folder', async () => {
    const [location] = toolDefinitions.mkvpropedit.defaultLocations;
    expect(location).toBeDefined();
    const result = await resolveBinary('mkvpropedit', { pathValue: 'C:\\Bin', fileExists: existsIn([location ?? '']) });
    expect(result).toEqual({ path: location, source: 'default-location' });
  });
});

describe('runTool', () => {
  const node = process.execPath;

  it('returns standard output parsed by the schema', async () => {
    const schema = z.string().transform((text) => text.split(','));
    await expect(runTool(node, ['-e', 'process.stdout.write("a,b")'], schema)).resolves.toEqual(['a', 'b']);
  });

  it('reports a nonzero exit as TOOL_FAILED', async () => {
    await expect(runTool(node, ['-e', 'process.exit(3)'], z.string())).rejects.toMatchObject({
      code: 'TOOL_FAILED',
      message: expect.stringContaining('exited with code 3') as string,
    });
  });

  it('reports output the schema rejects as TOOL_OUTPUT_INVALID', async () => {
    await expect(runTool(node, ['-e', 'process.stdout.write("text")'], z.string().regex(/^\d+$/))).rejects.toMatchObject({
      code: 'TOOL_OUTPUT_INVALID',
    });
  });

  it('reports a missing binary as TOOL_NOT_FOUND', async () => {
    await expect(runTool('C:\\Missing\\plex-tidy-missing-binary.exe', [], z.string())).rejects.toMatchObject({
      code: 'TOOL_NOT_FOUND',
    });
  });
});

describe('probeTool', () => {
  it('reports a tool that cannot be found', async () => {
    await expect(probeTool('exiftool', { pathValue: '', fileExists: existsIn([]) })).resolves.toEqual({
      tool: 'exiftool',
      found: false,
      reason: 'not found',
    });
  });

  it('says when the config override path is the problem', async () => {
    await expect(
      probeTool('exiftool', { overrides: { exiftool: 'D:\\Missing\\exiftool.exe' }, fileExists: existsIn([]) }),
    ).resolves.toMatchObject({ found: false, reason: 'not found at the path set in config.json' });
  });
});
