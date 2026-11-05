import { LIMITS, getRequestDeadlineMs } from "../config.js";
import type { ToolBudget } from "../tools/index.js";
import type { FailureReason, SearchOutcome } from "../types.js";

// A stage-level failure: the model's output (or the call that should have produced it)
// was unusable. The research stage tolerates these and carries on with honest disclosure.
// Provider errors (401/402/429) and running out of the whole request's time are plain
// Errors instead, so they are never hidden.
export class StageFailure extends Error {
  constructor(public readonly reason: FailureReason) {
    super(`Stage failed: ${reason}`);
  }
}

// Per-request state shared by all agents answering ONE question.
export type RequestContext = {
  startedAt: number;
  modelCalls: number;
  budget: ToolBudget; // the searches-per-question limit, shared by every agent
  searchOutcomes: SearchOutcome[]; // what each real search returned, recorded by the app
  observedUrls: Set<string>; // normalized URLs that real search results actually contained
  signal?: AbortSignal; // aborted when the client disconnects
  /** Milliseconds the CURRENT stage may still use (the analysis reserve is held back while researching). */
  remainingMs(): number;
  /** While true, remainingMs() excludes the time reserved for the analysis stage. */
  reserveActive: boolean;
};

export function createRequestContext(signal?: AbortSignal): RequestContext {
  const totalMs = getRequestDeadlineMs();
  const startedAt = Date.now();
  const deadlineAt = startedAt + totalMs;
  // Never reserve more than 30% of a (possibly test-shortened) deadline.
  const reserveMs = Math.min(LIMITS.ANALYSIS_RESERVE_MS, Math.floor(totalMs * 0.3));
  const ctx: RequestContext = {
    startedAt,
    modelCalls: 0,
    budget: { searchesLeft: LIMITS.MAX_SEARCHES_PER_REQUEST },
    searchOutcomes: [],
    observedUrls: new Set(),
    signal,
    reserveActive: false,
    remainingMs: () => deadlineAt - Date.now() - (ctx.reserveActive ? reserveMs : 0),
  };
  return ctx;
}

// Runs a stage while keeping the analysis reserve out of its time budget.
export async function withAnalysisReserved<T>(ctx: RequestContext, work: () => Promise<T>): Promise<T> {
  ctx.reserveActive = true;
  try {
    return await work();
  } finally {
    ctx.reserveActive = false;
  }
}
