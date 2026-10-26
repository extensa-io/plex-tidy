import { extname } from 'node:path';
import type { Writer } from './schemas.ts';

export interface ContainerSupport {
  extension: string;
  /** The tool that writes tags, or `null` when the container is rename-only. */
  writer: Writer | null;
  /** Why the container is rename-only. Set exactly when `writer` is `null`. */
  reason: string | null;
}

/**
 * The container support matrix. Each row records what happened with a real
 * sample file of that type: a title write followed by a read-back with
 * `ffprobe`. The integration test `container-matrix.test.ts` repeats that
 * experiment and fails if a row stops being true.
 */
export const containerMatrix: Readonly<Record<string, ContainerSupport>> = {
  '.mkv': { extension: '.mkv', writer: 'mkvpropedit', reason: null },
  '.mp4': { extension: '.mp4', writer: 'exiftool', reason: null },
  '.m4v': { extension: '.m4v', writer: 'exiftool', reason: null },
  '.mov': { extension: '.mov', writer: 'exiftool', reason: null },
  '.avi': { extension: '.avi', writer: null, reason: 'ExifTool cannot write AVI (RIFF) files' },
  '.wmv': { extension: '.wmv', writer: null, reason: 'ExifTool cannot write WMV (ASF) files' },
};

export function containerFor(file: string): ContainerSupport {
  const extension = extname(file).toLowerCase();
  return (
    containerMatrix[extension] ?? {
      extension,
      writer: null,
      reason: 'the container type is not in the support matrix',
    }
  );
}
