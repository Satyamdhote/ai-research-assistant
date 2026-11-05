import { LIMITS, debugEnabled, getOpenRouterConfig } from "../config.js";
import { logStage, traceContext, traceReply, type FinishReason, type StageLog } from "../observability/log.js";
import { StageFailure, type RequestContext } from "../request/context.js";
import type { getToolDefinitions } from "../tools/index.js";
import type { AssistantMessage, ChatMessage, Stage } from "../types.js";

// The only file that talks to OpenRouter. It knows nothing about agents or routes.

type OpenRouterResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: AssistantMessage;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export type ModelCallOptions = {
  stage: Stage;
  tools: ReturnType<typeof getToolDefinitions>;
  maxTokens: number;
};

function toFinishReason(value: unknown): FinishReason {
  return value === "stop" || value === "length" || value === "tool_calls" ? value : "other";
}

// Turns an HTTP status into a fixed phrase. The provider's own error text is not used.
function describeProviderStatus(status: number): string {
  if (status === 401) return "OpenRouter error: authentication failed (401)";
  if (status === 402) return "OpenRouter error: payment required (402)";
  if (status === 429) return "OpenRouter error: rate limited (429), the free daily limit may be used up";
  return `OpenRouter error (${status})`;
}

// One request to the model. Rules, in order:
//  - never start a call after the client left, or with too little time (or too many calls) left
//  - the call may not outlive the time left for the current stage
//  - provider errors (401/402/429/...) stay plain Errors so they are never hidden
//  - network problems and unreadable replies become a StageFailure (an unusable stage output)
export async function callModel(messages: ChatMessage[], options: ModelCallOptions, ctx: RequestContext) {
  if (ctx.signal?.aborted) {
    throw new Error("Request cancelled");
  }
  const remaining = ctx.remainingMs();
  if (remaining < LIMITS.MIN_TIME_TO_START_MS) {
    // While researching, running out of the research budget is a stage failure (analysis
    // still has its reserved time). Otherwise the whole request is out of time.
    throw ctx.reserveActive ? new StageFailure("time_limit") : new Error("Request time limit reached");
  }
  if (ctx.modelCalls >= LIMITS.MAX_MODEL_CALLS_PER_REQUEST) {
    // Same rule as the time limit: while researching, this degrades to a stage failure.
    throw ctx.reserveActive ? new StageFailure("call_limit") : new Error("Model call limit reached");
  }
  ctx.modelCalls += 1;
  const callNumber = ctx.modelCalls;
  traceContext(options.stage, callNumber, messages);

  const { apiKey, model } = getOpenRouterConfig();
  // Never wait longer than a single call is allowed to, or than the stage has left.
  const timeout = AbortSignal.timeout(Math.min(LIMITS.MODEL_TIMEOUT_MS, remaining));

  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout,
      body: JSON.stringify({
        model,
        messages,
        // Only agents that are allowed tools are told about them.
        ...(options.tools.length > 0 ? { tools: options.tools, tool_choice: "auto" } : {}),
        // A practical budget, NOT a guarantee: reasoning tokens count against it too,
        // so a broad question can still be cut off. We check finish_reason later.
        max_tokens: options.maxTokens,
        temperature: 0.2,
        // Never silently fall back to another (possibly paid) provider.
        provider: { allow_fallbacks: false },
      }),
    });
  } catch {
    if (ctx.signal?.aborted) throw new Error("Request cancelled");
    throw new StageFailure("model_error"); // timeout or network error
  }

  if (!response.ok) {
    throw new Error(describeProviderStatus(response.status));
  }

  let data: OpenRouterResponse;
  try {
    data = (await response.json()) as OpenRouterResponse;
  } catch {
    throw new StageFailure("model_error"); // a 200 whose body is not JSON
  }
  const choice = data.choices?.[0];
  if (!choice?.message) {
    throw new StageFailure("model_error");
  }

  traceReply(options.stage, choice.message);

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
