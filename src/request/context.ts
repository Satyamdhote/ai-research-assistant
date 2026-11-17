import { LIMITS, getRequestDeadlineMs } from "../config.js";
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
//
// Lifecycle: created by answerQuestion(), passed down explicitly, dropped when the request
// ends. Nothing here is stored globally, so one request can never see another's state.
//
// Ownership: this module is the ONLY writer. Everyone else reads the fields below and changes
// state through the three methods, which hold the rules (limits, de-duplication, caps).
export type RequestContext = {
  readonly startedAt: number;
  readonly signal?: AbortSignal; // aborted when the client disconnects
  readonly modelCalls: number; // model calls started so far (changed by countModelCall)
  readonly searchOutcomes: readonly SearchOutcome[]; // what each real search returned (changed by recordSearch)
  readonly observedUrls: ReadonlySet<string>; // normalized URLs that real search results contained (changed by recordSearch)
  /** Milliseconds the CURRENT stage may still use (the analysis reserve is held back while researching). */
  remainingMs(): number;
  /** While true, remainingMs() excludes the time reserved for the analysis stage. */
  readonly reserveActive: boolean;
  /** Counts one more model call and returns its request-wide number. The caller checks the limit first. */
  countModelCall(): number;
  /** Takes one search from the per-request budget. False when none is left. Synchronous on purpose. */
  spendSearch(): boolean;
  /** Records what a real search returned. `urls` must already be normalized. */
  recordSearch(outcome: SearchOutcome, urls: readonly string[]): void;
};

// The part of the context a model call needs.
export type ModelContext = Pick<
  RequestContext,
  "startedAt" | "signal" | "modelCalls" | "remainingMs" | "reserveActive" | "countModelCall"
>;

// The part of the context a tool needs.
export type ToolContext = Pick<RequestContext, "signal" | "remainingMs" | "spendSearch">;

// Only withAnalysisReserved may switch the reserve on or off.
const reserveSwitches = new WeakMap<RequestContext, (on: boolean) => void>();

export function createRequestContext(signal?: AbortSignal): RequestContext {
  const totalMs = getRequestDeadlineMs();
  const startedAt = Date.now();
  const deadlineAt = startedAt + totalMs;
  // Never reserve more than 30% of a (possibly test-shortened) deadline.
  const reserveMs = Math.min(LIMITS.ANALYSIS_RESERVE_MS, Math.floor(totalMs * 0.3));

  let modelCalls = 0;
  let searchesLeft = LIMITS.MAX_SEARCHES_PER_REQUEST;
  let reserveActive = false;
  const searchOutcomes: SearchOutcome[] = [];
  const observedUrls = new Set<string>();

  const ctx: RequestContext = {
    startedAt,
    signal,
    get modelCalls() {
      return modelCalls;
    },
    get searchOutcomes() {
      return searchOutcomes;
    },
    get observedUrls() {
      return observedUrls;
    },
    get reserveActive() {
      return reserveActive;
    },
    remainingMs: () => deadlineAt - Date.now() - (reserveActive ? reserveMs : 0),
    countModelCall: () => ++modelCalls,
    spendSearch() {
      // IMPORTANT: check and decrement stay in one synchronous stretch (no `await`). Tools of one
      // round run in parallel, and this is what stops two of them from both taking the last search.
      // A failed attempt still uses up the budget, so a broken provider can't be retried in a loop.
      if (searchesLeft <= 0) return false;
      searchesLeft -= 1;
      return true;
    },
    recordSearch(outcome, urls) {
      searchOutcomes.push(outcome);
      for (const url of urls) {
        if (observedUrls.size >= LIMITS.MAX_OBSERVED_URLS) break;
        observedUrls.add(url);
      }
    },
  };
  reserveSwitches.set(ctx, (on) => {
    reserveActive = on;
  });
  return ctx;
}

// Runs a stage while keeping the analysis reserve out of its time budget.
export async function withAnalysisReserved<T>(ctx: RequestContext, work: () => Promise<T>): Promise<T> {
  const setReserve = reserveSwitches.get(ctx);
  if (!setReserve) throw new Error("Not a request context");
  setReserve(true);
  try {
    return await work();
  } finally {
    setReserve(false);
  }
}
