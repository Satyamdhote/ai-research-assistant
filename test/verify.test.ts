import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyNotes } from "../src/agents/verify.js";
import { normalizeUrl } from "../src/tools/searchResult.js";
import { createRequestContext } from "../src/request/context.js";

const A = "https://a.example/page";
const B = "https://b.example/page";
const snippets = new Map([
  [normalizeUrl(A), "Node.js 22 entered long term support in October 2024 as an LTS release"],
  [normalizeUrl(B), "Completely unrelated cooking recipe about sourdough bread baking"],
]);
const notes = (findings: Array<{ claim: string; source_url: string | null }>) => ({ findings, gaps: [] });

test("supported: observed URL whose snippet shares the claim's key terms", () => {
  const [item] = verifyNotes(notes([{ claim: "Node.js 22 entered long term support in October 2024", source_url: A }]), snippets);
  assert.equal(item?.status, "supported");
});

test("weak: observed URL whose snippet is irrelevant to the claim", () => {
  const [item] = verifyNotes(notes([{ claim: "Node.js 22 entered long term support in October 2024", source_url: B }]), snippets);
  assert.equal(item?.status, "weak");
});

test("weak: observed URL with no stored snippet cannot be called supported", () => {
  const [item] = verifyNotes(notes([{ claim: "Node.js 22 entered long term support", source_url: A }]), new Map());
  assert.equal(item?.status, "weak");
});

test("unsourced: no source URL (unobserved URLs were already nulled by parseNotes)", () => {
  const [item] = verifyNotes(notes([{ claim: "Some claim with no source", source_url: null }]), snippets);
  assert.equal(item?.status, "unsourced");
});

test("conflicting: same subject, one side negated", () => {
  const items = verifyNotes(
    notes([
      { claim: "Node.js 22 is an active long term support release", source_url: A },
      { claim: "Node.js 22 is not an active long term support release", source_url: B },
    ]),
    snippets
  );
  assert.deepEqual(items.map((i) => i.status), ["conflicting", "conflicting"]);
});

test("conflicting: same subject, different numbers", () => {
  const items = verifyNotes(
    notes([
      { claim: "The framework supports 100 concurrent connections by default", source_url: null },
      { claim: "The framework supports 500 concurrent connections by default", source_url: null },
    ]),
    snippets
  );
  assert.deepEqual(items.map((i) => i.status), ["conflicting", "conflicting"]);
});

test("different subjects do not conflict", () => {
  const items = verifyNotes(
    notes([
      { claim: "Node.js 22 entered long term support", source_url: A },
      { claim: "Sourdough bread is not difficult to bake", source_url: B },
    ]),
    snippets
  );
  assert.ok(items.every((i) => i.status !== "conflicting"));
});

test("recordSearch stores capped snippets per request and the first one wins", () => {
  const ctx = createRequestContext();
  ctx.recordSearch("SEARCH_OK", ["https://a.example/1"], ["x".repeat(5000)]);
  ctx.recordSearch("SEARCH_OK", ["https://a.example/1"], ["second"]);
  assert.ok((ctx.observedSnippets.get("https://a.example/1")?.length ?? 0) <= 700);
  assert.ok(ctx.observedSnippets.get("https://a.example/1")?.startsWith("xxx"));
  assert.equal(createRequestContext().observedSnippets.size, 0);
});

// --- Review findings 1 and 2: a claim must not be "supported" against a source that contradicts it ---

const U = "https://c.example/page";
const statusFor = (claim: string, snippet: string) =>
  verifyNotes(notes([{ claim, source_url: U }]), new Map([[normalizeUrl(U), snippet]]))[0]?.status;
const statusesOf = (claims: string[]) =>
  verifyNotes(notes(claims.map((claim) => ({ claim, source_url: null }))), new Map()).map((i) => i.status);

test("weak: a number in the claim that the snippet does not contain (wrong score)", () => {
  assert.equal(
    statusFor("Argentina won the final 4-2 on penalties against France", "Argentina won the final 3-1 on penalties against France in the tournament"),
    "weak"
  );
});

test("weak: a different year in the claim and the snippet", () => {
  assert.equal(
    statusFor("The framework released version two in 2019 with strong support", "The framework released version two in 2023 with strong support"),
    "weak"
  );
});

test("weak: the claim is negated but its source sentence is not", () => {
  assert.equal(statusFor("Node 22 is not supported long term", "Node 22 is supported long term release channel"), "weak");
});

test("weak: the source sentence is negated but the claim is not", () => {
  assert.equal(statusFor("Node 22 is supported long term", "Node 22 is not supported long term release channel"), "weak");
});

test("supported: an unrelated negation elsewhere in the snippet does not matter", () => {
  assert.equal(
    statusFor("Node 22 entered long term support", "Node 22 entered long term support. Older releases are not maintained any more."),
    "supported"
  );
});

test("supported: numbers match across formatting (1,000 and 1000)", () => {
  assert.equal(statusFor("The cluster handles 1,000 requests quickly", "The cluster handles 1000 requests quickly under load"), "supported");
});

test("supported: a matching negation on both sides", () => {
  assert.equal(statusFor("The service does not store passwords", "The service does not store passwords in plain text"), "supported");
});

test("not conflicting: different facts that merely contain different numbers", () => {
  assert.deepEqual(
    statusesOf(["The company was founded in 1998 and grew its engineering team", "The company was acquired in 2015 and grew its engineering team"]),
    ["unsourced", "unsourced"]
  );
});

test("not conflicting: 'no. 1' is a ranking, not a negation", () => {
  assert.deepEqual(
    statusesOf(["Python is ranked no. 1 in the popularity index of languages", "Python is ranked no. 1 in the popularity index of programming languages"]),
    ["unsourced", "unsourced"]
  );
});

test("conflicting: the same fact with different numbers (same context word)", () => {
  assert.deepEqual(
    statusesOf(["The release shipped in October 2024 after long testing", "The release shipped in October 2025 after long testing"]),
    ["conflicting", "conflicting"]
  );
});

test("conflicting: a real 'no <word>' negation still counts", () => {
  assert.deepEqual(
    statusesOf(["The library has known security issues in version five", "The library has no known security issues in version five"]),
    ["conflicting", "conflicting"]
  );
});
