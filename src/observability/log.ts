import { traceEnabled } from "../config.js";
import type {
  AssistantMessage,
  ChatMessage,
  FailureReason,
  ResearchStageStatus,
  Route,
  SearchOutcome,
  Stage,
  ToolCall,
  ToolName,
} from "../types.js";

// Logging. Logs must never contain credentials, model reasoning or user content.
// logStage() only accepts numbers, booleans and fixed word lists, so free text
// (a question, a search query, model output) cannot be passed to it by mistake.

export type FinishReason = "stop" | "length" | "tool_calls" | "other";

export type StageLog = {
  event: "model_call" | "tool_call" | "route" | "stage_failed" | "request_done" | "parse_failed";
  stage?: Stage;
  call?: number;
  finishReason?: FinishReason;
  toolCalls?: number;
  tool?: ToolName | "<invalid>";
  searchOutcomes?: SearchOutcome[];
  route?: Route;
  routeFallback?: boolean;
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
  // Shape of model text that failed to parse: a size and yes/no flags.
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

// ---------------------------------------------------------------------------
// TRACE_AGENTS=1: LOCAL learning aid. It prints real text, so it is the one deliberate
// exception to the rule above. It never prints the API key or hidden reasoning.
// ---------------------------------------------------------------------------
function clip(text: string, max = 1500): string {
  return text.length > max ? `${text.slice(0, max)} ... [${text.length - max} more chars]` : text;
}

export function traceContext(stage: Stage, call: number, messages: ChatMessage[]): void {
  if (!traceEnabled()) return;
  console.log(
    `\n===== ${stage.toUpperCase()} | model call ${call} | context window sent (${messages.length} messages) =====`
  );
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

export function traceReply(stage: Stage, message: AssistantMessage): void {
  if (!traceEnabled()) return;
  const text = typeof message.content === "string" ? message.content : "";
  console.log(`----- ${stage.toUpperCase()} reply -----\n${text ? clip(text) : "(no text: tool request or empty)"}\n`);
}
