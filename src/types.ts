// Small shared types. They hold no logic, so any module can import them without
// creating a dependency cycle.

export type Stage = "supervisor" | "research" | "analysis";
export type Route = "analysis_only" | "research_then_analysis";

// Why a stage failed. Fixed words only (they are written to logs).
export type FailureReason =
  | "invalid_notes"
  | "truncated"
  | "too_many_tool_rounds"
  | "too_many_tool_calls"
  | "malformed_tool_call"
  | "unexpected_tool_call"
  | "model_error"
  | "time_limit"
  | "call_limit";

export type ResearchStageStatus = "not_needed" | "completed" | `failed:${FailureReason}`;

export type ToolName = "get_current_date" | "search_web";

// What a real web search returned (decided by the application, never by a model).
export type SearchOutcome = "SEARCH_OK" | "SEARCH_OK_NO_RESULTS" | "SEARCH_UNAVAILABLE";

// OpenRouter chat messages. The assistant message is kept as an open object on purpose:
// when the model asks for a tool we must send the WHOLE message back unchanged
// (including fields such as reasoning_details), so we never rebuild or trim it.
export type ToolCall = { id: string; function: { name: string; arguments: string } };
export type AssistantMessage = {
  content?: unknown;
  tool_calls?: ToolCall[];
  [key: string]: unknown;
};
export type ChatMessage = Record<string, unknown>;
