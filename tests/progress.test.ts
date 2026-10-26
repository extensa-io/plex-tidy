import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgress, formatDuration, silentProgress } from '../src/progress.ts';

afterEach(() => {
  vi.useRealTimers();
});

function setup(isTTY: boolean) {
  let clock = 0;
  const output: string[] = [];
  const factory = createProgress({ isTTY, now: () => clock, write: (text) => void output.push(text) });
  return {
    factory,
    output,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

const plain = (text: string) => text.replaceAll('\r\u001b[2K', '');

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [4_400, '4s'],
    [59_600, '1m00s'],
    [130_000, '2m10s'],
    [3_599_000, '59m59s'],
    [3_720_000, '1h02m'],
  ])('formats %i ms as %s', (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected);
  });
});

describe('progress on a terminal', () => {
  it('redraws one line with the count, the percentage, and the elapsed time', () => {
    const { factory, output, advance } = setup(true);
    const task = factory('tagging');
    advance(1000);
    task.update(12, 70);
    expect(plain(output.at(-1) ?? '')).toBe('tagging: 12 of 70 (17%)  elapsed 1s');
    expect(output.at(-1)?.startsWith('\r\u001b[2K')).toBe(true);
    task.done();
  });

  it('adds an estimate once enough time has passed', () => {
    const { factory, output, advance } = setup(true);
    const task = factory('tagging');
    advance(60_000);
    task.update(10, 40);
    expect(plain(output.at(-1) ?? '')).toBe('tagging: 10 of 40 (25%)  elapsed 1m00s  about 3m00s left');
    task.done();
  });

  it('does not redraw faster than the interval, except for the last item', () => {
    const { factory, output, advance } = setup(true);
    const task = factory('renaming');
    advance(1000);
    task.update(1, 3);
    task.update(2, 3);
    expect(output).toHaveLength(1);
    task.update(3, 3);
    expect(output).toHaveLength(2);
    task.done();
  });

  it('shows only a count when the total is not known', () => {
    const { factory, output, advance } = setup(true);
    const task = factory('scanning (video files found)');
    advance(1000);
    task.update(1234);
    expect(plain(output.at(-1) ?? '')).toBe('scanning (video files found): 1234  elapsed 1s');
    task.done();
  });

  it('ends with one summary line and a line break', () => {
    const { factory, output, advance } = setup(true);
    const task = factory('tagging');
    advance(125_000);
    task.update(70, 70);
    task.done();
    expect(plain(output.at(-1) ?? '')).toBe('tagging: 70 of 70 in 2m05s\n');
    const lines = output.length;
    task.done();
    task.update(1, 70);
    expect(output).toHaveLength(lines);
  });

  it('keeps the elapsed time moving while one item takes long, and stops at the end', () => {
    vi.useFakeTimers();
    let clock = 0;
    const output: string[] = [];
    const factory = createProgress({ isTTY: true, now: () => clock, write: (text) => void output.push(text), heartbeatMs: 1000 });
    const task = factory('tagging');
    task.update(0, 5);
    const first = output.length;

    clock += 3000;
    vi.advanceTimersByTime(3000);
    expect(output.length).toBeGreaterThan(first);
    expect(plain(output.at(-1) ?? '')).toContain('elapsed 3s');

    task.done();
    const afterDone = output.length;
    vi.advanceTimersByTime(5000);
    expect(output).toHaveLength(afterDone);
  });
});

describe('progress when output is not a terminal', () => {
  it('prints an interim line only after five quiet seconds, then a final summary, with no control codes', () => {
    const { factory, output, advance } = setup(false);
    const task = factory('tagging');
    for (let done = 1; done <= 20; done += 1) {
      advance(1000);
      task.update(done, 20);
    }
    task.done();

    expect(output.some((text) => text.includes('\u001b') || text.includes('\r'))).toBe(false);
    expect(output).toEqual([
      'tagging: 5 of 20\n',
      'tagging: 10 of 20\n',
      'tagging: 15 of 20\n',
      'tagging: 20 of 20 in 20s\n',
    ]);
  });

  it('prints only the summary for a step that finishes quickly', () => {
    const { factory, output, advance } = setup(false);
    const task = factory('checking renames');
    for (let done = 1; done <= 11; done += 1) {
      advance(50);
      task.update(done, 11);
    }
    task.done();
    expect(output).toEqual(['checking renames: 11 of 11 in 1s\n']);
  });

  it('prints only the summary when the total is not known', () => {
    const { factory, output, advance } = setup(false);
    const task = factory('scanning (video files found)');
    advance(2000);
    task.update(5);
    task.update(6);
    task.done();
    expect(output).toEqual(['scanning (video files found): 6 in 2s\n']);
  });
});

describe('a task that never started', () => {
  it('prints nothing when it ends', () => {
    const { factory, output } = setup(true);
    factory('asking the model (requests)').done();
    expect(output).toEqual([]);
  });

  it('the silent factory prints nothing', () => {
    const task = silentProgress('anything');
    task.update(1, 2);
    task.done();
  });
});

describe('progress detail note', () => {
  it('adds the note to the line on a terminal and removes it when cleared', () => {
    const { factory, output, advance } = setup(true);
    const task = factory('tagging');
    advance(1000);
    task.update(0, 5);
    advance(1000);
    task.detail('this file: 652 of 1210 MB, 5.0 MB/s');
    expect(plain(output.at(-1) ?? '')).toBe('tagging: 0 of 5 (0%)  elapsed 2s  this file: 652 of 1210 MB, 5.0 MB/s');
    advance(1000);
    task.detail(undefined);
    advance(200);
    task.update(1, 5);
    expect(plain(output.at(-1) ?? '')).toBe('tagging: 1 of 5 (20%)  elapsed 3s');
    task.done();
  });

  it('is ignored when output is not a terminal', () => {
    const { factory, output, advance } = setup(false);
    const task = factory('tagging');
    advance(1000);
    task.update(0, 5);
    task.detail('this file: 1 of 2 MB');
    task.update(5, 5);
    task.done();
    expect(output).toEqual(['tagging: 5 of 5 in 1s\n']);
  });
});

describe('progress on a narrow terminal', () => {
  function narrow(columns: number | undefined) {
    let clock = 0;
    const output: string[] = [];
    const factory = createProgress({
      isTTY: true,
      now: () => clock,
      write: (text) => void output.push(text),
      columns: () => columns,
    });
    return { factory, output, advance: (milliseconds: number) => void (clock += milliseconds) };
  }

  const note = 'building copy 147 of 1218 MB, 4.7 MB/s';

  function lineAt(columns: number | undefined): string {
    const { factory, output, advance } = narrow(columns);
    const task = factory('tagging');
    advance(600_000);
    task.update(12, 71);
    task.detail(note);
    advance(200);
    task.update(12, 71);
    const last = output.at(-1) ?? '';
    task.done();
    return plain(last);
  }

  it('shows everything when the terminal is wide enough', () => {
    expect(lineAt(200)).toBe(`tagging: 12 of 71 (16%)  elapsed 10m00s  ${note}  about 49m11s left`);
  });

  it.each([
    [90, 'estimate'],
    [70, 'elapsed time'],
    [50, 'note'],
    [20, 'note and label detail'],
  ])('is always narrower than a %i column terminal (drops the %s first)', (columns) => {
    expect(lineAt(columns).length).toBeLessThan(columns);
  });

  it('drops the estimate first, then the elapsed time, then the note', () => {
    const wide = lineAt(200);
    expect(lineAt(wide.length - 1)).not.toContain('left');
    expect(lineAt(wide.length - 1)).toContain(note);
    const withoutEstimate = `tagging: 12 of 71 (16%)  elapsed 10m00s  ${note}`;
    expect(lineAt(withoutEstimate.length - 1)).not.toContain('elapsed');
    expect(lineAt(withoutEstimate.length - 1)).toContain(note);
    const withoutTime = `tagging: 12 of 71 (16%)  ${note}`;
    expect(lineAt(withoutTime.length - 1)).toBe('tagging: 12 of 71 (16%)');
  });

  it('cuts the label as a last resort', () => {
    // A 10 column terminal leaves 9 characters, so that nothing wraps.
    expect(lineAt(10)).toBe('tagging: ');
  });

  it('does not redraw a line that has not changed', () => {
    const { factory, output, advance } = narrow(200);
    const task = factory('renaming');
    task.update(1, 5);
    const first = output.length;
    advance(200);
    task.update(1, 5);
    expect(output).toHaveLength(first);
    task.done();
  });
});
