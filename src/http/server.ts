import { createServer, type Server, type ServerResponse } from "node:http";
import { answerQuestion } from "../agents/orchestrator.js";
import { LIMITS } from "../config.js";
import { BodyTooLargeError, readBody } from "./readBody.js";

// The HTTP layer: routing, input checks and status codes. It knows nothing about prompts,
// models or tools; it only calls answerQuestion().

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createAppServer(): Server {
  // Questions currently being answered. Each one can use several free-quota model calls.
  let inFlight = 0;

  return createServer(async (req, res) => {
    // Match on the path only, so "/ask?x=1" and "/ask/" both reach the route.
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "");
    if (pathname !== "/ask") {
      return sendJson(res, 404, { error: "Not found" });
    }
    if (req.method !== "POST") {
      return sendJson(res, 405, { error: "Use POST" });
    }

    // 1. Parse and validate the input.
    let question: unknown;
    try {
      question = (JSON.parse(await readBody(req)) as { question?: unknown }).question;
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        res.setHeader("Connection", "close");
        return sendJson(res, 413, { error: "Request body too large" });
      }
      return sendJson(res, 400, { error: "Body must be valid JSON" });
    }
    if (typeof question !== "string" || question.trim() === "") {
      return sendJson(res, 400, { error: '"question" must be a non-empty string' });
    }

    // 2. Limit how many questions run at once.
    if (inFlight >= LIMITS.MAX_CONCURRENT_REQUESTS) {
      return sendJson(res, 429, { error: "Too many questions in progress. Try again shortly." });
    }

    // 3. Ask the agents. If the client disconnects before we answer, stop the work.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    inFlight += 1;
    try {
      const result = await answerQuestion(question.trim(), { signal: controller.signal });
      sendJson(res, 200, result);
    } catch (error) {
      // Our errors carry fixed messages, so only the message is logged (no objects or stacks).
      console.error("Request failed:", error instanceof Error ? error.message : "unknown error");
      if (!controller.signal.aborted) {
        sendJson(res, 502, { error: "The AI model could not answer. Try again." });
      }
    } finally {
      inFlight -= 1;
    }
  });
}
