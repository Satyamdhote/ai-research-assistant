import { z } from "zod";
import { LIMITS } from "../config.js";
import type { SearchOutcome, ToolName } from "../types.js";
import { searchWeb } from "./search.js";

// Tools are owned by OUR application. The LLM only ever sees the definitions below
// (a name, a description and the shape of the arguments), never our code. It can
// ask for a tool by name; our code decides whether and how to run it.

// What the LLM sees. This is OpenRouter's (OpenAI-style) chat-completions tool format.
export const toolDefinitions = [
  {
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
  {
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
];

// Derived from the definitions above, so the list of valid names can't drift from them.
export function isToolName(name: string): name is ToolName {
  return toolDefinitions.some((tool) => tool.function.name === name);
}

// Each agent only gets the tools it is allowed to use (an agent with none gets an empty list).
export function getToolDefinitions(names: ToolName[]) {
  return toolDefinitions.filter((tool) => names.includes(tool.function.name as ToolName));
}

// Arguments are model-generated text, so we validate them before running anything.
// .strict() rejects unexpected extra arguments.
const NoArgsSchema = z.object({}).strict();
const SearchArgsSchema = z
  .object({ query: z.string().trim().min(2).max(200) })
  .strict();

// Searches cost API credits, so each /ask request gets a small budget.
// (The budget itself is created per request in request/context.ts.)
export type ToolBudget = { searchesLeft: number };

// What a tool run hands back. `text` goes to the model. For a web search, `search` is the
// structured fact (outcome and URLs) that the APPLICATION records as ground truth.
export type ToolResult = {
  text: string;
  search?: { outcome: SearchOutcome; urls: string[] };
};

// The part of the request state a tool needs.
export type ToolContext = {
  budget: ToolBudget;
  remainingMs(): number;
  signal?: AbortSignal;
};

// UTC date, NOT the user's local date. Near midnight the two can differ
// (for example India is UTC+5:30, so its calendar day can be one ahead).
function getCurrentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// Returns the parsed arguments, or undefined if the text is not valid JSON.
function parseArgs(rawArgs: string): unknown {
  try {
    return JSON.parse(rawArgs.trim() === "" ? "{}" : rawArgs);
  } catch {
    return undefined;
  }
}

// Runs a tool requested by the model. It never throws: problems become short error
// strings that are sent back to the model so it can recover. Only tools listed here can run.
export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  if (name === "get_current_date") {
    const args = parseArgs(rawArgs);
    if (args === undefined) return { text: "Error: tool arguments are not valid JSON" };
    if (!NoArgsSchema.safeParse(args).success) {
      return { text: "Error: get_current_date takes no arguments" };
    }
    return { text: getCurrentDate() };
  }

  if (name === "search_web") {
    const args = parseArgs(rawArgs);
    if (args === undefined) return { text: "Error: tool arguments are not valid JSON" };
    // Validate BEFORE spending anything or touching the network.
    const parsed = SearchArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { text: "Error: search_web needs exactly one argument, query: a string of 2 to 200 characters" };
    }
    if (ctx.budget.searchesLeft <= 0) {
      return { text: "Error: search limit reached for this request" };
    }
    // Never start a search that cannot finish inside the request deadline, and never let
    // it run longer than the time that is left.
    const remaining = ctx.remainingMs();
    if (remaining < LIMITS.MIN_TIME_TO_START_MS) {
      return { text: "Error: request time limit reached" };
    }
    // A failed attempt still uses up the budget, so a broken provider can't be retried in a loop.
    ctx.budget.searchesLeft -= 1;
    const result = await searchWeb(
      parsed.data.query,
      Math.min(LIMITS.SEARCH_TIMEOUT_MS, remaining),
      ctx.signal
    );
    return { text: result.text, search: { outcome: result.outcome, urls: result.urls } };
  }

  return { text: "Error: unknown tool" };
}
