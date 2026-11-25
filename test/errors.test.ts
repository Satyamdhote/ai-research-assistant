import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { AppError, clientError, codeOf, toClientError } from "../src/errors.js";
import { StageFailure } from "../src/request/context.js";
import { createAppServer } from "../src/http/server.js";
import type { ErrorCode, FailureReason } from "../src/types.js";
import { REPORT, TEST_KEY, installMock, notes, route, setTestEnv, type Script } from "./helpers/mock.js";

// Milestone 11: error taxonomy, correlation ids and metrics.

// ---------- taxonomy (pure) ----------
test("every stage failure reason maps to a code, and every code has a fixed status and message", () => {
  const reasons: FailureReason[] = ["invalid_notes", "truncated", "too_many_tool_rounds", "too_many_tool_calls", "malformed_tool_call", "unexpected_tool_call", "model_error", "time_limit", "call_limit"];
  for (const reason of reasons) assert.ok(codeOf(new StageFailure(reason)));
  assert.equal(codeOf(new StageFailure("model_error")), "model_unavailable");
  assert.equal(codeOf(new StageFailure("truncated")), "truncated");
  assert.equal(codeOf(new StageFailure("time_limit")), "timeout");
  assert.equal(codeOf(new AppError("rate_limited", "x")), "rate_limited");
  assert.equal(codeOf(new Error("anything else")), "internal");
  assert.equal(codeOf("not even an error"), "internal");
});

test("statuses are the ones the API always used; 502 stays 502; the message is fixed and generic", () => {
  assert.equal(clientError("bad_request").status, 400);
  assert.equal(clientError("busy").status, 429);
  assert.equal(clientError("approval_expired").status, 410);
  for (const code of ["auth_failed", "payment_required", "rate_limited", "provider_error", "model_unavailable", "truncated", "invalid_output", "timeout", "limit_reached", "internal"] as ErrorCode[]) {
    assert.deepEqual(
      { status: clientError(code).status, error: clientError(code).error },
      { status: 502, error: "The AI model could not answer. Try again." }
    );
  }
});

test("toClientError never copies the error's own text (it may hold provider text or a key)", () => {
  const leaky = new AppError("provider_error", `boom ${TEST_KEY} SENTINEL_PROVIDER_TEXT`);
  assert.ok(!JSON.stringify(toClientError(leaky)).includes("SENTINEL_PROVIDER_TEXT"));
  assert.ok(!JSON.stringify(toClientError(leaky)).includes(TEST_KEY));
});

// ---------- HTTP ----------
type Json = Record<string, any>;
const report = { content: JSON.stringify(REPORT) };
const researchScript = (extra: Partial<Script> = {}): Script => ({
  supervisor: [{ content: route("research_then_analysis") }],
  research: [{ toolCalls: [{ name: "search_web", args: { query: "SENTINEL_QUERY node lts" } }] }, { content: notes() }],
  analysis: [report],
  ...extra,
});

async function withServer(script: Script, work: (api: { base: string; mock: ReturnType<typeof installMock>; ask: (q?: string) => Promise<Response> }) => Promise<void>, env: Record<string, string> = {}) {
  setTestEnv();
  Object.assign(process.env, env);
  const mock = installMock(script);
  const server = createAppServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await work({
      base,
      mock,
      ask: (q = "SENTINEL_QUESTION about node") => fetch(`${base}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q }) }),
    });
  } finally {
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    mock.restore();
    setTestEnv();
  }
}

const metricsOf = async (base: string) => (await (await fetch(`${base}/metrics`)).json()) as Json;

test("each failure kind reaches the client as its own code with the same fixed message", async () => {
  const cases: Array<[string, Script, ErrorCode]> = [
    ["401", { supervisor: [{ status: 401 }] }, "auth_failed"],
    ["402", { supervisor: [{ status: 402 }] }, "payment_required"],
    ["429", { supervisor: [{ status: 429 }] }, "rate_limited"],
    ["500", { supervisor: [{ status: 500 }] }, "provider_error"],
    ["truncated", { supervisor: [{ content: route("analysis_only") }], analysis: [{ content: "{", finish: "length" }] }, "truncated"],
    ["network", { supervisor: [{ content: route("analysis_only") }], analysis: [{ networkError: true }] }, "model_unavailable"],
    ["bad report", { supervisor: [{ content: route("analysis_only") }], analysis: [{ content: "not json at all" }] }, "invalid_output"],
  ];
  for (const [name, script, code] of cases) {
    await withServer(script, async ({ ask }) => {
      const res = await ask();
      assert.equal(res.status, 502, name);
      const body = (await res.json()) as Json;
      assert.equal(body.code, code, name);
      assert.equal(body.error, "The AI model could not answer. Try again.");
    });
  }
});

test("every error body has exactly error, code and request_id, and request_id matches the X-Request-Id header", async () => {
  await withServer({ supervisor: [{ status: 429 }] }, async ({ base, ask }) => {
    for (const res of [await ask(), await fetch(`${base}/nope`), await fetch(`${base}/ask`), await fetch(`${base}/ask`, { method: "POST", body: "{not json" })]) {
      const body = (await res.json()) as Json;
      assert.deepEqual(Object.keys(body).sort(), ["code", "error", "request_id"]);
      const id = String(body.request_id);
      assert.equal(id, res.headers.get("x-request-id"));
      assert.match(id, /^[0-9a-f-]{36}$/);
    }
  });
});

test("a successful answer keeps its exact body and still carries the X-Request-Id header", async () => {
  await withServer({ supervisor: [{ content: route("analysis_only") }], analysis: [report] }, async ({ ask }) => {
    const res = await ask();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), REPORT);
    assert.match(res.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
  });
});

test("the same request id is on every log line of a question, and two questions get different ids", async () => {
  await withServer(
    { supervisor: [{ content: route("research_then_analysis") }, { content: route("analysis_only") }], research: [{ content: notes(null) }], analysis: [report, report] },
    async ({ ask, mock }) => {
      const first = await ask();
      const second = await ask();
      const ids = [first.headers.get("x-request-id"), second.headers.get("x-request-id")];
      assert.notEqual(ids[0], ids[1]);
      const lines = mock.logs.filter((l) => l.startsWith("[agent]"));
      assert.ok(lines.length >= 6);
      for (const line of lines) assert.match(line, /requestId=[0-9a-f-]{36}/);
      for (const id of ids) {
        const own = lines.filter((l) => l.includes(`requestId=${id}`));
        assert.ok(own.some((l) => l.includes("event=request_done")), "each question has its own request_done line");
      }
    }
  );
});

test("a failed question logs request_failed with its code and request id", async () => {
  await withServer({ supervisor: [{ status: 429 }] }, async ({ ask, mock }) => {
    const res = await ask();
    const id = res.headers.get("x-request-id");
    assert.ok(mock.logs.some((l) => l.includes("event=request_failed") && l.includes(`requestId=${id}`) && l.includes("code=rate_limited")));
  });
});

test("metrics count outcomes, calls, searches and latency, and contain numbers only", async () => {
  await withServer(
    {
      supervisor: [{ content: route("research_then_analysis") }, { content: route("analysis_only") }, { status: 429 }],
      research: [{ toolCalls: [{ name: "search_web", args: { query: "SENTINEL_QUERY lts" } }] }, { content: notes() }],
      analysis: [report, report],
    },
    async ({ base, ask }) => {
      assert.equal((await ask()).status, 200);
      assert.equal((await ask()).status, 200);
      assert.equal((await ask()).status, 502);
      assert.equal((await fetch(`${base}/ask`, { method: "POST", body: "{}" })).status, 400);
      const m = await metricsOf(base);
      assert.deepEqual(m.requests, { ok: 2, rate_limited: 1, bad_request: 1 });
      assert.equal(m.model_calls, 4 + 2 + 1); // 4 (research question) + 2 (analysis-only) + 1 (failed supervisor)
      assert.equal(m.tool_calls, 1);
      assert.deepEqual(m.searches, { SEARCH_OK: 1 });
      assert.equal(m.search_retries, 0);
      assert.equal(Object.values(m.latency_ms as Record<string, number>).reduce((a, b) => a + b, 0), 3); // 3 questions reached the agents
      const text = JSON.stringify(m);
      assert.ok(!text.includes("SENTINEL") && !text.includes(TEST_KEY));
      const numbers = (value: unknown): boolean =>
        typeof value === "number" || (typeof value === "object" && value !== null && Object.values(value).every(numbers));
      assert.ok(numbers(m), "only numbers as values");
    }
  );
});

test("a busy server is counted as busy", async () => {
  const slow = { content: route("analysis_only"), delayMs: 300 };
  await withServer({ supervisor: [slow, slow], analysis: [report, report] }, async ({ base, ask }) => {
    const statuses = await Promise.all([ask(), ask(), ask()].map(async (p) => (await p).status));
    assert.deepEqual(statuses.sort(), [200, 200, 429]);
    assert.equal((await metricsOf(base)).requests.busy, 1);
  });
});

test("search retries are counted, and the question, query and key never appear in logs or metrics", async () => {
  await withServer(researchScript({ tavily: [{ status: 500 }, { results: [{ title: "T", url: "https://example.com/one", content: "Snippet" }] }] }), async ({ base, ask, mock }) => {
    assert.equal((await ask()).status, 200);
    const m = await metricsOf(base);
    assert.equal(m.search_retries, 1);
    const everything = mock.logs.join("\n") + JSON.stringify(m);
    for (const secret of ["SENTINEL_QUESTION", "SENTINEL_QUERY", TEST_KEY, "SENTINEL_REASONING"]) assert.ok(!everything.includes(secret), secret);
  });
});

test("with approvals on, a retried search asks the human once, not once per attempt", async () => {
  const script = researchScript({ tavily: [{ status: 500 }, { results: [{ title: "T", url: "https://example.com/one", content: "Snippet" }] }] });
  await withServer(script, async ({ base, ask, mock }) => {
    const pending = (await (await ask()).json()) as Json;
    assert.equal(pending.status, "pending");
    const done = await fetch(`${base}/approvals/${pending.approval_id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
    assert.equal(done.status, 200);
    assert.equal(mock.searches.length, 2); // attempt + retry
    assert.equal(mock.logs.filter((l) => /event=approval .*approval=pending/.test(l)).length, 1);
  }, { REQUIRE_SEARCH_APPROVAL: "1" });
});

test("a rejected approval makes no search attempt at all, so there is nothing to retry", async () => {
  await withServer(researchScript({ tavily: [{ status: 500 }] }), async ({ base, ask, mock }) => {
    const pending = (await (await ask()).json()) as Json;
    const done = await fetch(`${base}/approvals/${pending.approval_id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "reject" }) });
    assert.equal(done.status, 200);
    assert.equal(mock.searches.length, 0);
  }, { REQUIRE_SEARCH_APPROVAL: "1" });
});

test("an expired approval stops the question, is counted as approval_expired, and a late decision gets 409", async () => {
  await withServer(researchScript(), async ({ base, ask }) => {
    const pending = (await (await ask()).json()) as Json;
    await new Promise((resolve) => setTimeout(resolve, 90)); // expired at 60 ms, still remembered until 120 ms
    const gone = await fetch(`${base}/approvals/${pending.approval_id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
    assert.equal(gone.status, 409);
    assert.equal(((await gone.json()) as Json).code, "bad_request");
    assert.equal((await metricsOf(base)).requests.approval_expired, 1);
  }, { REQUIRE_SEARCH_APPROVAL: "1", APPROVAL_TTL_MS: "60" });
});
