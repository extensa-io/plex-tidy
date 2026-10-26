import type { z } from 'zod';
import { versionOutputSchema, type ToolName } from './schemas.ts';

export interface ToolDefinition {
  name: ToolName;
  /** The package that provides the binary, for install hints. */
  packageName: string;
  wingetId: string;
  versionArgs: readonly string[];
  versionSchema: z.ZodType<string, string>;
  /** Install folders to check when the binary is not on PATH. */
  defaultLocations: readonly string[];
}

const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
// The ExifTool winget package installs per user when run without elevation.
const localAppData = process.env.LOCALAPPDATA ?? `${process.env.USERPROFILE ?? 'C:\\Users\\Default'}\\AppData\\Local`;

export const toolDefinitions: Readonly<Record<ToolName, ToolDefinition>> = {
  ffprobe: {
    name: 'ffprobe',
    packageName: 'FFmpeg',
    wingetId: 'Gyan.FFmpeg',
    versionArgs: ['-version'],
    versionSchema: versionOutputSchema(/^ffprobe version (\S+)/m),
    defaultLocations: [],
  },
  mkvpropedit: {
    name: 'mkvpropedit',
    packageName: 'MKVToolNix',
    wingetId: 'MoritzBunkus.MKVToolNix',
    versionArgs: ['--version'],
    versionSchema: versionOutputSchema(/^mkvpropedit v(\S+)/m),
    defaultLocations: [`${programFiles}\\MKVToolNix\\mkvpropedit.exe`],
  },
  mkvextract: {
    name: 'mkvextract',
    packageName: 'MKVToolNix',
    wingetId: 'MoritzBunkus.MKVToolNix',
    versionArgs: ['--version'],
    versionSchema: versionOutputSchema(/^mkvextract v(\S+)/m),
    defaultLocations: [`${programFiles}\\MKVToolNix\\mkvextract.exe`],
  },
  exiftool: {
    name: 'exiftool',
    packageName: 'ExifTool',
    wingetId: 'OliverBetz.ExifTool',
    versionArgs: ['-ver'],
    versionSchema: versionOutputSchema(/^(\d+\.\d+)/m),
    defaultLocations: [`${programFiles}\\ExifTool\\exiftool.exe`, `${localAppData}\\Programs\\ExifTool\\exiftool.exe`],
  },
};

export function installHint(tool: ToolDefinition): string {
  return `winget install --id ${tool.wingetId} -e`;
}
