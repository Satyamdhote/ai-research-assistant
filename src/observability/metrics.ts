import type { ErrorCode, RequestStats, SearchOutcome } from "../types.js";

// In-memory counters for this server process (Milestone 11). Numbers only: no questions, queries,
// URLs, ids or model text can enter, because the only inputs are fixed words and counts.
// One instance is created per app (createAppServer) and passed in, so nothing here is global
// and every test starts from zero. Counters reset when the process restarts.

// Upper edges of the latency buckets, in milliseconds. Anything slower falls in "over".
const LATENCY_EDGES_MS = [1_000, 5_000, 10_000, 30_000, 60_000, 90_000] as const;

export type MetricsSnapshot = {
  requests: Record<string, number>; // by outcome: "ok" or an ErrorCode
  model_calls: number;
  tool_calls: number;
  searches: Record<string, number>; // by outcome (SEARCH_OK, ...)
  search_retries: number;
  latency_ms: Record<string, number>; // bucket label -> number of requests that finished in it
};

export class Metrics {
  private requests: Record<string, number> = {};
  private modelCalls = 0;
  private toolCalls = 0;
  private searches: Record<string, number> = {};
  private searchRetries = 0;
  private latency: Record<string, number> = {};

  // `stats` is missing for requests that never reached the agents (invalid input, too busy).
  recordRequest(outcome: "ok" | ErrorCode, stats?: RequestStats): void {
    this.requests[outcome] = (this.requests[outcome] ?? 0) + 1;
    if (!stats) return;
    this.modelCalls += stats.modelCalls;
    this.toolCalls += stats.toolCalls;
    this.searchRetries += stats.searchRetries;
    for (const outcome of stats.searchOutcomes as readonly SearchOutcome[]) {
      this.searches[outcome] = (this.searches[outcome] ?? 0) + 1;
    }
    const edge = LATENCY_EDGES_MS.find((limit) => stats.elapsedMs <= limit);
    const label = edge === undefined ? "over" : `le_${edge}`;
    this.latency[label] = (this.latency[label] ?? 0) + 1;
  }

  snapshot(): MetricsSnapshot {
    return {
      requests: { ...this.requests },
      model_calls: this.modelCalls,
      tool_calls: this.toolCalls,
      searches: { ...this.searches },
      search_retries: this.searchRetries,
      latency_ms: { ...this.latency },
    };
  }
}
