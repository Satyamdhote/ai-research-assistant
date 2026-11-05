import "dotenv/config";
import process from "process";
import { z } from "zod";
import { readSearchResult, type SearchOutcome } from "./search.js";
import {
  createToolBudget,
  getToolDefinitions,
  isToolName,
  runTool,
  type ToolBudget,
  type ToolName,
} from "./tools.js";

const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL;

if (!apiKey || !model) {
  throw new Error("Missing OpenRouter configuration in .env");
}

// Cost safety: refuse to start with anything that is not an explicitly free model.
if (!model.endsWith(":free")) {
  throw new Error(`OPENROUTER_MODEL must end with ":free" (got "${model}")`);
}

// ---------------------------------------------------------------------------
// Limits. Together they make sure one question can never run (or cost) forever.
// ---------------------------------------------------------------------------
const MAX_TOOL_CALLS_PER_ROUND = 3; // an agent may request at most 3 tools at once
const MAX_MODEL_CALLS_PER_REQUEST = 6; // backstop across ALL agents for one question
const DEFAULT_DEADLINE_MS = 90_000; // one shared time limit for the whole question
const MIN_TIME_TO_START_MS = 1_000; // never start a network call with less than this left
const MODEL_TIMEOUT_MS = 30_000; // longest a single model call may take

// ---------------------------------------------------------------------------
// Logging. Logs must never contain credentials, model reasoning or user content.
// logStage() only accepts numbers, booleans and fixed word lists, so free text
// (a question, a search query, model output) cannot be passed to it by mistake.
// ---------------------------------------------------------------------------
export type Stage = "supervisor" | "research" | "analysis";
export type Route = "analysis_only" | "research_then_analysis";

// Why a stage failed. Fixed words only.
export type FailureReason =
  | "invalid_notes"
  | "truncated"
  | "too_many_tool_rounds"
  | "too_many_tool_calls"
  | "malformed_tool_call"
  | "unexpected_tool_call"
  | "model_error";

export type ResearchStageStatus = "not_needed" | "completed" | `failed:${FailureReason}`;

type FinishReason = "stop" | "length" | "tool_calls" | "other";

export type StageLog = {
  event: "model_call" | "tool_call" | "route" | "stage_failed" | "request_done" | "parse_failed";
  stage?: Stage;
  call?: number;
  finishReason?: FinishReason;
  toolCalls?: number;
  tool?: ToolName | "<invalid>";
  searchOutcomes?: SearchOutcome[];
  route?: Route;
  researchStage?: ResearchStageStatus;
  reason?: FailureReason;
  modelCalls?: number;
  elapsedMs?: number;
  // The fields below are only filled in when DEBUG_LLM=1, and are still only
  // sizes, counts and yes/no flags, never text.
  remainingMs?: number;
  contentChars?: number;
  hasReasoning?: boolean;
  messagesSystem?: number;
  messagesUser?: number;
  messagesAssistant?: number;
  messagesTool?: number;
  promptTokens?: number;
  completionTokens?: number;
  // Shape of model text that failed to parse (DEBUG_LLM=1 only): yes/no flags and a size.
  textChars?: number;
  startsWithBrace?: boolean;
  endsWithBrace?: boolean;
  hasBraces?: boolean;
  hasFence?: boolean;
};

export function logStage(fields: StageLog): void {
  const parts = Object.entries(fields).map(([key, value]) =>
    Array.isArray(value) ? `${key}=${value.join(",") || "none"}` : `${key}=${String(value)}`
  );
  console.log("[agent]", parts.join(" "));
}

// Read at call time so it can be switched on without code changes.
export function debugEnabled(): boolean {
  return process.env.DEBUG_LLM === "1";
}

// LOCAL LEARNING AID, off by default. TRACE_AGENTS=1 prints the actual text each agent
// receives and returns. This deliberately breaks the "no content in logs" rule, so use it
// only on your own machine and never share or keep these logs. It never prints the API key
// or the model's hidden reasoning.
function traceEnabled(): boolean {
  return process.env.TRACE_AGENTS === "1";
}

function clip(text: string, max = 1500): string {
  return text.length > max ? `${text.slice(0, max)} ... [${text.length - max} more chars]` : text;
}

function traceContext(stage: Stage, call: number, messages: ChatMessage[]): void {
  console.log(`\n===== ${stage.toUpperCase()} | model call ${call} | context window sent (${messages.length} messages) =====`);
  for (const m of messages) {
    const role = String(m.role);
    if (role === "system") {
      const content = String(m.content ?? "");
      console.log(`[system] (role prompt, ${content.length} chars) ${clip(content.split("\n")[0] ?? "", 120)}`);
    } else if (role === "assistant" && Array.isArray(m.tool_calls)) {
      const calls = (m.tool_calls as ToolCall[])
        .map((t) => `${t.function?.name}(${t.function?.arguments})`)
        .join(", ");
      console.log(`[assistant asked for tools] ${calls}`);
    } else {
      console.log(`[${role}] ${clip(String(m.content ?? ""))}`);
    }
  }
}

function traceReply(stage: Stage, message: AssistantMessage): void {
  const text = typeof message.content === "string" ? message.content : "";
  console.log(`----- ${stage.toUpperCase()} reply -----\n${text ? clip(text) : "(no text: tool request or empty)"}\n`);
}

function toFinishReason(value: unknown): FinishReason {
  return value === "stop" || value === "length" || value === "tool_calls" ? value : "other";
}

// ---------------------------------------------------------------------------
// Types for talking to OpenRouter.
// ---------------------------------------------------------------------------
type ToolCall = { id: string; function: { name: string; arguments: string } };

// The assistant's reply. It is kept as an open object on purpose: when the model asks
// for a tool we must send the WHOLE message back unchanged (including fields such as
// reasoning_details that reasoning models need), so we never rebuild or trim it.
type AssistantMessage = {
  content?: string | null;
  tool_calls?: ToolCall[];
  [key: string]: unknown;
};

type ChatMessage = Record<string, unknown>;

type OpenRouterResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: AssistantMessage;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

// A stage-level failure: the model's output for that stage was unusable.
// (Provider errors and running out of time are plain Errors instead.)
export class StageFailure extends Error {
  constructor(public readonly reason: FailureReason) {
    super(`Stage failed: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Per-request state shared by all agents answering ONE question.
// ---------------------------------------------------------------------------
export type RequestContext = {
  startedAt: number;
  modelCalls: number;
  budget: ToolBudget; // the 2-searches-per-question limit, shared by every agent
  searchOutcomes: SearchOutcome[]; // what each real search returned, recorded by the app
  observedUrls: Set<string>; // URLs that real search results actually contained
  remainingMs(): number;
};

export function createRequestContext(): RequestContext {
  // REQUEST_DEADLINE_MS exists only so tests can shorten the limit.
  const override = Number(process.env.REQUEST_DEADLINE_MS);
  const totalMs = Number.isFinite(override) && override >= 1_000 ? override : DEFAULT_DEADLINE_MS;
  const startedAt = Date.now();
  const deadlineAt = startedAt + totalMs;
  return {
    startedAt,
    modelCalls: 0,
    budget: createToolBudget(),
    searchOutcomes: [],
    observedUrls: new Set(),
    remainingMs: () => deadlineAt - Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Parsing and validating model output.
// ---------------------------------------------------------------------------

// The shape we expect the model to return. A schema describes the data;
// Zod checks real data against it at runtime (TypeScript types vanish after compiling).
// .strict() rejects unexpected extra fields instead of silently dropping them.
const ResearchSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    key_findings: z.array(z.string()),
    risks: z.array(z.string()),
    conclusion: z.string(),
  })
  .strict();

// The TypeScript type is generated from the schema, so they can never disagree.
export type ResearchResult = z.infer<typeof ResearchSchema>;

// Models sometimes wrap JSON in ```json fences or add a sentence around it, even when
// told not to. We try the text as it is, then the part between the first "{" and the
// last "}". The strict Zod schemas still check whatever we get. Throws a fixed message
// (never the raw text).
export function parseJsonText(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to the second attempt
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // fall through to the failure below
    }
  }
  if (debugEnabled()) {
    // Only the shape of the text, never the text itself.
    logStage({
      event: "parse_failed",
      textChars: text.length,
      startsWithBrace: cleaned.startsWith("{"),
      endsWithBrace: cleaned.endsWith("}"),
      hasBraces: start !== -1 && end > start,
      hasFence: text.includes("```"),
    });
  }
  throw new Error("Model output is not valid JSON");
}

// Describes validation problems using only field paths and error codes, never the
// model's own text (messages can echo keys or values from the output).
export function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
    .join("; ");
}

// Turns the model's raw text into a validated object, or throws.
// Error messages never include the raw model text (it must not reach clients or logs).
export function parseResearch(text: string): ResearchResult {
  // Layer 1: is it JSON at all? Layer 2: is it the right shape?
  const result = ResearchSchema.safeParse(parseJsonText(text));
  if (!result.success) {
    throw new Error(`Model output failed schema validation: ${describeIssues(result.error)}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// One request to the model.
// ---------------------------------------------------------------------------
type ModelCallOptions = {
  stage: Stage;
  tools: ReturnType<typeof getToolDefinitions>;
  maxTokens: number;
};

// Turns an HTTP status into a fixed phrase. The provider's own error text is not used.
function describeProviderStatus(status: number): string {
  if (status === 401) return "OpenRouter error: authentication failed (401)";
  if (status === 402) return "OpenRouter error: payment required (402)";
  if (status === 429) return "OpenRouter error: rate limited (429), the free daily limit may be used up";
  return `OpenRouter error (${status})`;
}

async function callModel(messages: ChatMessage[], options: ModelCallOptions, ctx: RequestContext) {
  // Checked right before the network call: out of time, or too many calls already.
  const remaining = ctx.remainingMs();
  if (remaining < MIN_TIME_TO_START_MS) {
    throw new Error("Request time limit reached");
  }
  if (ctx.modelCalls >= MAX_MODEL_CALLS_PER_REQUEST) {
    throw new Error("Model call limit reached");
  }
  ctx.modelCalls += 1;
  const callNumber = ctx.modelCalls;
  if (traceEnabled()) traceContext(options.stage, callNumber, messages);

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    // Never wait longer than a single call is allowed to, or than the request has left.
    signal: AbortSignal.timeout(Math.min(MODEL_TIMEOUT_MS, remaining)),
    body: JSON.stringify({
      model,
      messages,
      // Only agents that are allowed tools are told about them.
      ...(options.tools.length > 0 ? { tools: options.tools, tool_choice: "auto" } : {}),
      // A practical budget, NOT a guarantee: reasoning tokens count against it too,
      // so a broad question can still be cut off. We check finish_reason below.
      max_tokens: options.maxTokens,
      temperature: 0.2,
      // Never silently fall back to another (possibly paid) provider.
      provider: { allow_fallbacks: false },
    }),
  });

  if (!response.ok) {
    throw new Error(describeProviderStatus(response.status));
  }

  const data = (await response.json()) as OpenRouterResponse;
  const choice = data.choices?.[0];
  if (!choice?.message) {
    throw new StageFailure("model_error");
  }

  if (traceEnabled()) traceReply(options.stage, choice.message);

  // One short, text-free line per model call.
  const line: StageLog = {
    event: "model_call",
    stage: options.stage,
    call: callNumber,
    finishReason: toFinishReason(choice.finish_reason),
    toolCalls: choice.message.tool_calls?.length ?? 0,
    elapsedMs: Date.now() - ctx.startedAt,
  };
  if (debugEnabled()) {
    // Structure only: sizes, counts and yes/no flags. Never any text.
    const count = (role: string) => messages.filter((m) => m.role === role).length;
    line.remainingMs = ctx.remainingMs();
    line.contentChars = typeof choice.message.content === "string" ? choice.message.content.length : 0;
    line.hasReasoning = "reasoning" in choice.message || "reasoning_details" in choice.message;
    line.messagesSystem = count("system");
    line.messagesUser = count("user");
    line.messagesAssistant = count("assistant");
    line.messagesTool = count("tool");
    if (typeof data.usage?.prompt_tokens === "number") line.promptTokens = data.usage.prompt_tokens;
    if (typeof data.usage?.completion_tokens === "number") {
      line.completionTokens = data.usage.completion_tokens;
    }
  }
  logStage(line);

  return { finish_reason: choice.finish_reason, message: choice.message };
}

// ---------------------------------------------------------------------------
// One agent = a role prompt + the tools it may use + a bounded loop.
// ---------------------------------------------------------------------------
export type AgentConfig = {
  stage: Stage;
  system: string; // the agent's role prompt
  user: string; // what the orchestrator wants it to work on
  toolNames: ToolName[]; // [] means this agent gets no tools at all
  maxToolRounds: number; // how many times it may ask for tools; model calls = rounds + 1
  maxTokens: number;
};

// Runs one agent and returns its final text. The model may ask for tools first; we run
// them and send the results back, but only up to maxToolRounds times.
export async function runAgent(config: AgentConfig, ctx: RequestContext): Promise<string> {
  const allowed = new Set<string>(config.toolNames);
  const tools = getToolDefinitions(config.toolNames);
  const messages: ChatMessage[] = [
    { role: "system", content: config.system },
    { role: "user", content: config.user },
  ];

  // The last allowed call must produce the final answer, not another tool request.
  const maxCalls = config.maxToolRounds + 1;

  for (let call = 1; call <= maxCalls; call++) {
    const { finish_reason, message } = await callModel(
      messages,
      { stage: config.stage, tools, maxTokens: config.maxTokens },
      ctx
    );
    const toolCalls = message.tool_calls;

    if (toolCalls && toolCalls.length > 0) {
      // Checks come BEFORE anything runs or is added to the history. Either we
      // handle every requested call or we fail, never half of them.
      if (allowed.size === 0) {
        throw new StageFailure("unexpected_tool_call");
      }
      if (call === maxCalls) {
        throw new StageFailure("too_many_tool_rounds");
      }
      if (toolCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
        throw new StageFailure("too_many_tool_calls");
      }
      for (const toolCall of toolCalls) {
        if (typeof toolCall?.id !== "string" || typeof toolCall.function?.name !== "string") {
          throw new StageFailure("malformed_tool_call");
        }
      }

      // 1. Keep the model's complete request in the history, exactly as received.
      messages.push(message);

      // 2. Our code runs each tool, and every tool_call_id gets exactly one result.
      for (const toolCall of toolCalls) {
        const name = toolCall.function.name;
        const result =
          isToolName(name) && allowed.has(name)
            ? await runTool(name, String(toolCall.function.arguments ?? ""), ctx.budget, ctx)
            : "Error: unknown tool"; // not allowed for this agent: treated as if it does not exist

        // The APPLICATION records what really happened (never the model's own claim).
        const search = name === "search_web" ? readSearchResult(result) : undefined;
        if (search) {
          ctx.searchOutcomes.push(search.outcome);
          for (const url of search.urls) ctx.observedUrls.add(url);
        }
        logStage({
          event: "tool_call",
          stage: config.stage,
          call: ctx.modelCalls, // the request-wide number of the model call that asked for this tool
          tool: isToolName(name) ? name : "<invalid>",
          ...(search ? { searchOutcomes: [search.outcome] } : {}),
        });

        messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
      }
      // 3. Loop: the model now sees the results and continues.
      continue;
    }

    // No tool request: this is the agent's final answer.
    // "length" means the model hit max_tokens: any JSON would be cut off and invalid.
    if (finish_reason === "length") {
      throw new StageFailure("truncated");
    }
    const answer = message.content;
    if (!answer) {
      throw new StageFailure("model_error");
    }
    return answer;
  }

  throw new StageFailure("too_many_tool_rounds");
}
