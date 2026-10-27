import { win32 } from 'node:path';
import { approvedEntries } from '../apply/apply.ts';
import type { Backends } from '../tag/backends.ts';
import { planSchema } from '../plan/schemas.ts';
import { summarizePlan } from '../plan/status.ts';
import type { ReviewIO } from '../review/review.ts';
import { readJsonFile } from '../state/json-file.ts';
import type { RunContext } from './shared.ts';
import { requireState } from './shared.ts';
import { isTaggable } from '../tag/tagger.ts';
import { executeApply, prepareApply, tagStage } from './stages.ts';

export interface GuidedDeps {
  io: ReviewIO;
  createBackends: (run: RunContext) => Backends;
  /** What step 1 tells the owner it will do and what it sends out. */
  prepareQuestion: string;
  /** Scan, parse, resolve, and plan. Writes the plan and changes no file. */
  prepare: (run: RunContext) => Promise<void>;
  /** Walks the entries that wait for a decision. */
  review: (run: RunContext, io: ReviewIO) => Promise<unknown>;
}

/**
 * One command for the whole job. It asks before each of four steps: prepare
 * (scan, parse, resolve, plan), review, rename, and tag. Answering No stops
 * the run and keeps everything saved so far. Answering Yes to the rename or
 * the tag question is the owner's consent to change files.
 */
export async function guidedRun(run: RunContext, deps: GuidedDeps): Promise<void> {
  const { io } = deps;
  const backends = deps.createBackends(run);
  const { logger } = run;

  const hadPlan = (await readJsonFile(run.paths.plan, planSchema)) !== undefined;
  const prepare = await io.confirm(deps.prepareQuestion, true);
  if (prepare) {
    await deps.prepare(run);
  } else if (!hadPlan) {
    logger.info('There is no plan yet, so there is nothing to review. Run this command again and answer Yes.');
    return;
  }

  const waiting = summarizePlan(await requireState(run.paths.plan, planSchema, 'prepare')).awaitingReview;
  let reviewedNow = false;
  if (waiting > 0) {
    if (!(await io.confirm(`Step 2 of 4, review: ${waiting} entries wait for your decision. Review them now?`, true))) {
      logger.info('Stopped before review. Run this command again to continue; nothing was changed.');
      return;
    }
    await deps.review(run, io);
    reviewedNow = true;
  }

  const plan = await requireState(run.paths.plan, planSchema, 'prepare');
  const approved = approvedEntries(plan).length;
  if (approved === 0) {
    logger.info('No entry is approved, so there is nothing to rename.');
    await offerTagging(run, deps, backends);
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
    `Step 3 of 4, rename: ${prep.moves.length} renames for ${approved} approved entries.${note}\n  Nothing is overwritten, and "undo --yes" reverses every rename. Rename now?`,
    false,
  );
  if (!rename) {
    logger.info('Nothing was renamed. Run this command again when you are ready.');
    return;
  }
  await executeApply(run, prep, backends);
  await offerTagging(run, deps, backends);
}

/**
 * Step 4: write the titles and details into the files that were renamed. The
 * tag command stays available on its own. Answering Yes is the owner's consent
 * to change the files' tags, as it is for the rename.
 */
async function offerTagging(run: RunContext, deps: GuidedDeps, backends: Backends): Promise<void> {
  const plan = await requireState(run.paths.plan, planSchema, 'prepare');
  const waiting = plan.entries.filter(isTaggable).length;
  if (waiting === 0) {
    return;
  }
  const tag = await deps.io.confirm(
    `Step 4 of 4, tag: write the title and the details into the ${waiting} renamed files, so other players show them too. Plex ignores these tags.\n  Matroska files are edited in place. An MP4, M4V, or MOV file is rewritten through a temporary copy, which takes a while on a network drive. "undo --yes" puts the old tags back. Tag now?`,
    true,
  );
  if (!tag) {
    run.logger.info('Not tagged. Run the tag command when you are ready. It is a dry run unless you add --yes.');
    return;
  }
  await tagStage({ ...run, yes: true }, backends);
}
