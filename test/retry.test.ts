import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT, notes, route, run, type Script, reportOnly } from "./helpers/mock.js";

// Milestone 11: search retries. One retry, only for TRANSIENT failures, and the retry spends the
// same per-request search budget (so Tavily requests never exceed 2 per question).
const search = (query = "latest facts", id?: string) => ({ name: "search_web", args: { query }, ...(id ? { id } : {}) });
const ok = { results: [{ title: "T", url: "https://example.com/one", content: "Snippet one." }] };

const script = (tavily: Script["tavily"], calls = [search()]): Script => ({
  supervisor: [{ content: route("research_then_analysis") }],
  research: [{ toolCalls: calls }, { content: notes() }],
  analysis: [{ content: JSON.stringify(REPORT) }],
  tavily,
});

const outcomes = (r: Awaited<ReturnType<typeof run>>) => r.mock.analysisInput().match(/search_outcomes: (.*)/)?.[1];

for (const [name, first] of [
  ["a 500 response", { status: 500 }],
  ["a network error", { networkError: true }],
] as const) {
  test(`transient failure (${name}) is retried exactly once and the retry can succeed`, async () => {
    const r = await run(script([first, ok]));
    assert.deepEqual(reportOnly(r.value), REPORT);
    assert.equal(r.mock.searches.length, 2);
    assert.equal(outcomes(r), "SEARCH_OK");
    assert.ok(r.mock.logs.some((l) => /event=tool_call .*searchRetries=1/.test(l)));
    assert.ok(r.mock.logs.some((l) => /event=request_done .*searchRetries=1/.test(l)));
  });
}

test("a transient failure that keeps failing is retried only once, then reported as unavailable", async () => {
  const r = await run(script([{ status: 503 }]));
  assert.equal(r.mock.searches.length, 2); // 1 attempt + 1 retry, never a third
  assert.equal(outcomes(r), "SEARCH_UNAVAILABLE"); // ONE outcome: only the final result is recorded
  assert.deepEqual(reportOnly(r.value), REPORT);
});

for (const status of [401, 429, 432, 433]) {
  test(`permanent failure (${status}) is never retried`, async () => {
    const r = await run(script([{ status }]));
    assert.equal(r.mock.searches.length, 1);
    assert.equal(outcomes(r), "SEARCH_UNAVAILABLE");
  });
}

test("the retry takes a search from the same budget: two parallel searches leave nothing to retry with", async () => {
  const r = await run(script([{ status: 500 }, ok], [search("first query", "a"), search("second query", "b")]));
  assert.equal(r.mock.searches.length, 2, "never more than 2 Tavily requests per question");
});

test("the retry never exceeds the 2-request budget across two sequential rounds", async () => {
  const s: Script = {
    supervisor: [{ content: route("research_then_analysis") }],
    research: [{ toolCalls: [search("one")] }, { toolCalls: [search("two")] }, { content: notes() }],
    analysis: [{ content: JSON.stringify(REPORT) }],
    tavily: [{ status: 500 }, { status: 500 }, ok],
  };
  const r = await run(s);
  assert.equal(r.mock.searches.length, 2); // attempt + retry used both; the second search is refused
  const second = r.mock.calls.filter((c) => c.agent === "research")[2].body.messages.filter((m: any) => m.role === "tool");
  assert.match(second[1].content, /search limit reached/);
});

test("no retry when there is too little time left for the pause and a usable call", async () => {
  // The first search times out at the time left; what remains is below backoff + minimum.
  const r = await run(script([{ delayMs: 20_000 }, ok]), "q", undefined, { REQUEST_DEADLINE_MS: "4000" });
  assert.equal(r.mock.searches.length, 1);
  assert.equal(outcomes(r), "SEARCH_UNAVAILABLE");
  assert.ok(r.ms < 4200, `finished in ${r.ms} ms`);
});

test("a client that leaves during the retry pause cancels the request", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150); // inside the 500 ms backoff
  const r = await run(script([{ status: 500 }, ok]), "q", controller.signal);
  assert.match(r.error?.message ?? "", /Request cancelled/);
  assert.equal(r.mock.searches.length, 1);
  assert.ok(!r.mock.calls.some((c) => c.agent === "analysis"));
});

test("model calls are NOT retried: a failing model call is one call, not two", async () => {
  const r = await run({ supervisor: [{ networkError: true }], analysis: [{ content: JSON.stringify(REPORT) }] });
  assert.equal(r.mock.calls.filter((c) => c.agent === "supervisor").length, 1);
});
