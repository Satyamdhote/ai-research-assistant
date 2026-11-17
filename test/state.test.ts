import assert from "node:assert/strict";
import { test } from "node:test";
import { answerQuestion } from "../src/agents/orchestrator.js";
import { LIMITS } from "../src/config.js";
import { createRequestContext, withAnalysisReserved } from "../src/request/context.js";
import { REPORT, installMock, route, setTestEnv } from "./helpers/mock.js";

// Request state: one context per request, written only through its methods.

test("two request contexts never share state", () => {
  setTestEnv();
  const a = createRequestContext();
  const b = createRequestContext();

  a.countModelCall();
  a.spendSearch();
  a.spendSearch();
  a.recordSearch("SEARCH_OK", ["https://a.example/x"]);

  assert.equal(b.modelCalls, 0);
  assert.equal(b.spendSearch(), true); // b still has its full budget
  assert.deepEqual([...b.searchOutcomes], []);
  assert.equal(b.observedUrls.size, 0);
  assert.equal(a.modelCalls, 1);
  assert.deepEqual([...a.searchOutcomes], ["SEARCH_OK"]);
});

test("the search budget runs out after the allowed number of searches", () => {
  const ctx = createRequestContext();
  const results = Array.from({ length: LIMITS.MAX_SEARCHES_PER_REQUEST + 2 }, () => ctx.spendSearch());
  assert.deepEqual(
    results,
    results.map((_, i) => i < LIMITS.MAX_SEARCHES_PER_REQUEST)
  );
});

test("countModelCall numbers calls 1, 2, 3...", () => {
  const ctx = createRequestContext();
  assert.deepEqual([ctx.countModelCall(), ctx.countModelCall(), ctx.countModelCall()], [1, 2, 3]);
  assert.equal(ctx.modelCalls, 3);
});

test("recordSearch keeps outcomes in order, de-duplicates URLs and caps the URL set", () => {
  const ctx = createRequestContext();
  ctx.recordSearch("SEARCH_OK", ["https://a.example/1", "https://a.example/1"]);
  ctx.recordSearch("SEARCH_UNAVAILABLE", []);
  assert.deepEqual([...ctx.searchOutcomes], ["SEARCH_OK", "SEARCH_UNAVAILABLE"]);
  assert.equal(ctx.observedUrls.size, 1);

  const many = Array.from({ length: LIMITS.MAX_OBSERVED_URLS + 20 }, (_, i) => `https://b.example/${i}`);
  ctx.recordSearch("SEARCH_OK", many);
  assert.equal(ctx.observedUrls.size, LIMITS.MAX_OBSERVED_URLS);
  assert.equal(ctx.searchOutcomes.length, 3); // the outcome is still recorded when URLs are capped
});

test("the analysis reserve is held back only while withAnalysisReserved runs", async () => {
  const ctx = createRequestContext();
  assert.equal(ctx.reserveActive, false);
  const before = ctx.remainingMs();
  await withAnalysisReserved(ctx, async () => {
    assert.equal(ctx.reserveActive, true);
    assert.ok(ctx.remainingMs() < before);
  });
  assert.equal(ctx.reserveActive, false);

  // The switch is reset even when the stage throws.
  await assert.rejects(withAnalysisReserved(ctx, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(ctx.reserveActive, false);
});

test("two overlapping requests keep budgets, outcomes and observed URLs apart", async () => {
  setTestEnv();
  const urlA = "https://a.example/A";
  const urlB = "https://b.example/B";
  const search = { name: "search_web", args: { query: "latest facts" } };
  // Each request's notes cite its OWN url and the OTHER request's url.
  const notesFor = (own: string, other: string) =>
    JSON.stringify({
      findings: [
        { claim: "own claim", source_url: own },
        { claim: "other claim", source_url: other },
      ],
      gaps: [],
    });

  // Requests share one fetch mock, whose replies are used in the order calls arrive. Delays make
  // that order fixed: A's supervisor and search come first, B's follow, then each research reply.
  const mock = installMock({
    supervisor: [{ content: route("research_then_analysis") }, { content: route("research_then_analysis"), delayMs: 100 }],
    research: [
      { toolCalls: [search] }, // A, round 1
      { toolCalls: [search] }, // B, round 1
      { content: notesFor(urlA, urlB) }, // A, round 2
      { content: notesFor(urlB, urlA) }, // B, round 2
    ],
    tavily: [
      { delayMs: 300, results: [{ title: "A", url: urlA, content: "From A." }] },
      { delayMs: 300, results: [{ title: "B", url: urlB, content: "From B." }] },
    ],
    analysis: [{ content: JSON.stringify(REPORT) }, { content: JSON.stringify(REPORT) }],
  });
  try {
    await Promise.all([answerQuestion("question A"), answerQuestion("question B")]);
  } finally {
    mock.restore();
  }

  const inputs = mock.calls.filter((c) => c.agent === "analysis").map((c) => String(c.body.messages[1].content));
  assert.equal(inputs.length, 2);
  const forA = inputs.find((text) => text.includes("question A"));
  const forB = inputs.find((text) => text.includes("question B"));
  assert.ok(forA && forB);

  // Each analysis saw only its own search, and kept only its own URL; the other's is dropped.
  for (const [text, own, other] of [[forA, urlA, urlB], [forB, urlB, urlA]] as const) {
    assert.match(text, /search_outcomes: SEARCH_OK\n/); // exactly one outcome, not two
    assert.ok(text.includes(own), "keeps its own observed URL");
    assert.ok(!text.includes(other), "never carries the other request's URL");
    assert.match(text, /"source_url":null/);
  }
});
