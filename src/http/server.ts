import { createServer, type Server } from "node:http";
import express, { type ErrorRequestHandler, type Response } from "express";
import { answerQuestion } from "../agents/orchestrator.js";
import { LIMITS } from "../config.js";

// The HTTP layer: routing, input checks and status codes. It knows nothing about prompts,
// models or tools; it only calls answerQuestion().

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

export function createAppServer(): Server {
  // Questions currently being answered. Each one can use several free-quota model calls.
  let inFlight = 0;

  const app = express();
  app.disable("x-powered-by");

  // Parses the body as JSON whatever the Content-Type, and refuses bodies over the byte limit.
  // Express matches "/ask" ignoring the query string and a trailing slash.
  const parseJson = express.json({ limit: LIMITS.MAX_BODY_BYTES, type: () => true });

  app.post("/ask", parseJson, async (req, res) => {
    // 1. Validate the input.
    const question: unknown = (req.body as { question?: unknown } | undefined)?.question;
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

  app.all("/ask", (_req, res) => sendJson(res, 405, { error: "Use POST" }));
  app.use((_req, res) => sendJson(res, 404, { error: "Not found" }));

  // Body-parser failures arrive here. Responses are fixed messages, never the raw error.
  // Express treats a handler as an error handler only if it declares 4 parameters, so `_next` stays.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const type = (error as { type?: string }).type;
    if (type === "entity.too.large") {
      res.setHeader("Connection", "close");
      return sendJson(res, 413, { error: "Request body too large" });
    }
    if (type === "entity.parse.failed") {
      return sendJson(res, 400, { error: "Body must be valid JSON" });
    }
    console.error("Request failed:", error instanceof Error ? error.message : "unknown error");
    return sendJson(res, 400, { error: "Could not read the request body" });
  };
  app.use(onError);

  return createServer(app);
}
