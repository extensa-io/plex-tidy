import { win32 } from 'node:path';
import { approvedEntries } from '../apply/apply.ts';
import type { TitleModel } from '../llm/model-client.ts';
import type { Backends } from '../tag/backends.ts';
import { planSchema } from '../plan/schemas.ts';
import { summarizePlan } from '../plan/status.ts';
import type { ReviewIO } from '../review/review.ts';
import { readJsonFile } from '../state/json-file.ts';
import type { RunContext } from './shared.ts';
import { requireState } from './shared.ts';
import { executeApply, parseStage, planStage, prepareApply, resolveStage, reviewStage, scanStage } from './stages.ts';

export interface GuidedDeps {
  io: ReviewIO;
  createTitleModel: (run: RunContext) => TitleModel;
  createBackends: (run: RunContext) => Backends;
}

/**
 * One command for the whole job. It asks before each of three steps: prepare
 * (scan, parse, resolve, plan), review, and rename. Answering No stops the run
 * and keeps everything saved so far. Answering Yes to the rename question is
 * the owner's consent to change files.
 */
export async function guidedRun(run: RunContext, deps: GuidedDeps): Promise<void> {
  const { io, createTitleModel } = deps;
  const backends = deps.createBackends(run);
  const { logger } = run;

  const hadPlan = (await readJsonFile(run.paths.plan, planSchema)) !== undefined;
  const prepare = await io.confirm(
    'Step 1 of 3, prepare: scan the folder, ask the model for titles, and build the rename plan.\n  The model sees file names only, never paths, and no file changes. Run it now?',
    true,
  );
  if (prepare) {
    await scanStage(run);
    await parseStage(run, createTitleModel(run));
    await resolveStage(run);
    await planStage(run);
  } else if (!hadPlan) {
    logger.info('There is no plan yet, so there is nothing to review. Run this command again and answer Yes.');
    return;
  }

  const waiting = summarizePlan(await requireState(run.paths.plan, planSchema, 'prepare')).awaitingReview;
  let reviewedNow = false;
  if (waiting > 0) {
    if (!(await io.confirm(`Step 2 of 3, review: ${waiting} entries wait for your decision. Review them now?`, true))) {
      logger.info('Stopped before review. Run this command again to continue; nothing was changed.');
      return;
    }
    await reviewStage(run, io);
    reviewedNow = true;
  }

  const plan = await requireState(run.paths.plan, planSchema, 'prepare');
  const approved = approvedEntries(plan).length;
  if (approved === 0) {
    logger.info('No entry is approved, so there is nothing to rename.');
    return;
  }

  const prep = await prepareApply(run, backends);
  if (!reviewedNow) {
    for (const move of prep.moves) {
      io.print(`  ${win32.basename(move.from)}  ->  ${win32.basename(move.to)}`);
    }
  }
  const stillWaiting = summarizePlan(plan).awaitingReview;
  const note = stillWaiting > 0 ? ` ${stillWaiting} entries still wait for review and stay as they are.` : '';
  const rename = await io.confirm(
    `Step 3 of 3, rename: ${prep.moves.length} renames for ${approved} approved entries.${note}\n  Nothing is overwritten, and "undo --yes" reverses every rename. Rename now?`,
    false,
  );
  if (!rename) {
    logger.info('Nothing was renamed. Run this command again when you are ready.');
    return;
  }
  await executeApply(run, prep, backends);
  logger.info('To write the titles into the files, run the tag command. It is a dry run unless you add --yes.');
}
