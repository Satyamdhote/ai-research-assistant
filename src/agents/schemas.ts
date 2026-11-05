import { z } from "zod";
import { describeIssues, parseJsonText } from "../llm/parseJson.js";
import { StageFailure } from "../request/context.js";
import { normalizeUrl } from "../tools/searchResult.js";
import type { Route } from "../types.js";

// What each agent must return. .strict() rejects unexpected extra fields instead of
// silently dropping them. TypeScript types are generated from the schemas so they can
// never disagree.

// ---------------------------------------------------------------------------
// Final report (the /ask response). Unchanged since Milestone 3.
// ---------------------------------------------------------------------------
const ResearchSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    key_findings: z.array(z.string()),
    risks: z.array(z.string()),
    conclusion: z.string(),
  })
  .strict();
export type ResearchResult = z.infer<typeof ResearchSchema>;

// Turns the model's raw text into a validated report, or throws.
// Error messages never include the raw model text (it must not reach clients or logs).
export function parseResearch(text: string): ResearchResult {
  const result = ResearchSchema.safeParse(parseJsonText(text));
  if (!result.success) {
    throw new Error(`Model output failed schema validation: ${describeIssues(result.error)}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Supervisor route.
// ---------------------------------------------------------------------------
const RouteSchema = z
  .object({
    route: z.enum(["analysis_only", "research_then_analysis"]),
    research_task: z.string().trim().min(5).max(300).optional(),
    reason: z.string().trim().max(200),
  })
  .strict()
  // research_task is required for the research route and must be absent otherwise.
  .refine((value) => (value.route === "research_then_analysis") === (value.research_task !== undefined), {
    message: "research_task must be present exactly when route is research_then_analysis",
    path: ["research_task"],
  });
export type RouteDecision = z.infer<typeof RouteSchema>;

// A route is a binary choice, so an unusable answer is not worth failing the request for.
// Returns undefined and lets the caller fall back to a safe default.
export function parseRoute(text: string): RouteDecision | undefined {
  let json: unknown;
  try {
    json = parseJsonText(text);
  } catch {
    return undefined;
  }
  const result = RouteSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

export const FALLBACK_ROUTE: Route = "analysis_only";

// ---------------------------------------------------------------------------
// Research notes. The SHAPE is strict, but sizes are not: notes the app itself might
// produce (a long tracking URL, a wordy claim) are shortened instead of rejected, so
// valid search evidence is never thrown away.
// ---------------------------------------------------------------------------
const NotesSchema = z
  .object({
    findings: z.array(z.object({ claim: z.string(), source_url: z.string().nullable() }).strict()),
    gaps: z.array(z.string()),
  })
  .strict();

const MAX_FINDINGS = 6;
const MAX_CLAIM_CHARS = 400;
const MAX_GAPS = 5;
const MAX_GAP_CHARS = 300;
const MAX_URL_CHARS = 500;

export type Notes = {
  findings: Array<{ claim: string; source_url: string | null }>;
  gaps: string[];
};

// Validates the research notes, shortens oversized text, then removes any source URL that
// no real search returned. A model cannot attach a URL that never appeared in a search
// result: the claim stays, but is marked unsourced. (This checks only that the URL was
// really returned. It does NOT check that the claim is supported by that page.)
export function parseNotes(text: string, observedUrls: Set<string>): Notes {
  let json: unknown;
  try {
    json = parseJsonText(text);
  } catch {
    throw new StageFailure("invalid_notes");
  }
  const result = NotesSchema.safeParse(json);
  if (!result.success) {
    throw new StageFailure("invalid_notes");
  }
  const findings = result.data.findings
    .map((finding) => ({
      claim: finding.claim.trim().slice(0, MAX_CLAIM_CHARS),
      source_url:
        finding.source_url !== null &&
        finding.source_url.length <= MAX_URL_CHARS &&
        observedUrls.has(normalizeUrl(finding.source_url))
          ? finding.source_url
          : null,
    }))
    .filter((finding) => finding.claim !== "")
    .slice(0, MAX_FINDINGS);
  const gaps = result.data.gaps
    .map((gap) => gap.trim().slice(0, MAX_GAP_CHARS))
    .filter((gap) => gap !== "")
    .slice(0, MAX_GAPS);
  return { findings, gaps };
}
