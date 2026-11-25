import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ApprovalStore, InvalidTransition } from "../src/request/approvals.js";
import { LIMITS } from "../src/config.js";
import { createRequestContext } from "../src/request/context.js";
import { createAppServer } from "../src/http/server.js";
import { REPORT, installMock, notes, route, setTestEnv, type Script } from "./helpers/mock.js";

const ACTION = { tool: "search_web", query: "SENTINEL_QUERY node lts" } as const;

// ---------- state machine ----------
test("approval: pending -> approved/rejected, both terminal", async () => {
  const store = new ApprovalStore(10_000);
  const a = store.create(ACTION);
  assert.equal(a.status, "pending");
  store.decide(a.id, "approved");
  assert.equal(await a.decision, "approved");
  assert.equal(store.get(a.id)?.status, "approved");
  const b = store.create(ACTION);
  store.decide(b.id, "rejected");
  assert.equal(await b.decision, "rejected");
});

test("approval: invalid transitions throw (duplicate, approve-after-reject, decide-after-expire)", async () => {
  const store = new ApprovalStore(10_000);
  const a = store.create(ACTION);
  store.decide(a.id, "approved");
  assert.throws(() => store.decide(a.id, "approved"), InvalidTransition);
  assert.throws(() => store.decide(a.id, "rejected"), InvalidTransition);
  const b = store.create(ACTION);
  store.expire(b.id);
  assert.equal(await b.decision, "expired");
  assert.throws(() => store.decide(b.id, "approved"), InvalidTransition);
  store.expire(a.id); // expiring a decided approval is a no-op
  assert.equal(store.get(a.id)?.status, "approved");
});

test("approval: expires by itself after the TTL and calls onExpire once", async () => {
  const store = new ApprovalStore(30);
  let expired = 0;
  const a = store.create(ACTION, () => (expired += 1));
  assert.equal(await a.decision, "expired");
  assert.equal(expired, 1);
  assert.throws(() => store.decide(a.id, "approved"), InvalidTransition);
});

test("approval: a human decision cancels the timer (onExpire never runs)", async () => {
  const store = new ApprovalStore(30);
  let expired = 0;
  const a = store.create(ACTION, () => (expired += 1));
  store.decide(a.id, "approved");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(expired, 0);
});

test("approval ids are unique UUIDs", () => {
  const store = new ApprovalStore(10_000);
  const ids = new Set(Array.from({ length: 20 }, () => store.create(ACTION).id));
  assert.equal(ids.size, 20);
  for (const id of ids) assert.match(id, /^[0-9a-f-]{36}$/);
});

// ---------- context: the human wait does not eat the deadline ----------
test("requestApproval: no approver means approved; waiting time is not charged to the deadline", async () => {
  setTestEnv();
  assert.equal(await createRequestContext().requestApproval(ACTION), "approved");
  const ctx = createRequestContext(undefined, () => new Promise((r) => setTimeout(() => r("approved"), 300)));
  const before = ctx.remainingMs();
  await ctx.requestApproval(ACTION);
  assert.ok(ctx.remainingMs() >= before - 100, "a 300 ms human wait must not shrink the deadline");
});

// ---------- HTTP flow ----------
type Json = Record<string, any>;
const researchScript = (extra: Partial<Script> = {}): Script => ({
  supervisor: [{ content: route("research_then_analysis") }],
  research: [{ toolCalls: [{ name: "search_web", args: { query: "SENTINEL_QUERY node lts" } }] }, { content: notes() }],
  analysis: [{ content: JSON.stringify(REPORT) }],
  ...extra,
});

type Api = {
  ask: () => Promise<Response>;
  decide: (id: string, body: unknown) => Promise<Response>;
  mock: ReturnType<typeof installMock>;
  base: string;
};

async function withApprovalServer(
  script: Script,
  work: (api: Api) => Promise<void>,
  env: Record<string, string> = { REQUIRE_SEARCH_APPROVAL: "1" }
) {
  setTestEnv();
  Object.assign(process.env, env);
  const mock = installMock(script);
  const server = createAppServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: string) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  try {
    await work({
      ask: () => post("/ask", JSON.stringify({ question: "What is the latest Node LTS?" })),
      decide: (id, body) => post(`/approvals/${id}`, typeof body === "string" ? body : JSON.stringify(body)),
      mock,
      base,
    });
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    mock.restore();
    setTestEnv();
  }
}

test("202 pending: nothing is searched before approval; approve runs exactly one search", async () => {
  await withApprovalServer(researchScript(), async ({ ask, decide, mock }) => {
    const res = await ask();
    assert.equal(res.status, 202);
    const pending = (await res.json()) as Json;
    assert.equal(pending.status, "pending");
    assert.deepEqual(pending.action, { tool: "search_web", query: "SENTINEL_QUERY node lts" });
    assert.equal(mock.searches.length, 0, "no search may run before approval");
    const done = await decide(pending.approval_id, { decision: "approve" });
    assert.equal(done.status, 200);
    const body = (await done.json()) as Json;
    assert.equal(body.title, REPORT.title);
    assert.ok(Array.isArray(body.evidence));
    assert.equal(mock.searches.length, 1);
    assert.deepEqual(mock.calls.map((c) => c.agent), ["supervisor", "research", "research", "analysis"]);
  });
});

test("reject: no search, the model is told, a report is still returned", async () => {
  await withApprovalServer(
    researchScript({
      research: [{ toolCalls: [{ name: "search_web", args: { query: "SENTINEL_QUERY node lts" } }] }, { content: notes(null) }],
    }),
    async ({ ask, decide, mock }) => {
      const pending = (await (await ask()).json()) as Json;
      const done = await decide(pending.approval_id, { decision: "reject" });
      assert.equal(done.status, 200);
      assert.equal(mock.searches.length, 0);
      assert.match(mock.analysisInput(), /search_outcomes: NOT_USED/);
      const toolMsg = JSON.stringify(mock.calls.filter((c) => c.agent === "research")[1]!.body.messages);
      assert.match(toolMsg, /not approved by a human/);
    }
  );
});

test("duplicate decision 409, unknown id 404, bad body 400", async () => {
  await withApprovalServer(researchScript(), async ({ ask, decide }) => {
    const pending = (await (await ask()).json()) as Json;
    assert.equal((await decide("00000000-0000-0000-0000-000000000000", { decision: "approve" })).status, 404);
    assert.equal((await decide(pending.approval_id, { decision: "maybe" })).status, 400);
    assert.equal(
      (await decide(pending.approval_id, { decision: "approve", query: "evil" })).status,
      400,
      "the decision cannot carry a new query"
    );
    assert.equal((await decide(pending.approval_id, "not json{")).status, 400);
    assert.equal((await decide(pending.approval_id, { decision: "approve" })).status, 200);
    assert.equal((await decide(pending.approval_id, { decision: "approve" })).status, 409);
    assert.equal((await decide(pending.approval_id, { decision: "reject" })).status, 409);
  });
});

test("expiry: no search ever runs and a late decision gets 409", async () => {
  await withApprovalServer(
    researchScript(),
    async ({ ask, decide, mock }) => {
      const pending = (await (await ask()).json()) as Json;
      await new Promise((r) => setTimeout(r, 150)); // expired at 100 ms; the finished entry is remembered until 200 ms
      assert.equal((await decide(pending.approval_id, { decision: "approve" })).status, 409);
      assert.equal(mock.searches.length, 0);
    },
    { REQUIRE_SEARCH_APPROVAL: "1", APPROVAL_TTL_MS: "100" }
  );
});

test("policy off (default): /ask behaves as before, no 202", async () => {
  await withApprovalServer(
    researchScript(),
    async ({ ask, mock }) => {
      const res = await ask();
      assert.equal(res.status, 200);
      assert.equal(mock.searches.length, 1);
    },
    {}
  );
});

test("logs show the approval state but never the query or the approval id", async () => {
  await withApprovalServer(researchScript(), async ({ ask, decide, mock }) => {
    const pending = (await (await ask()).json()) as Json;
    await decide(pending.approval_id, { decision: "approve" });
    const output = mock.logs.join("\n");
    assert.match(output, /event=approval .*approval=pending/);
    assert.match(output, /event=approval .*approval=approved/);
    assert.ok(!output.includes("SENTINEL_QUERY"));
    assert.ok(!output.includes(pending.approval_id));
  });
});

test("a client that leaves while waiting for the answer stops the work (the question never finishes)", async () => {
  await withApprovalServer(
    researchScript({ analysis: [{ content: JSON.stringify(REPORT), delayMs: 600 }] }),
    async ({ ask, base, mock }) => {
      const pending = (await (await ask()).json()) as Json;
      const controller = new AbortController();
      const waiting = fetch(`${base}/approvals/${pending.approval_id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
        signal: controller.signal,
      }).catch(() => "aborted");
      await new Promise((r) => setTimeout(r, 150)); // the analysis call is now in flight
      controller.abort();
      assert.equal(await waiting, "aborted");
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(mock.logs.every((line) => !line.includes("event=request_done")), "an abandoned question must not finish");
    }
  );
});

// ---------- review fixes: several approvals in one question ----------
const searchCall = (n: number) => ({ name: "search_web", args: { query: `SENTINEL_QUERY number ${n}` }, id: `call_${n}` });

test("three parallel searches: the two that fit the budget are each shown, none is lost, the third is never asked", async () => {
  await withApprovalServer(
    researchScript({ research: [{ toolCalls: [searchCall(1), searchCall(2), searchCall(3)] }, { content: notes(null) }] }),
    async ({ ask, decide, mock }) => {
      const first = await ask();
      assert.equal(first.status, 202);
      const a = (await first.json()) as Json;
      assert.equal(a.action.query, "SENTINEL_QUERY number 1");

      const second = await decide(a.approval_id, { decision: "approve" });
      assert.equal(second.status, 202, "the second approval must be shown, not lost");
      const b = (await second.json()) as Json;
      assert.equal(b.action.query, "SENTINEL_QUERY number 2");

      const done = await decide(b.approval_id, { decision: "approve" });
      assert.equal(done.status, 200);
      assert.equal(mock.searches.length, 2);
      const approvalsAsked = mock.logs.filter((l) => /event=approval .*approval=pending/.test(l)).length;
      assert.equal(approvalsAsked, 2, "no human is asked about the third search");
      const toolMessages = mock.calls.filter((c) => c.agent === "research")[1]!.body.messages.filter((m: any) => m.role === "tool");
      assert.equal(toolMessages.length, 3);
      assert.ok(toolMessages.some((m: any) => /search limit reached/.test(m.content)));
    }
  );
});

test("a rejected search gives its budget back, so a later search can still be asked about", async () => {
  await withApprovalServer(
    researchScript({
      research: [
        { toolCalls: [searchCall(1), searchCall(2)] },
        { toolCalls: [searchCall(3)] },
        { content: notes(null) },
      ],
    }),
    async ({ ask, decide, mock }) => {
      const a = (await (await ask()).json()) as Json;
      const bRes = await decide(a.approval_id, { decision: "reject" });
      assert.equal(bRes.status, 202);
      const b = (await bRes.json()) as Json;
      const cRes = await decide(b.approval_id, { decision: "reject" });
      assert.equal(cRes.status, 202, "the budget of both rejected searches was refunded, so search 3 is asked about");
      const c = (await cRes.json()) as Json;
      assert.equal(c.action.query, "SENTINEL_QUERY number 3");
      assert.equal((await decide(c.approval_id, { decision: "approve" })).status, 200);
      assert.equal(mock.searches.length, 1, "only the approved search ran");
    }
  );
});

test("budget: a refund never creates more than the per-request maximum", () => {
  setTestEnv();
  const ctx = createRequestContext();
  ctx.refundSearch(); // nothing was taken, so nothing comes back
  const taken = Array.from({ length: 6 }, () => ctx.spendSearch()).filter(Boolean).length;
  assert.equal(taken, LIMITS.MAX_SEARCHES_PER_REQUEST);
  ctx.refundSearch();
  assert.equal(ctx.spendSearch(), true);
  assert.equal(ctx.spendSearch(), false);
});
