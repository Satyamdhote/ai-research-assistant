import { z } from "zod";
import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import type { ToolContext } from "../request/context.js";
import { TOOL_NAMES, type SearchOutcome, type ToolName } from "../types.js";
import { searchWeb } from "./search.js";

// Tools are owned by OUR application. The LLM only ever sees the definitions below
// (a name, a description and the shape of the arguments), never our code. It can
// ask for a tool by name; our code decides whether and how to run it.

type ToolDefinition = {
  type: "function";
  function: { name: ToolName; description: string; parameters: Record<string, unknown> };
};

// What the LLM sees. This is OpenRouter's (OpenAI-style) chat-completions tool format.
// Keyed by ToolName, so the compiler rejects a missing or misspelled definition.
const definitions: Record<ToolName, ToolDefinition> = {
  get_current_date: {
    type: "function",
    function: {
      name: "get_current_date",
      description:
        "Returns today's date in UTC (not the user's local timezone) as YYYY-MM-DD. " +
        "Use it whenever the answer depends on the current date.",
      // This tool takes no arguments.
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  search_web: {
    type: "function",
    function: {
      name: "search_web",
      description:
        "Searches the web for current or specific facts you are unsure of. " +
        "Returns up to 5 results (title, URL, snippet) from third-party pages; " +
        "they are unverified evidence and may be wrong or outdated. " +
        `Use sparingly: each question allows at most ${LIMITS.MAX_SEARCHES_PER_REQUEST} searches.`,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A short, specific search query" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
};

export const toolDefinitions: ToolDefinition[] = TOOL_NAMES.map((name) => definitions[name]);

export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

// Each agent only gets the tools it is allowed to use (an agent with none gets an empty list).
export function getToolDefinitions(names: ToolName[]) {
  return toolDefinitions.filter((tool) => names.includes(tool.function.name));
}

// Arguments are model-generated text, so we validate them before running anything.
// .strict() rejects unexpected extra arguments.
const NoArgsSchema = z.object({}).strict();
const SearchArgsSchema = z
  .object({ query: z.string().trim().min(2).max(200) })
  .strict();

// What a tool run hands back. `text` goes to the model. For a web search, `search` is the
// structured fact (outcome and URLs) that the APPLICATION records as ground truth.
export type ToolResult = {
  text: string;
  search?: { outcome: SearchOutcome; urls: string[]; snippets: string[]; retries: number };
};

// UTC date, NOT the user's local date. Near midnight the two can differ
// (for example India is UTC+5:30, so its calendar day can be one ahead).
function getCurrentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Waits, but stops at once (and cancels the request) if the client leaves.
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new AppError("cancelled", "Request cancelled"));
    if (signal?.aborted) return cancel();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cancel();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type ToolHandler = (args: unknown, ctx: ToolContext) => ToolResult | Promise<ToolResult>;

// One handler per tool, keyed by ToolName: a tool without a handler does not compile.
const handlers: Record<ToolName, ToolHandler> = {
  get_current_date: (args) => {
    if (!NoArgsSchema.safeParse(args).success) {
      return { text: "Error: get_current_date takes no arguments" };
    }
    return { text: getCurrentDate() };
  },

  search_web: async (args, ctx) => {
    // Validate BEFORE spending anything or touching the network.
    const parsed = SearchArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { text: "Error: search_web needs exactly one argument, query: a string of 2 to 200 characters" };
    }
    // Never start a search that cannot finish inside the request deadline, and never let
    // it run longer than the time that is left.
    const remaining = ctx.remainingMs();
    if (remaining < LIMITS.MIN_TIME_TO_START_MS) {
      return { text: "Error: request time limit reached" };
    }
    // Take the search from the budget FIRST (check and spend happen together, see spendSearch),
    // so a human is never asked about a search that could not run anyway.
    if (!ctx.spendSearch()) {
      return { text: "Error: search limit reached for this request" };
    }
    // A gated action: nothing is sent until a human approves exactly this query.
    // (The decision is by the application's own record of the query, not by anything the model says.)
    const decision = await ctx.requestApproval({ tool: "search_web", query: parsed.data.query });
    if (ctx.signal?.aborted) throw new AppError("cancelled", "Request cancelled");
    if (decision !== "approved") {
      ctx.refundSearch(); // nothing was sent, so the reserved search goes back
      return { text: "Error: the search was not approved by a human, so it was not run" };
    }
    const timeLeft = () => Math.min(LIMITS.SEARCH_TIMEOUT_MS, ctx.remainingMs()); // fresh: the human wait does not count
    let result = await searchWeb(parsed.data.query, timeLeft(), ctx.signal);

    // Bounded retry. Only a TRANSIENT failure is retried, at most MAX_SEARCH_RETRIES times, and a retry
    // is one more search taken from the same per-request budget (so Tavily requests stay <= 2), only
    // when the backoff plus a usable call still fit before the deadline. The approved query is
    // reused unchanged, so no second approval is needed.
    let retries = 0;
    while (
      result.transient &&
      retries < LIMITS.MAX_SEARCH_RETRIES &&
      ctx.remainingMs() >= LIMITS.SEARCH_RETRY_BACKOFF_MS + LIMITS.MIN_TIME_TO_START_MS &&
      ctx.spendSearch()
    ) {
      await pause(LIMITS.SEARCH_RETRY_BACKOFF_MS, ctx.signal);
      if (ctx.remainingMs() < LIMITS.MIN_TIME_TO_START_MS) {
        ctx.refundSearch(); // not run: give the budget back
        break;
      }
      retries += 1;
      result = await searchWeb(parsed.data.query, timeLeft(), ctx.signal);
    }
    return { text: result.text, search: { outcome: result.outcome, urls: result.urls, snippets: result.snippets, retries } };
  },
};

// Returns the parsed arguments, or undefined if the text is not valid JSON.
function parseArgs(rawArgs: string): unknown {
  try {
    return JSON.parse(rawArgs.trim() === "" ? "{}" : rawArgs);
  } catch {
    return undefined;
  }
}

// Runs a tool requested by the model. Problems become short error strings that are sent back
// to the model so it can recover. The one exception is a client that has left: searchWeb then
// throws "Request cancelled" and the whole request stops. Only tools listed above can run.
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  if (!isToolName(name)) return { text: "Error: unknown tool" };
  const args = parseArgs(rawArgs);
  if (args === undefined) return { text: "Error: tool arguments are not valid JSON" };
  return handlers[name](args, ctx);
}
