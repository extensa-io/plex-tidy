/** One long step, such as writing tags. Reports counts and time, never file names. */
export interface ProgressTask {
  /** Records how many items are done. `total` may be left out when it is not known yet. */
  update(done: number, total?: number): void;
  /** A short note about the item in progress, such as a copy size. Pass nothing to clear it. */
  detail(text?: string): void;
  /** Ends the task and prints its final line. Does nothing if `update` was never called. */
  done(): void;
}

/** Starts a task with a short label, such as `tagging`. */
export type ProgressFactory = (label: string) => ProgressTask;

export const silentProgress: ProgressFactory = () => ({
  update: () => undefined,
  detail: () => undefined,
  done: () => undefined,
});

export interface ProgressOptions {
  write?: (text: string) => void;
  /** A terminal redraws one line. Anything else gets a line at every 10 percent. */
  isTTY?: boolean;
  now?: () => number;
  /** Redraw interval for the elapsed time while one item takes long. */
  heartbeatMs?: number;
  /** The width of the terminal. A line wider than this wraps and can no longer be redrawn in place. */
  columns?: () => number | undefined;
}

const REDRAW_MS = 100;
/** Output that is not a terminal gets an interim line only after this much silence. */
const QUIET_LINE_MS = 5000;
const CLEAR_LINE = '\r\u001b[2K';

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function counts(done: number, total: number | undefined): string {
  return total === undefined ? String(done) : `${done} of ${total}`;
}

export function createProgress(options: ProgressOptions = {}): ProgressFactory {
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const isTTY = options.isTTY ?? process.stdout.isTTY;
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? 1000;
  const columns = options.columns ?? (() => process.stdout.columns);

  return (label) => {
    const startedAt = now();
    let done = 0;
    let total: number | undefined;
    let started = false;
    let finished = false;
    let lastDraw = Number.NEGATIVE_INFINITY;
    let lastMilestone = -1;
    let lastLine = startedAt;
    let note = '';
    let lastText = '';
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    /**
     * The line to show. If it would be wider than the terminal it wraps, and a wrapped
     * line cannot be redrawn in place, so the least useful parts are dropped until it fits.
     */
    const line = (): string => {
      const elapsed = now() - startedAt;
      const percent = total !== undefined && total > 0 ? ` (${Math.floor((done * 100) / total)}%)` : '';
      const core = `${label}: ${counts(done, total)}${percent}`;
      const time = `elapsed ${formatDuration(elapsed)}`;
      const estimate =
        total !== undefined && done > 0 && done < total && elapsed > 5000
          ? `about ${formatDuration((elapsed / done) * (total - done))} left`
          : '';
      const variants = [
        [core, time, note, estimate],
        [core, time, note],
        [core, note],
        [core],
      ].map((parts) => parts.filter((part) => part !== '').join('  '));

      const width = (columns() ?? Number.POSITIVE_INFINITY) - 1;
      return variants.find((text) => text.length <= width) ?? core.slice(0, Math.max(1, width));
    };

    const draw = (): void => {
      lastDraw = now();
      const text = line();
      if (text !== lastText) {
        lastText = text;
        write(`${CLEAR_LINE}${text}`);
      }
    };

    return {
      update(newDone, newTotal) {
        if (finished) {
          return;
        }
        done = newDone;
        total = newTotal ?? total;
        if (!started) {
          started = true;
          if (isTTY) {
            // Keeps the elapsed time moving while a single large file is being written.
            heartbeat = setInterval(draw, heartbeatMs);
            heartbeat.unref();
          }
        }
        if (isTTY) {
          if (now() - lastDraw >= REDRAW_MS || (total !== undefined && done >= total)) {
            draw();
          }
        } else if (total !== undefined && total > 0 && done < total) {
          // The summary line covers the last item.
          const milestone = Math.floor((done * 10) / total);
          if (milestone > lastMilestone && now() - lastLine >= QUIET_LINE_MS) {
            lastMilestone = milestone;
            lastLine = now();
            write(`${label}: ${counts(done, total)}\n`);
          }
        }
      },
      detail(text) {
        note = text ?? '';
        if (isTTY && started && !finished && now() - lastDraw >= REDRAW_MS) {
          draw();
        }
      },
      done() {
        if (!started || finished) {
          return;
        }
        finished = true;
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
        }
        const summary = `${label}: ${counts(done, total)} in ${formatDuration(now() - startedAt)}`;
        write(isTTY ? `${CLEAR_LINE}${summary}\n` : `${summary}\n`);
      },
    };
  };
}
