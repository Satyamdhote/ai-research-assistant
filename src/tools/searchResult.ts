import type { SearchOutcome } from "../types.js";

// The ONE place that defines the search result markers. Code and prompts both use these,
// so the words the model is told to rely on can never drift from what the app produces.
export const SEARCH_MARKERS = {
  ok: "SEARCH_OK",
  noResults: "SEARCH_OK_NO_RESULTS",
  unavailable: "SEARCH_UNAVAILABLE",
} as const satisfies Record<string, SearchOutcome>;

// What a web search hands back. `outcome` and `urls` are structured facts for the
// application; `text` is what the model gets to read.
export type SearchResult = {
  outcome: SearchOutcome;
  urls: string[]; // https URLs that really appeared in the results
  text: string;
};

// URLs are compared in a normalized form (so "https://a.com/x" and "https://a.com/x/"
// match; the #fragment is ignored too). This only tells us a URL was returned by a real search; it does NOT prove that a
// claim is supported by that page.
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return trimmed;
  }
}
