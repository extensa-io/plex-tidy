import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/errors.ts';
import { MAX_PATH_LENGTH } from '../../src/fs-win/path-checks.ts';
import { safeRename } from '../../src/fs-win/safe-rename.ts';
import { useTempDirs } from '../helpers/temp-dir.ts';

const makeTempDir = useTempDirs();

async function setup() {
  const base = await makeTempDir();
  const root = join(base, 'Library');
  const outside = join(base, 'Outside');
  await mkdir(join(root, 'Folder'), { recursive: true });
  await mkdir(outside);
  const source = join(root, 'Folder', 'sample clip one.mkv');
  await writeFile(source, 'source content');
  return { root, outside, source };
}

async function expectAppError(promise: Promise<unknown>, code: AppError['code']): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe('safeRename', () => {
  it('renames a file inside the root', async () => {
    const { root, source } = await setup();
    const target = join(root, 'Folder', 'Renamed Clip.mkv');

    await expect(safeRename(root, source, target)).resolves.toBe('renamed');
    expect(await readdir(join(root, 'Folder'))).toEqual(['Renamed Clip.mkv']);
    expect(await readFile(target, 'utf8')).toBe('source content');
  });

  it('renames a folder inside the root', async () => {
    const { root } = await setup();
    await expect(safeRename(root, join(root, 'Folder'), join(root, 'Renamed Folder'))).resolves.toBe('renamed');
    expect(await readdir(root)).toEqual(['Renamed Folder']);
  });

  it('returns unchanged when source and destination are the same path', async () => {
    const { root, source } = await setup();
    await expect(safeRename(root, source, source)).resolves.toBe('unchanged');
  });

  it('refuses to overwrite an existing destination and leaves both files intact', async () => {
    const { root, source } = await setup();
    const existing = join(root, 'Folder', 'Existing Clip.mkv');
    await writeFile(existing, 'existing content');

    await expectAppError(safeRename(root, source, existing), 'DESTINATION_EXISTS');
    expect(await readFile(source, 'utf8')).toBe('source content');
    expect(await readFile(existing, 'utf8')).toBe('existing content');
  });

  it('refuses a destination that differs from another file only in case', async () => {
    const { root, source } = await setup();
    await writeFile(join(root, 'Folder', 'Existing Clip.mkv'), 'existing content');

    await expectAppError(safeRename(root, source, join(root, 'Folder', 'EXISTING CLIP.mkv')), 'DESTINATION_EXISTS');
  });

  it('refuses a destination outside the root', async () => {
    const { root, outside, source } = await setup();
    await expectAppError(safeRename(root, source, join(outside, 'Sample Clip.mkv')), 'PATH_OUTSIDE_ROOT');
    expect(await readdir(outside)).toEqual([]);
    expect(await readFile(source, 'utf8')).toBe('source content');
  });

  it('refuses a source outside the root', async () => {
    const { root, outside } = await setup();
    const outsideFile = join(outside, 'outside clip.mkv');
    await writeFile(outsideFile, 'outside content');
    await expectAppError(safeRename(root, outsideFile, join(root, 'Folder', 'Moved Clip.mkv')), 'PATH_OUTSIDE_ROOT');
  });

  it('refuses a destination that climbs out of the root with ..', async () => {
    const { root, source } = await setup();
    await expectAppError(safeRename(root, source, join(root, '..', 'Escaped Clip.mkv')), 'PATH_OUTSIDE_ROOT');
  });

  it('refuses a destination reached through a junction that points outside the root', async () => {
    const { root, outside, source } = await setup();
    const link = join(root, 'Linked Folder');
    await symlink(outside, link, 'junction');

    await expectAppError(safeRename(root, source, join(link, 'Linked Clip.mkv')), 'PATH_OUTSIDE_ROOT');
    expect(await readdir(outside)).toEqual([]);
  });

  it('performs a case-only rename', async () => {
    const { root, source } = await setup();
    const target = join(root, 'Folder', 'Sample Clip One.mkv');

    await expect(safeRename(root, source, target)).resolves.toBe('renamed');
    expect(await readdir(join(root, 'Folder'))).toEqual(['Sample Clip One.mkv']);
    expect(await readFile(target, 'utf8')).toBe('source content');
  });

  it('refuses a destination name with characters Windows does not allow', async () => {
    const { root, source } = await setup();
    await expectAppError(safeRename(root, source, join(root, 'Folder', 'Sample Clip.')), 'NAME_INVALID');
  });

  it('refuses a missing source', async () => {
    const { root } = await setup();
    await expectAppError(
      safeRename(root, join(root, 'Folder', 'missing clip.mkv'), join(root, 'Folder', 'Missing Clip.mkv')),
      'SOURCE_MISSING',
    );
  });

  it('refuses a destination whose folder does not exist', async () => {
    const { root, source } = await setup();
    await expectAppError(
      safeRename(root, source, join(root, 'New Folder', 'Sample Clip.mkv')),
      'DESTINATION_PARENT_MISSING',
    );
  });

  it('refuses a destination path over the length limit', async () => {
    const { root, source } = await setup();
    const folder = join(root, 'Folder');
    const name = `${'a'.repeat(MAX_PATH_LENGTH - folder.length)}.mkv`;
    await expectAppError(safeRename(root, source, join(folder, name)), 'PATH_TOO_LONG');
    expect(await readFile(source, 'utf8')).toBe('source content');
  });
});
