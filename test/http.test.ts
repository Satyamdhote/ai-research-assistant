import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAppServer } from "../src/http/server.js";
import { REPORT, TEST_KEY, installMock, route, setTestEnv, type Script } from "./helpers/mock.js";

const report = { content: JSON.stringify(REPORT) };

// Starts the real server on a free port with the mock installed, runs the test, cleans up.
async function withServer(script: Script, work: (url: string, mock: ReturnType<typeof installMock>) => Promise<void>) {
  setTestEnv();
  const mock = installMock(script);
  const server = createAppServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    await work(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, mock);
  } finally {
    await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    mock.restore();
  }
}

const post = (url: string, body: string) =>
  fetch(`${url}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body });

test("200: a valid question returns the report", async () => {
  await withServer({ supervisor: [{ content: route("analysis_only") }], analysis: [report] }, async (url) => {
    const res = await post(url, JSON.stringify({ question: "What is an AI agent?" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), REPORT);
  });
});

test("404 for other paths, 405 for other methods", async () => {
  await withServer({}, async (url) => {
    assert.equal((await fetch(`${url}/nope`)).status, 404);
    assert.equal((await fetch(`${url}/ask`)).status, 405);
  });
});

test("400 for invalid JSON, a missing question, a blank question and a non-string question", async () => {
  await withServer({}, async (url) => {
    for (const body of ["{not json", "{}", '{"question":"   "}', '{"question":42}']) {
      assert.equal((await post(url, body)).status, 400, body);
    }
  });
});

test("413 for an oversized body, counted in BYTES (6000 two-byte characters is 12000 bytes)", async () => {
  await withServer({}, async (url) => {
    assert.equal((await post(url, JSON.stringify({ question: "x".repeat(11_000) }))).status, 413);
    assert.equal((await post(url, JSON.stringify({ question: "é".repeat(6_000) }))).status, 413);
  });
});

test("the route matches the path only: a query string and a trailing slash still reach /ask", async () => {
  await withServer({}, async (url) => {
    assert.equal((await fetch(`${url}/ask?debug=1`)).status, 405);
    assert.equal((await fetch(`${url}/ask/`)).status, 405);
  });
});

test("502 with a generic message, and no key or provider text in it", async () => {
  await withServer({ supervisor: [{ status: 429 }] }, async (url) => {
    const res = await post(url, JSON.stringify({ question: "q" }));
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: "The AI model could not answer. Try again." });
    assert.ok(!text.includes(TEST_KEY));
  });
});

test("429 when too many questions are already being answered", async () => {
  const slow = { content: route("analysis_only"), delayMs: 300 };
  await withServer({ supervisor: [slow, slow], analysis: [report, report] }, async (url) => {
    const statuses = await Promise.all([1, 2, 3].map(async () => (await post(url, JSON.stringify({ question: "q" }))).status));
    assert.deepEqual(statuses.sort(), [200, 200, 429]);
  });
});

test("a client that hangs up stops the work and no analysis call is made", async () => {
  await withServer(
    { supervisor: [{ content: route("analysis_only"), delayMs: 1000 }], analysis: [report] },
    async (url, mock) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 150);
      const hangUp = fetch(`${url}/ask`, { method: "POST", body: JSON.stringify({ question: "q" }), signal: controller.signal });
      await assert.rejects(hangUp);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.ok(mock.logs.some((l) => l.includes("Request cancelled")));
      assert.ok(!mock.calls.some((c) => c.agent === "analysis"));
    }
  );
});
