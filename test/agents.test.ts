import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RESULTS, REPORT, notes, route, run, type Script } from "./helpers/mock.js";

const search = (query = "latest facts") => ({ name: "search_web", args: { query } });
const date = () => ({ name: "get_current_date", args: {} });
const researchScript = (research: Script["research"], extra: Partial<Script> = {}): Script => ({
  supervisor: [{ content: route("research_then_analysis") }],
  research,
  analysis: [{ content: JSON.stringify(REPORT) }],
  ...extra,
});

test("analysis_only: exactly 2 model calls, no tools sent, no search", async () => {
  const r = await run({ supervisor: [{ content: route("analysis_only") }], analysis: [{ content: JSON.stringify(REPORT) }] });
  assert.deepEqual(r.value, REPORT);
  assert.deepEqual(r.mock.calls.map((c) => c.agent), ["supervisor", "analysis"]);
  assert.ok(r.mock.calls.every((c) => !("tools" in c.body)), "supervisor and analysis must not get a tools field");
  assert.equal(r.mock.searches.length, 0);
  assert.match(r.mock.analysisInput(), /search_outcomes: NOT_USED/);
  assert.match(r.mock.analysisInput(), /research_stage: not_needed/);
});

test("research happy path: 4 calls, 1 search, ground truth passed to analysis", async () => {
  const r = await run(researchScript([{ toolCalls: [search()] }, { content: notes() }]));
  assert.deepEqual(r.value, REPORT);
  assert.deepEqual(r.mock.calls.map((c) => c.agent), ["supervisor", "research", "research", "analysis"]);
  assert.equal(r.mock.searches.length, 1);
  assert.match(r.mock.analysisInput(), /search_outcomes: SEARCH_OK/);
  assert.match(r.mock.analysisInput(), /research_stage: completed/);
  assert.match(r.mock.analysisInput(), /https:\/\/example\.com\/one/);
});

test("every request is free-only, allows no fallback, and tools are limited per agent", async () => {
  const r = await run(researchScript([{ toolCalls: [search()] }, { content: notes() }]));
  for (const call of r.mock.calls) {
    assert.ok(String(call.body.model).endsWith(":free"));
    assert.equal(call.body.provider.allow_fallbacks, false);
  }
  const sizes = Object.fromEntries(r.mock.calls.map((c) => [c.agent, c.body.max_tokens]));
  assert.deepEqual(sizes, { supervisor: 1024, research: 2048, analysis: 2048 });
  const research = r.mock.calls.find((c) => c.agent === "research")!;
  assert.deepEqual(research.body.tools.map((t: any) => t.function.name).sort(), ["get_current_date", "search_web"]);
  assert.deepEqual(r.mock.searches[0]!.body.search_depth, "basic");
  assert.equal(r.mock.searches[0]!.body.max_results, 5);
  assert.equal(r.mock.searches[0]!.body.include_answer, false);
  assert.equal(r.mock.searches[0]!.body.include_raw_content, false);
});

test("two tool rounds are allowed: 3 research calls, 5 calls in total", async () => {
  const r = await run(researchScript([{ toolCalls: [search()] }, { toolCalls: [date()] }, { content: notes() }]));
  assert.deepEqual(r.value, REPORT);
  assert.equal(r.mock.calls.length, 5);
});

test("a third tool round is refused before anything runs, and the analysis is told honestly", async () => {
  const r = await run(researchScript([{ toolCalls: [search()] }, { toolCalls: [date()] }, { toolCalls: [search("another")] }]));
  assert.deepEqual(r.value, REPORT);
  assert.equal(r.mock.calls.length, 5); // no 4th research call
  assert.equal(r.mock.searches.length, 1); // the third request's search was NOT executed
  assert.match(r.mock.analysisInput(), /search_outcomes: SEARCH_OK/);
  assert.match(r.mock.analysisInput(), /research_stage: failed:too_many_tool_rounds/);
});

const matrix: Array<{ name: string; script: Script; outcomes: string; stage: string }> = [
  { name: "search unavailable, valid notes", script: researchScript([{ toolCalls: [search()] }, { content: notes(null) }], { tavily: [{ status: 401 }] }), outcomes: "SEARCH_UNAVAILABLE", stage: "completed" },
  { name: "search found nothing", script: researchScript([{ toolCalls: [search()] }, { content: notes(null) }], { tavily: [{ results: [] }] }), outcomes: "SEARCH_OK_NO_RESULTS", stage: "completed" },
  { name: "search ok, then invalid notes", script: researchScript([{ toolCalls: [search()] }, { content: "garbage" }]), outcomes: "SEARCH_OK", stage: "failed:invalid_notes" },
  { name: "search unavailable, then truncated notes", script: researchScript([{ toolCalls: [search()] }, { content: '{"findings":[', finish: "length" }], { tavily: [{ status: 500 }] }), outcomes: "SEARCH_UNAVAILABLE", stage: "failed:truncated" },
  { name: "no search made", script: researchScript([{ content: notes(null) }]), outcomes: "NOT_USED", stage: "completed" },
];
for (const c of matrix) {
  test(`outcome vs stage kept separate: ${c.name}`, async () => {
    const r = await run(c.script);
    assert.deepEqual(r.value, REPORT);
    assert.match(r.mock.analysisInput(), new RegExp(`search_outcomes: ${c.outcomes}\\n`));
    assert.match(r.mock.analysisInput(), new RegExp(`research_stage: ${c.stage}\\n`));
  });
}

const badSupervisor: Array<[string, any]> = [
  ["not JSON", { content: "not json at all" }],
  ["unknown route", { content: JSON.stringify({ route: "banana", reason: "x" }) }],
  ["research route without a task", { content: JSON.stringify({ route: "research_then_analysis", reason: "x" }) }],
  ["extra field", { content: JSON.stringify({ route: "analysis_only", reason: "x", extra: 1 }) }],
  ["null task", { content: JSON.stringify({ route: "analysis_only", research_task: null, reason: "x" }) }],
  ["truncated", { content: '{"route":', finish: "length" }],
  ["empty", { content: "" }],
];
for (const [name, reply] of badSupervisor) {
  test(`unusable supervisor output (${name}) falls back to analysis_only`, async () => {
    const r = await run({ supervisor: [reply], analysis: [{ content: JSON.stringify(REPORT) }] });
    assert.deepEqual(r.value, REPORT);
    assert.deepEqual(r.mock.calls.map((c) => c.agent), ["supervisor", "analysis"]);
    assert.ok(r.mock.logs.some((l) => l.includes("event=route") && l.includes("routeFallback=true")));
  });
}

test("a provider error at the supervisor is NOT hidden by the fallback", async () => {
  const r = await run({ supervisor: [{ status: 429 }] });
  assert.match(r.error?.message ?? "", /rate limited/);
  assert.equal(r.mock.calls.length, 1);
});

test("an analysis agent that asks for a tool fails the request", async () => {
  const r = await run({ supervisor: [{ content: route("analysis_only") }], analysis: [{ toolCalls: [search()] }] });
  assert.ok(r.error);
  assert.equal(r.mock.searches.length, 0);
});

test("3 searches in one round: only 2 run, the third is refused", async () => {
  const r = await run(researchScript([{ toolCalls: [search("a1"), search("a2"), search("a3")] }, { content: notes() }]));
  assert.equal(r.mock.searches.length, 2);
  const secondResearchCall = r.mock.calls.filter((c) => c.agent === "research")[1]!;
  const toolMessages = secondResearchCall.body.messages.filter((m: any) => m.role === "tool");
  assert.equal(toolMessages.length, 3); // every tool_call_id got exactly one result
  assert.match(toolMessages[2].content, /search limit reached/);
});

test("more than 3 tool calls in one round: nothing runs, research degrades", async () => {
  const r = await run(researchScript([{ toolCalls: [date(), date(), date(), date()] }]));
  assert.deepEqual(r.value, REPORT);
  assert.match(r.mock.analysisInput(), /failed:too_many_tool_calls/);
});

test("a tool the research agent is not allowed to use does not exist for it", async () => {
  const r = await run(researchScript([{ toolCalls: [{ name: "delete_everything", args: {} }] }, { content: notes(null) }]));
  const tool = r.mock.calls.filter((c) => c.agent === "research")[1]!.body.messages.find((m: any) => m.role === "tool");
  assert.equal(tool.content, "Error: unknown tool");
});

// --- Research problems are reported honestly instead of failing the request ---

test("research reply with non-string content degrades (model_error)", async () => {
  const r = await run(researchScript([{ content: [{ type: "text", text: "{}" }] }]));
  assert.deepEqual(r.value, REPORT);
  assert.match(r.mock.analysisInput(), /failed:model_error/);
});

test("research network error degrades", async () => {
  const r = await run(researchScript([{ networkError: true }]));
  assert.deepEqual(r.value, REPORT);
  assert.match(r.mock.analysisInput(), /failed:model_error/);
});

test("research 200 with a non-JSON body degrades", async () => {
  const r = await run(researchScript([{ badBody: true }]));
  assert.deepEqual(r.value, REPORT);
  assert.match(r.mock.analysisInput(), /failed:model_error/);
});

test("a provider error during research is NOT hidden", async () => {
  const r = await run(researchScript([{ status: 429 }]));
  assert.match(r.error?.message ?? "", /rate limited/);
});

// --- Notes ---

test("a URL no search returned is removed; a trailing-slash variant of a real one is kept", async () => {
  const body = JSON.stringify({
    findings: [
      { claim: "invented source", source_url: "https://fake.example/invented" },
      { claim: "real source, trailing slash", source_url: "https://example.com/one/" },
    ],
    gaps: [],
  });
  const r = await run(researchScript([{ toolCalls: [search()] }, { content: body }]));
  assert.ok(r.mock.analysisInput().includes('"source_url":"https://example.com/one/"'));
  assert.ok(!r.mock.analysisInput().includes("fake.example"));
  assert.ok(r.mock.analysisInput().includes('"claim":"invented source","source_url":null'));
});

test("oversized notes are shortened, not rejected", async () => {
  const body = JSON.stringify({
    findings: [
      { claim: "x".repeat(1000), source_url: `https://example.com/${"p".repeat(600)}` },
      ...Array.from({ length: 9 }, (_, i) => ({ claim: `claim ${i}`, source_url: null })),
    ],
    gaps: Array.from({ length: 9 }, (_, i) => `gap ${i}`),
  });
  const r = await run(researchScript([{ toolCalls: [search()] }, { content: body }]));
  assert.match(r.mock.analysisInput(), /research_stage: completed/);
  const sent = JSON.parse(r.mock.analysisInput().split("\n").at(-1)!);
  assert.equal(sent.findings.length, 6);
  assert.equal(sent.findings[0].claim.length, 400);
  assert.equal(sent.findings[0].source_url, null);
  assert.equal(sent.gaps.length, 5);
});

test("search results never contain a URL that is not https", async () => {
  const r = await run(
    researchScript([{ toolCalls: [search()] }, { content: notes("http://insecure.example/x") }], {
      tavily: [{ results: [...DEFAULT_RESULTS, { title: "bad", url: "http://insecure.example/x", content: "text" }] }],
    })
  );
  assert.ok(!r.mock.analysisInput().includes("insecure.example"));
});
