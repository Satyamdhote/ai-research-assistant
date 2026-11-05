import assert from "node:assert/strict";
import { test } from "node:test";
import { REPORT, notes, route, run, type Script } from "./helpers/mock.js";

const report = { content: JSON.stringify(REPORT) };
const researchRoute = { content: route("research_then_analysis") };
const search = { name: "search_web", args: { query: "latest facts" } };

test("a slow research stage cannot starve the analysis (time is reserved for it)", async () => {
  // The research model never answers in time. The analysis reserve keeps it from using it all.
  const r = await run({ supervisor: [researchRoute], research: [{ delayMs: 20_000 }], analysis: [report] }, "q", undefined, { REQUEST_DEADLINE_MS: "4000" });
  assert.deepEqual(r.value, REPORT);
  assert.deepEqual(r.mock.calls.map((c) => c.agent), ["supervisor", "research", "analysis"]);
  assert.match(r.mock.analysisInput(), /research_stage: failed:model_error/);
  assert.ok(r.ms < 4200, `finished in ${r.ms} ms`);
});

test("a slow search is cut off at the time left, and the stage degrades with the real outcome", async () => {
  const script: Script = {
    supervisor: [researchRoute],
    research: [{ toolCalls: [search] }, { content: notes(null) }],
    analysis: [report],
    tavily: [{ delayMs: 20_000 }],
  };
  const r = await run(script, "q", undefined, { REQUEST_DEADLINE_MS: "4000" });
  assert.deepEqual(r.value, REPORT);
  assert.match(r.mock.analysisInput(), /search_outcomes: SEARCH_UNAVAILABLE/);
  assert.match(r.mock.analysisInput(), /research_stage: failed:time_limit/);
  assert.ok(r.ms < 4200, `finished in ${r.ms} ms`);
});

test("when the whole request is out of time no further call is started", async () => {
  const r = await run({ supervisor: [{ content: route("analysis_only"), delayMs: 1300 }], analysis: [report] }, "q", undefined, { REQUEST_DEADLINE_MS: "2000" });
  assert.match(r.error?.message ?? "", /Request time limit reached/);
  assert.equal(r.mock.calls.length, 1); // the analysis call was never sent
});

test("a client that disconnects stops the work: no further model calls", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const r = await run(
    { supervisor: [{ content: route("analysis_only"), delayMs: 1000 }], analysis: [report] },
    "a question",
    controller.signal
  );
  assert.match(r.error?.message ?? "", /Request cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(r.mock.calls.length, 1);
});

test("an aborted client during research is not turned into a 'degraded' answer", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  const r = await run(
    { supervisor: [researchRoute], research: [{ delayMs: 1000 }], analysis: [report] },
    "a question",
    controller.signal
  );
  assert.match(r.error?.message ?? "", /Request cancelled/);
  assert.ok(!r.mock.calls.some((c) => c.agent === "analysis"));
});

test("without a test override the default deadline is 90 seconds", async () => {
  const { getRequestDeadlineMs } = await import("../src/config.js");
  delete process.env.REQUEST_DEADLINE_MS;
  assert.equal(getRequestDeadlineMs(), 90_000);
  process.env.REQUEST_DEADLINE_MS = "5"; // too small to be honoured
  assert.equal(getRequestDeadlineMs(), 90_000);
  delete process.env.REQUEST_DEADLINE_MS;
});
