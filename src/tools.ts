import { z } from "zod";
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
        "Use sparingly: each question allows at most 2 searches.",
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

// Arguments are model-generated text, so we validate them before running anything.
// .strict() rejects unexpected extra arguments.
const NoArgsSchema = z.object({}).strict();
const SearchArgsSchema = z
  .object({ query: z.string().trim().min(2).max(200) })
  .strict();

// Searches cost API credits, so each /ask request gets a small budget.
const MAX_SEARCHES_PER_REQUEST = 2;
export type ToolBudget = { searchesLeft: number };
export function createToolBudget(): ToolBudget {
  return { searchesLeft: MAX_SEARCHES_PER_REQUEST };
}

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

// Runs a tool requested by the model and returns the result as text.
// It never throws: problems become short error strings that are sent back to the
// model so it can recover. Only tools listed here can ever run.
export async function runTool(
  name: string,
  rawArgs: string,
  budget: ToolBudget
): Promise<string> {
  if (name === "get_current_date") {
    const args = parseArgs(rawArgs);
    if (args === undefined) return "Error: tool arguments are not valid JSON";
    if (!NoArgsSchema.safeParse(args).success) {
      return "Error: get_current_date takes no arguments";
    }
    return getCurrentDate();
  }

  if (name === "search_web") {
    const args = parseArgs(rawArgs);
    if (args === undefined) return "Error: tool arguments are not valid JSON";
    // Validate BEFORE spending anything or touching the network.
    const parsed = SearchArgsSchema.safeParse(args);
    if (!parsed.success) {
      return "Error: search_web needs exactly one argument, query: a string of 2 to 200 characters";
    }
    if (budget.searchesLeft <= 0) {
      return "Error: search limit reached for this request";
    }
    // A failed attempt still uses up the budget, so a broken provider can't be retried in a loop.
    budget.searchesLeft -= 1;
    return searchWeb(parsed.data.query);
  }

  return "Error: unknown tool";
}
