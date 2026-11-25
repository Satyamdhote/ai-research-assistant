import { VERIFY } from "../config.js";
import type { EvidenceItem, EvidenceStatus } from "../types.js";
import { normalizeUrl } from "../tools/searchResult.js";
import type { Notes } from "./schemas.js";

// Evidence verification: plain code, no model. A model says what it found; the application
// decides how well the search results back it up. All checks are cheap HEURISTICS over the
// snippets that real searches returned, so they are honest about their limits:
//   - "supported" means the source's snippet shares the claim's key terms AND every number in
//     the claim appears in the snippet AND the claim and the best-matching snippet sentence
//     agree on negation. It is NOT proof the claim is true, and it never reads the full page.
//   - "conflicting" needs the same subject plus a real clash: one side negates, or both give
//     different numbers for the same thing (the same preceding key word).

const STOPWORDS = new Set([
  "about", "also", "been", "being", "between", "both", "could", "does", "each", "from", "have", "into",
  "more", "most", "only", "other", "over", "such", "than", "that", "their", "them", "then",
  "there", "these", "they", "this", "those", "very", "were", "what", "when", "where", "which", "while",
  "will", "with", "would", "your", "never", "cannot", "without", "using", "used", "uses",
]);

// Negation words. A bare "no" only counts as negation when a word follows ("no evidence"), so
// "no. 1" and "no 5" (a number) are not treated as negation.
const NEGATION = /\b(?:not|never|cannot|without|neither|nor|none)\b|n't\b|\bno\s+\p{L}/u;
const isNegated = (text: string): boolean => NEGATION.test(text.toLowerCase());

// Lowercased word and number tokens. Words under 4 letters and stopwords are dropped;
// numbers of any length are kept (they are strong evidence markers).
function tokens(text: string): { words: Set<string>; numbers: Set<string> } {
  const words = new Set<string>();
  const numbers = new Set<string>();
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+(?:[.,][\p{N}]+)*/gu) ?? []) {
    if (/^\p{N}/u.test(raw)) numbers.add(raw.replace(/,/g, ""));
    else if (raw.length >= 4 && !STOPWORDS.has(raw)) words.add(raw);
  }
  return { words, numbers };
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0) return 0;
  let hits = 0;
  for (const item of a) if (b.has(item)) hits += 1;
  return hits / a.size;
}

// Groups the numbers of a text by the key word that comes just before them ("supports 100"
// -> supports: {100}). Two numbers can only disagree when they describe the same thing, so
// conflicts compare numbers that share this context word. Numbers with no key word before
// them are left out.
function numbersByContext(text: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  let context = "";
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+(?:[.,][\p{N}]+)*/gu) ?? []) {
    if (/^\p{N}/u.test(raw)) {
      if (context === "") continue;
      const group = result.get(context) ?? new Set<string>();
      group.add(raw.replace(/,/g, ""));
      result.set(context, group);
    } else if (raw.length >= 4 && !STOPWORDS.has(raw)) {
      context = raw;
    }
  }
  return result;
}

// Two findings conflict when they are about the same subject but disagree: exactly one is
// negated, or both give different numbers for the same thing (the same context word).
// Different facts that merely contain different numbers ("founded in 1998", "acquired in
// 2015") are NOT a conflict.
function conflicts(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  const subject = Math.min(overlap(ta.words, tb.words), overlap(tb.words, ta.words));
  if (subject < VERIFY.MIN_SUBJECT_OVERLAP) return false;
  if (isNegated(a) !== isNegated(b)) return true;
  const na = numbersByContext(a);
  const nb = numbersByContext(b);
  for (const [context, numbersA] of na) {
    const numbersB = nb.get(context);
    if (numbersB && overlap(numbersA, numbersB) === 0) return true;
  }
  return false;
}

// The sentence of the snippet that shares the most key terms with the claim. Negation is
// judged on this sentence, so an unrelated "not" elsewhere in the snippet does not matter.
function bestSentence(snippet: string, claimWords: ReadonlySet<string>): string {
  let best = snippet;
  let bestScore = -1;
  for (const sentence of snippet.split(/(?<=[.!?;])\s+|\n+/)) {
    const score = overlap(claimWords, tokens(sentence).words);
    if (score > bestScore) {
      best = sentence;
      bestScore = score;
    }
  }
  return best;
}

// A claim is backed by a snippet when (1) enough of its key terms appear, (2) every number it
// states also appears in the snippet, and (3) the claim and the best-matching snippet sentence
// agree on negation. Anything else is "weak": the source may not say what the claim says.
function isBackedBy(claim: string, snippet: string): boolean {
  const c = tokens(claim);
  const s = tokens(snippet);
  if (overlap(c.words, s.words) < VERIFY.MIN_SUPPORT_OVERLAP) return false;
  for (const number of c.numbers) if (!s.numbers.has(number)) return false;
  return isNegated(claim) === isNegated(bestSentence(snippet, c.words));
}

// Pure function: validated notes + what searches really returned -> a status per finding.
export function verifyNotes(notes: Notes, snippets: ReadonlyMap<string, string>): EvidenceItem[] {
  const items: EvidenceItem[] = notes.findings.map((finding) => {
    let status: EvidenceStatus = "unsourced";
    if (finding.source_url !== null) {
      const snippet = snippets.get(normalizeUrl(finding.source_url));
      // A URL that was observed but has no stored snippet cannot be checked: weak, not supported.
      status = snippet !== undefined && isBackedBy(finding.claim, snippet) ? "supported" : "weak";
    }
    return { claim: finding.claim, source_url: finding.source_url, status };
  });

  // Conflicts override the per-source status: a disputed claim is not "supported".
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (conflicts(items[i]!.claim, items[j]!.claim)) {
        items[i]!.status = "conflicting";
        items[j]!.status = "conflicting";
      }
    }
  }
  return items;
}

export function unverified(notes: Notes): EvidenceItem[] {
  return notes.findings.map((f) => ({ claim: f.claim, source_url: f.source_url, status: "unverified" }));
}

export function summarize(items: readonly EvidenceItem[]): string {
  const counts: Record<EvidenceStatus, number> = { supported: 0, weak: 0, conflicting: 0, unsourced: 0, unverified: 0 };
  for (const item of items) counts[item.status] += 1;
  return Object.entries(counts)
    .map(([status, n]) => `${status}=${n}`)
    .join(", ");
}
