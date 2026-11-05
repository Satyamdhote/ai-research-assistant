// Every environment variable and every limit lives here, so there is one place to look.
// Nothing runs when this file is imported; values are read when a function is called.
// (dotenv is loaded by the entry points, src/index.ts and scripts/probe-llm.ts.)

// Limits. Together they make sure one question can never run (or cost) forever.
export const LIMITS = {
  MAX_TOOL_CALLS_PER_ROUND: 3, // an agent may request at most 3 tools at once
  MAX_MODEL_CALLS_PER_REQUEST: 6, // backstop across ALL agents for one question
  MAX_SEARCHES_PER_REQUEST: 2, // each search costs a Tavily credit
  DEFAULT_DEADLINE_MS: 90_000, // one shared time limit for the whole question
  ANALYSIS_RESERVE_MS: 25_000, // time kept back so research can never starve the analysis
  MIN_TIME_TO_START_MS: 1_000, // never start a network call with less than this left
  MODEL_TIMEOUT_MS: 30_000, // longest a single model call may take
  SEARCH_TIMEOUT_MS: 10_000, // longest a single search may take
  MAX_CONCURRENT_REQUESTS: 2, // questions answered at the same time (free quota is small)
  MAX_BODY_BYTES: 10_000, // a question should never be bigger than this
} as const;

// Reads the OpenRouter settings and refuses anything that is not an explicitly free model.
export function getOpenRouterConfig(): { apiKey: string; model: string } {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  if (!apiKey || !model) {
    throw new Error("Missing OpenRouter configuration in .env");
  }
  // Cost safety: never use a model that is not explicitly free.
  if (!model.endsWith(":free")) {
    throw new Error(`OPENROUTER_MODEL must end with ":free" (got "${model}")`);
  }
  return { apiKey, model };
}

export function getPort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === "") return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535 (got "${raw}")`);
  }
  return port;
}

// REQUEST_DEADLINE_MS exists only so tests can shorten the limit.
export function getRequestDeadlineMs(): number {
  const override = Number(process.env.REQUEST_DEADLINE_MS);
  return Number.isFinite(override) && override >= 1_000 ? override : LIMITS.DEFAULT_DEADLINE_MS;
}

// DEBUG_LLM=1 adds structure-only detail to logs (sizes, counts, yes/no flags; never text).
export function debugEnabled(): boolean {
  return process.env.DEBUG_LLM === "1";
}

// TRACE_AGENTS=1 prints the actual text of each agent's context window and reply. It is a
// local learning aid that breaks the "no content in logs" rule, so it is refused when
// NODE_ENV=production.
export function traceEnabled(): boolean {
  return process.env.TRACE_AGENTS === "1" && process.env.NODE_ENV !== "production";
}
