import { describe, expect, it } from 'vitest';
import { checkPathLength, isInsideRoot, MAX_PATH_LENGTH, sameVolume, volumeOf } from '../../src/fs-win/path-checks.ts';

function pathOfLength(length: number): string {
  const prefix = 'D:\\Library\\';
  return `${prefix}${'a'.repeat(length - prefix.length)}`;
}

describe('checkPathLength', () => {
  it('accepts a path at the limit', () => {
    expect(checkPathLength(pathOfLength(MAX_PATH_LENGTH))).toEqual({ ok: true, length: MAX_PATH_LENGTH });
  });

  it('refuses a path one character over the limit', () => {
    expect(checkPathLength(pathOfLength(MAX_PATH_LENGTH + 1))).toEqual({
      ok: false,
      length: MAX_PATH_LENGTH + 1,
      limit: MAX_PATH_LENGTH,
    });
  });
});

describe('volumeOf and sameVolume', () => {
  it('reads drive and UNC volumes', () => {
    expect(volumeOf('u:\\Videos\\Sample.mkv')).toBe('U:\\');
    expect(volumeOf('\\\\server\\share\\Videos\\Sample.mkv')).toBe('\\\\SERVER\\SHARE\\');
  });

  it('compares drive letters without regard to case', () => {
    expect(sameVolume('U:\\Videos\\a.mkv', 'u:\\Other\\b.mkv')).toBe(true);
  });

  it('treats different drives as different volumes', () => {
    expect(sameVolume('U:\\Videos\\a.mkv', 'T:\\Videos\\a.mkv')).toBe(false);
  });

  it('treats different UNC shares as different volumes', () => {
    expect(sameVolume('\\\\server\\one\\a.mkv', '\\\\server\\two\\a.mkv')).toBe(false);
  });
});

describe('isInsideRoot', () => {
  const root = 'U:\\Videos';

  it('accepts a descendant', () => {
    expect(isInsideRoot(root, 'U:\\Videos\\Folder\\Sample.mkv')).toBe(true);
  });

  it('compares without regard to case', () => {
    expect(isInsideRoot(root, 'u:\\videos\\sample.mkv')).toBe(true);
  });

  it('does not count the root itself as inside', () => {
    expect(isInsideRoot(root, 'U:\\Videos\\')).toBe(false);
  });

  it('refuses a sibling folder that shares a name prefix', () => {
    expect(isInsideRoot(root, 'U:\\Videos Old\\Sample.mkv')).toBe(false);
  });

  it('refuses a path that climbs out with ..', () => {
    expect(isInsideRoot(root, 'U:\\Videos\\Folder\\..\\..\\Other\\Sample.mkv')).toBe(false);
  });

  it('refuses another volume', () => {
    expect(isInsideRoot(root, 'T:\\Videos\\Sample.mkv')).toBe(false);
  });

  it('accepts a name that starts with two dots', () => {
    expect(isInsideRoot(root, 'U:\\Videos\\..Sample.mkv')).toBe(true);
  });
});
