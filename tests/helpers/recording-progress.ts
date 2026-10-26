import type { ProgressFactory } from '../../src/progress.ts';

export interface RecordedTask {
  label: string;
  /** Every `[done, total]` reported, in order. */
  updates: [number, number | undefined][];
  finished: boolean;
  /** Every note set with `detail`, in order. `undefined` is a cleared note. */
  details: (string | undefined)[];
}

/** A progress factory that remembers what each task reported, for tests. */
export function recordingProgress(): { factory: ProgressFactory; tasks: RecordedTask[] } {
  const tasks: RecordedTask[] = [];
  const factory: ProgressFactory = (label) => {
    const task: RecordedTask = { label, updates: [], finished: false, details: [] };
    tasks.push(task);
    return {
      update: (done, total) => {
        task.updates.push([done, total]);
      },
      detail: (text) => {
        task.details.push(text);
      },
      done: () => {
        task.finished = true;
      },
    };
  };
  return { factory, tasks };
}
