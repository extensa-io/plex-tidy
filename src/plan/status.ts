import { planStatuses, type Plan, type PlanStatus } from './schemas.ts';

export interface PlanSummary {
  total: number;
  byStatus: Record<PlanStatus, number>;
  collisions: number;
  lowConfidence: number;
  /** Open entries: waiting for a decision in review. */
  awaitingReview: number;
}

export function summarizePlan(plan: Plan): PlanSummary {
  const byStatus = Object.fromEntries(planStatuses.map((status) => [status, 0])) as Record<PlanStatus, number>;
  for (const entry of plan.entries) {
    byStatus[entry.status] += 1;
  }
  return {
    total: plan.entries.length,
    byStatus,
    collisions: plan.entries.filter((entry) => entry.collision).length,
    lowConfidence: plan.entries.filter((entry) => entry.confidence === 'low' && entry.status !== 'skipped').length,
    awaitingReview: plan.entries.filter(isOpenForReview).length,
  };
}

/** An entry waits for the owner when it is pending, or was skipped only because no title was found. */
export function isOpenForReview(entry: Plan['entries'][number]): boolean {
  return entry.status === 'pending' || (entry.status === 'skipped' && entry.reason === 'no-title');
}
