import assert from "node:assert/strict";
import { test } from "node:test";
import { getOpenRouterConfig, traceEnabled } from "../src/config.js";
import { parseJsonText } from "../src/llm/parseJson.js";
import { normalizeUrl } from "../src/tools/searchResult.js";
import { REPORT, TEST_KEY, TEST_TAVILY_KEY, notes, run, setTestEnv, type Script } from "./helpers/mock.js";

test("config: only explicitly free models are accepted", () => {
  setTestEnv();
  assert.equal(getOpenRouterConfig().model, "mock/model:free");
  process.env.OPENROUTER_MODEL = "some/paid-model";
  assert.throws(() => getOpenRouterConfig(), /must end with ":free"/);
  process.env.OPENROUTER_MODEL = "mock/model:free";
  delete process.env.OPENROUTER_API_KEY;
  assert.throws(() => getOpenRouterConfig(), /Missing OpenRouter configuration/);
  setTestEnv();
});

test("parseJsonText accepts plain, fenced and wrapped JSON, and rejects the rest with a fixed message", () => {
  assert.deepEqual(parseJsonText('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonText('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonText('Here is my decision: {"a":1} hope that helps'), { a: 1 });
  for (const bad of ["no json here", '{"a":1,}', "", "[1,2"]) {
    assert.throws(() => parseJsonText(bad), /^Error: Model output is not valid JSON$/);
  }
});

test("normalizeUrl ignores a trailing slash and nothing else", () => {
  assert.equal(normalizeUrl("https://a.com/x/"), normalizeUrl("https://a.com/x"));
  assert.notEqual(normalizeUrl("https://a.com/x"), normalizeUrl("https://a.com/y"));
});

// A full research run where every kind of sensitive text is a recognisable sentinel.
const sentinels = ["SENTINEL_QUESTION", "SENTINEL_REASONING", "SENTINEL_QUERY", "SENTINEL_SNIPPET", "SENTINEL_NOTE", "SENTINEL_REPORT", "SENTINEL_TASK", "SENTINEL_WHY"];
const sensitiveScript = (): Script => ({
  supervisor: [{ content: JSON.stringify({ route: "research_then_analysis", research_task: "SENTINEL_TASK look it up", reason: "SENTINEL_WHY" }) }],
  research: [
    { toolCalls: [{ name: "search_web", args: { query: "SENTINEL_QUERY" } }] },
    { content: JSON.stringify({ findings: [{ claim: "SENTINEL_NOTE", source_url: "https://example.com/one" }], gaps: [] }) },
  ],
  analysis: [{ content: JSON.stringify(REPORT) }],
  tavily: [{ results: [{ title: "t", url: "https://example.com/one", content: "SENTINEL_SNIPPET text" }] }],
});

for (const debug of [false, true]) {
  test(`logs contain no credentials, reasoning or user content (DEBUG_LLM=${debug ? 1 : "off"})`, async () => {
    const r = await run(sensitiveScript(), "SENTINEL_QUESTION about something", undefined, debug ? { DEBUG_LLM: "1" } : {});
    assert.deepEqual(r.value, REPORT);
    const output = r.mock.logs.join("\n");
    assert.ok(output.includes("[agent]"), "stage lines are printed");
    for (const secret of [...sentinels, TEST_KEY, TEST_TAVILY_KEY, "Authorization", "Bearer"]) {
      assert.ok(!output.includes(secret), `log leaked ${secret}`);
    }
    if (debug) assert.match(output, /contentChars=\d+/); // structure only, still no text
  });
}

test("a failed parse logs only the shape of the text, never the text", async () => {
  const r = await run(
    { supervisor: [{ content: "SENTINEL_GARBAGE without any braces" }], analysis: [{ content: JSON.stringify(REPORT) }] },
    "q",
    undefined,
    { DEBUG_LLM: "1" }
  );
  const output = r.mock.logs.join("\n");
  assert.match(output, /event=parse_failed textChars=\d+ startsWithBrace=false endsWithBrace=false hasBraces=false hasFence=false/);
  assert.ok(!output.includes("SENTINEL_GARBAGE"));
});

test("error text from the provider is replaced by a fixed phrase", async () => {
  const r = await run({ supervisor: [{ status: 402 }] });
  assert.match(r.error?.message ?? "", /^OpenRouter error: payment required \(402\)$/);
});

test("TRACE_AGENTS prints agent contexts locally, never keys or reasoning, and is refused in production", async () => {
  const on = await run(sensitiveScript(), "SENTINEL_QUESTION about something", undefined, { TRACE_AGENTS: "1" });
  const traced = on.mock.logs.join("\n");
  assert.ok(traced.includes("SENTINEL_QUESTION") && traced.includes("===== SUPERVISOR"));
  for (const secret of [TEST_KEY, TEST_TAVILY_KEY, "SENTINEL_REASONING", "Authorization"]) {
    assert.ok(!traced.includes(secret), `trace leaked ${secret}`);
  }
  const off = await run(sensitiveScript(), "SENTINEL_QUESTION about something", undefined, { TRACE_AGENTS: "1", NODE_ENV: "production" });
  assert.ok(!off.mock.logs.join("\n").includes("SENTINEL_QUESTION"));
  process.env.TRACE_AGENTS = "1";
  process.env.NODE_ENV = "production";
  assert.equal(traceEnabled(), false);
  setTestEnv();
});
