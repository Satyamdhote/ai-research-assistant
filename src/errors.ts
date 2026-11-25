import { StageFailure } from "./request/context.js";
import type { ErrorCode, FailureReason } from "./types.js";

// Error taxonomy (Milestone 11). Every failure that can end a request carries one fixed
// ErrorCode. The code is what clients, logs and metrics see; the human-readable message is
// fixed text written by us, never provider text, model output, a stack or a key.

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

const REASON_CODES: Record<FailureReason, ErrorCode> = {
  invalid_notes: "invalid_output",
  truncated: "truncated",
  too_many_tool_rounds: "invalid_output",
  too_many_tool_calls: "invalid_output",
  malformed_tool_call: "invalid_output",
  unexpected_tool_call: "invalid_output",
  model_error: "model_unavailable",
  time_limit: "timeout",
  call_limit: "limit_reached",
};

export function codeOf(error: unknown): ErrorCode {
  if (error instanceof AppError) return error.code;
  if (error instanceof StageFailure) return REASON_CODES[error.reason];
  return "internal";
}

// The status and message the API sends for each code. Statuses and messages are unchanged
// from before Milestone 11 (a 502 stays a 502); the `code` field is the new, finer detail.
const AI_FAILED = "The AI model could not answer. Try again.";
const CLIENT_ERRORS: Record<ErrorCode, { status: number; message: string }> = {
  bad_request: { status: 400, message: "Invalid request" },
  busy: { status: 429, message: "Too many questions in progress. Try again shortly." },
  approval_expired: { status: 410, message: "The approval expired, so the question was stopped. Ask again." },
  auth_failed: { status: 502, message: AI_FAILED },
  payment_required: { status: 502, message: AI_FAILED },
  rate_limited: { status: 502, message: AI_FAILED },
  provider_error: { status: 502, message: AI_FAILED },
  model_unavailable: { status: 502, message: AI_FAILED },
  truncated: { status: 502, message: AI_FAILED },
  invalid_output: { status: 502, message: AI_FAILED },
  timeout: { status: 502, message: AI_FAILED },
  limit_reached: { status: 502, message: AI_FAILED },
  cancelled: { status: 499, message: "Request cancelled" }, // never sent: the client has left
  internal: { status: 502, message: AI_FAILED },
};

export function clientError(code: ErrorCode): { status: number; code: ErrorCode; error: string } {
  const { status, message } = CLIENT_ERRORS[code];
  return { status, code, error: message };
}

export function toClientError(error: unknown) {
  return clientError(codeOf(error));
}
