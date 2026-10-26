import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Creates files, and their folders, from paths relative to `root`. */
export async function createTree(root: string, relativePaths: readonly string[]): Promise<void> {
  for (const relativePath of relativePaths) {
    const file = join(root, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, relativePath);
  }
}

/** Every file under `root`, as relative paths with backslashes, sorted. */
export async function listTree(root: string, folder = ''): Promise<string[]> {
  const entries = await readdir(join(root, folder), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const relative = folder === '' ? entry.name : join(folder, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listTree(root, relative)));
    } else {
      found.push(relative);
    }
  }
  return found.sort((a, b) => a.localeCompare(b));
}
