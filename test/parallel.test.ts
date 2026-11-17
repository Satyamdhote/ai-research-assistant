import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT, notes, route, run, type Script } from "./helpers/mock.js";

// Milestone 7: the tool calls of ONE model reply run in parallel. They are independent
// (they come from the same reply); research -> analysis stays sequential (it is a dependency).
const DELAY = 200;
const search = (query: string, id?: string) => ({ name: "search_web", args: { query }, ...(id ? { id } : {}) });
const result = (n: number) => ({ title: `T${n}`, url: `https://example.com/${n}`, content: `Snippet ${n}` });

const twoSearches = (tavily: Script["tavily"], calls = [search("first query"), search("second query")]): Script => ({
  supervisor: [{ content: route("research_then_analysis") }],
  research: [{ toolCalls: calls }, { content: notes() }],
  analysis: [{ content: JSON.stringify(REPORT) }],
  tavily,
});

const toolMessages = (r: Awaited<ReturnType<typeof run>>) =>
  r.mock.calls.filter((c) => c.agent === "research")[1].body.messages.filter((m: any) => m.role === "tool");

test("two searches in one round overlap in time", async () => {
  const r = await run(twoSearches([{ delayMs: DELAY, results: [result(1)] }, { delayMs: DELAY, results: [result(2)] }]));
  assert.deepEqual(r.value, REPORT);
  assert.equal(r.mock.searches.length, 2);
  // Sequential would take >= 2 * DELAY = 400 ms; parallel takes about one DELAY.
  assert.ok(r.ms < DELAY * 1.75, `took ${r.ms} ms, expected well under ${DELAY * 2} ms`);
});

test("results keep the order the model asked, even if the second search finishes first", async () => {
  const r = await run(
    twoSearches(
      [{ delayMs: DELAY, results: [result(1)] }, { delayMs: 10, results: [result(2)] }],
      [search("slow one", "id_a"), search("fast one", "id_b")]
    )
  );
  const tools = toolMessages(r);
  assert.deepEqual(tools.map((m: any) => m.tool_call_id), ["id_a", "id_b"]);
  assert.match(tools[0].content, /Snippet 1/);
  assert.match(tools[1].content, /Snippet 2/);
  assert.deepEqual(r.mock.searches.map((s) => s.body.query), ["slow one", "fast one"]);
});

test("one failing search does not lose the other result", async () => {
  const r = await run(twoSearches([{ status: 500 }, { results: [result(2)] }]));
  assert.deepEqual(r.value, REPORT);
  const tools = toolMessages(r);
  assert.equal(tools.length, 2);
  assert.doesNotMatch(tools[0].content, /Snippet/);
  assert.match(tools[1].content, /Snippet 2/);
  assert.deepEqual(r.mock.logs.join("\n").match(/searchOutcomes=\S+/g)?.length, 3); // 2 tool_call lines + request_done
  assert.match(r.mock.analysisInput(), /SEARCH_UNAVAILABLE, SEARCH_OK/); // recorded in request order
});

test("3 parallel searches make exactly 2 Tavily requests (the budget cannot be overspent)", async () => {
  const r = await run(
    twoSearches([{ delayMs: 50, results: [result(1)] }], [search("one query"), search("two query"), search("three query")])
  );
  assert.deepEqual(r.value, REPORT);
  assert.equal(r.mock.searches.length, 2);
  const tools = toolMessages(r);
  assert.equal(tools.length, 3);
  assert.match(tools[2].content, /search limit reached/);
});

test("aborting the request stops all parallel searches", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  const r = await run(
    twoSearches([{ delayMs: 5_000, results: [result(1)] }, { delayMs: 5_000, results: [result(2)] }]),
    "a test question",
    controller.signal
  );
  assert.ok(r.error, "the request fails when cancelled");
  assert.ok(r.ms < 1_000, `took ${r.ms} ms, the searches should have been aborted`);
  assert.equal(r.mock.calls.filter((c) => c.agent === "analysis").length, 0);
});
