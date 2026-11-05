import type { z } from "zod";
import { debugEnabled } from "../config.js";
import { logStage } from "../observability/log.js";

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
