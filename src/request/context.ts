import { randomUUID } from "node:crypto";
import { LIMITS, getRequestDeadlineMs } from "../config.js";
import type { ApprovalAction, ApprovalDecision, Approver, FailureReason, SearchOutcome } from "../types.js";

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
  readonly requestId: string; // opaque id for log correlation; carries no user data
  readonly startedAt: number;
  readonly signal?: AbortSignal; // aborted when the client disconnects
  readonly modelCalls: number; // model calls started so far (changed by countModelCall)
  readonly toolCalls: number; // tool calls run so far (changed by countToolCall)
  readonly searchRetries: number; // search retries made so far (changed by recordSearch)
  readonly searchOutcomes: readonly SearchOutcome[]; // what each real search returned (changed by recordSearch)
  readonly observedUrls: ReadonlySet<string>; // normalized URLs that real search results contained (changed by recordSearch)
  readonly observedSnippets: ReadonlyMap<string, string>; // normalized URL -> search snippet text (changed by recordSearch)
  /** Milliseconds the CURRENT stage may still use (the analysis reserve is held back while researching). */
  remainingMs(): number;
  /** While true, remainingMs() excludes the time reserved for the analysis stage. */
  readonly reserveActive: boolean;
  /** Counts one more model call and returns its request-wide number. The caller checks the limit first. */
  countModelCall(): number;
  /** Counts one more tool call. */
  countToolCall(): void;
  /** Takes one search from the per-request budget. False when none is left. Synchronous on purpose. */
  spendSearch(): boolean;
  /** Gives back a search taken by spendSearch that was never run (for example a human said no). */
  refundSearch(): void;
  /**
   * Asks a human to approve a gated action and waits for the answer. The time spent waiting is
   * NOT charged to the request deadline (a person is slower than a machine); the approval's own
   * expiry bounds the wait. Without an approver (the default) nothing is gated: "approved".
   */
  requestApproval(action: ApprovalAction): Promise<ApprovalDecision>;
  /** Records what a real search returned. `urls` must already be normalized; `snippets` (optional) is parallel to `urls`; `retries` is how many retries it took. */
  recordSearch(outcome: SearchOutcome, urls: readonly string[], snippets?: readonly string[], retries?: number): void;
};

// The part of the context a model call needs.
export type ModelContext = Pick<
  RequestContext,
  "requestId" | "startedAt" | "signal" | "modelCalls" | "remainingMs" | "reserveActive" | "countModelCall"
>;

// The part of the context a tool needs.
export type ToolContext = Pick<RequestContext, "signal" | "remainingMs" | "spendSearch" | "refundSearch" | "requestApproval">;

// Only withAnalysisReserved may switch the reserve on or off.
const reserveSwitches = new WeakMap<RequestContext, (on: boolean) => void>();

export function createRequestContext(signal?: AbortSignal, approver?: Approver, requestId: string = randomUUID()): RequestContext {
  const totalMs = getRequestDeadlineMs();
  const startedAt = Date.now();
  let deadlineAt = startedAt + totalMs; // only requestApproval moves it (human wait time is paused)
  // Never reserve more than 30% of a (possibly test-shortened) deadline.
  const reserveMs = Math.min(LIMITS.ANALYSIS_RESERVE_MS, Math.floor(totalMs * 0.3));

  let modelCalls = 0;
  let toolCalls = 0;
  let searchRetries = 0;
  let searchesLeft = LIMITS.MAX_SEARCHES_PER_REQUEST;
  let reserveActive = false;
  const searchOutcomes: SearchOutcome[] = [];
  const observedUrls = new Set<string>();
  const observedSnippets = new Map<string, string>();

  const ctx: RequestContext = {
    requestId,
    startedAt,
    signal,
    get modelCalls() {
      return modelCalls;
    },
    get toolCalls() {
      return toolCalls;
    },
    get searchRetries() {
      return searchRetries;
    },
    get searchOutcomes() {
      return searchOutcomes;
    },
    get observedUrls() {
      return observedUrls;
    },
    get observedSnippets() {
      return observedSnippets;
    },
    get reserveActive() {
      return reserveActive;
    },
    remainingMs: () => deadlineAt - Date.now() - (reserveActive ? reserveMs : 0),
    countModelCall: () => ++modelCalls,
    countToolCall() {
      toolCalls += 1;
    },
    async requestApproval(action) {
      if (!approver) return "approved";
      const waitStart = Date.now();
      try {
        return await approver(action);
      } finally {
        deadlineAt += Date.now() - waitStart;
      }
    },
    spendSearch() {
      // IMPORTANT: check and decrement stay in one synchronous stretch (no `await`). Tools of one
      // round run in parallel, and this is what stops two of them from both taking the last search.
      // A failed attempt still uses up the budget, so a broken provider can't be retried in a loop.
      if (searchesLeft <= 0) return false;
      searchesLeft -= 1;
      return true;
    },
    refundSearch() {
      // Never above the per-request maximum, so a refund can not create budget out of nothing.
      if (searchesLeft < LIMITS.MAX_SEARCHES_PER_REQUEST) searchesLeft += 1;
    },
    recordSearch(outcome, urls, snippets = [], retries = 0) {
      searchOutcomes.push(outcome);
      searchRetries += retries;
      urls.forEach((url, i) => {
        if (observedUrls.size >= LIMITS.MAX_OBSERVED_URLS && !observedUrls.has(url)) return;
        observedUrls.add(url);
        const snippet = snippets[i];
        // The first snippet seen for a URL wins; later searches cannot overwrite it.
        if (snippet !== undefined && !observedSnippets.has(url)) {
          observedSnippets.set(url, snippet.slice(0, LIMITS.MAX_STORED_SNIPPET_CHARS));
        }
      });
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
