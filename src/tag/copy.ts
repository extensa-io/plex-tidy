import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Large blocks keep a network copy fast. 32 MB measured about 68 MB/s on the
 * owner's network, against 44 MB/s for 1 MB blocks.
 */
export const COPY_BLOCK_BYTES = 32 * 1024 * 1024;

/**
 * Copies a file block by block and reports how many bytes are written. The
 * destination must not exist. `fs.copyFile` is a little faster, but Windows
 * sizes the destination at once, so it cannot show progress.
 */
export async function copyWithProgress(
  from: string,
  to: string,
  onProgress?: (copiedBytes: number, totalBytes: number) => void,
  intervalMs = 1000,
): Promise<void> {
  const total = (await stat(from)).size;
  let copied = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      copied += chunk.length;
      callback(null, chunk);
    },
  });
  const timer = setInterval(() => {
    onProgress?.(copied, total);
  }, intervalMs);
  try {
    await pipeline(
      createReadStream(from, { highWaterMark: COPY_BLOCK_BYTES }),
      counter,
      createWriteStream(to, { flags: 'wx', highWaterMark: COPY_BLOCK_BYTES }),
    );
  } finally {
    clearInterval(timer);
  }
  onProgress?.(total, total);

  // Ask the system to write the data out. Some network shares do not support this, which is fine.
  const handle = await open(to, 'r+');
  try {
    await handle.sync();
  } catch {
    // Not supported here.
  } finally {
    await handle.close();
  }
}
