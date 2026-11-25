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

// The one list of tool names. ToolName, the tool definitions and the runTool handlers are all
// keyed by it, so a tool added here must be defined and handled (the compiler enforces it).
export const TOOL_NAMES = ["get_current_date", "search_web"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

// What a real web search returned (decided by the application, never by a model).
export type SearchOutcome = "SEARCH_OK" | "SEARCH_OK_NO_RESULTS" | "SEARCH_UNAVAILABLE";

// How well the application could check a finding against what searches really returned.
// Computed by code (src/agents/verify.ts), never by a model.
//   supported:   its URL was returned by a search AND the snippet shares the claim's key terms
//   weak:        its URL was returned, but the snippet barely overlaps the claim (possibly irrelevant)
//   conflicting: another finding on the same subject disagrees (negation or different numbers)
//   unsourced:   no usable source URL (none given, or not returned by any search)
//   unverified:  verification itself failed
export type EvidenceStatus = "supported" | "weak" | "conflicting" | "unsourced" | "unverified";
export type EvidenceItem = { claim: string; source_url: string | null; status: EvidenceStatus };

// Human approval (Milestone 10). The action is created by the application, never by the human.
export type ApprovalAction = { tool: "search_web"; query: string };
export type ApprovalDecision = "approved" | "rejected" | "expired";
export type Approver = (action: ApprovalAction) => Promise<ApprovalDecision>;

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
