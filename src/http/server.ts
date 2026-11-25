import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import express, { type ErrorRequestHandler, type Response } from "express";
import { answerQuestion } from "../agents/orchestrator.js";
import { z } from "zod";
import { LIMITS, getApprovalTtlMs, searchApprovalRequired } from "../config.js";
import { clientError, codeOf } from "../errors.js";
import { logStage } from "../observability/log.js";
import { Metrics } from "../observability/metrics.js";
import { ApprovalStore, InvalidTransition, type Approval } from "../request/approvals.js";
import type { ApprovalAction, Approver, ErrorCode, RequestStats } from "../types.js";

// The HTTP layer: routing, input checks and status codes. It knows nothing about prompts,
// models or tools; it only calls answerQuestion().

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

// Every error body has the same three fields: a fixed message, a fixed `code` (see src/errors.ts)
// and the request's opaque id (also sent as the X-Request-Id header). Nothing else, ever.
function sendError(res: Response, code: ErrorCode, overrides: { status?: number; message?: string } = {}): void {
  const { status, error } = clientError(code);
  sendJson(res, overrides.status ?? status, {
    error: overrides.message ?? error,
    code,
    request_id: String(res.locals.requestId ?? ""),
  });
}

// One question being answered. With approvals on, it can stop and wait for a human between
// two HTTP calls: /ask reports the first pending approval (202), /approvals/:id resumes it.
type Session = {
  requestId: string;
  controller: AbortController;
  work: Promise<{ ok: true; value: unknown } | { ok: false }>;
  approvalIds: string[];
  /** Why the question was stopped early, if it was. It decides whether anyone is left to answer. */
  stoppedBy?: "client_left" | "approval_expired";
  /** The error code of the failure, once the question has failed. */
  failure?: ErrorCode;
  /** Resolves with the next approval that needs a human, or null when the question is finished. */
  next(): Promise<Approval | null>;
  /** The client left: stop the work and expire its approvals. */
  abort(): void;
};

const DecisionSchema = z.object({ decision: z.enum(["approve", "reject"]) }).strict();

export function createAppServer(): Server {
  // Questions currently being answered. Each one can use several free-quota model calls.
  let inFlight = 0;
  const approvals = new ApprovalStore(getApprovalTtlMs());
  const sessions = new Map<string, Session>(); // approval id -> the question waiting on it
  const metrics = new Metrics();

  // Starts answering a question and wires up the approver (only when the server requires approval).
  function startSession(question: string, requestId: string): Session {
    const controller = new AbortController();
    // Approvals created but not yet shown to a client, and callers of next() waiting for one.
    // Both are lists: several searches of one round can ask for approval at the same moment.
    const ready: Approval[] = [];
    const waiters: Array<(approval: Approval | null) => void> = [];
    let finished = false;
    let stats: RequestStats | undefined;
    const session: Session = {
      requestId,
      controller,
      approvalIds: [],
      work: undefined as never,
      next: () =>
        new Promise((resolve) => {
          // Skip approvals that already ended (expired) before anyone saw them.
          while (ready.length > 0) {
            const candidate = ready.shift() as Approval;
            if (approvals.get(candidate.id)?.status === "pending") return resolve(candidate);
          }
          if (finished) resolve(null);
          else waiters.push(resolve);
        }),
      abort() {
        session.stoppedBy ??= "client_left"; // set first: the expiry callback below must not overwrite it
        controller.abort();
        for (const id of session.approvalIds) approvals.expire(id); // wakes a waiting search
      },
    };
    const approver: Approver | undefined = searchApprovalRequired()
      ? (action: ApprovalAction) => {
          // Timed out or abandoned: stop the whole question, nobody is left to answer.
          const approval = approvals.create(action, () => {
            logStage({ event: "approval", requestId, approval: "expired" });
            session.stoppedBy ??= "approval_expired";
            controller.abort();
          });
          session.approvalIds.push(approval.id);
          sessions.set(approval.id, session);
          logStage({ event: "approval", requestId, approval: "pending" });
          const waiter = waiters.shift();
          if (waiter) waiter(approval);
          else ready.push(approval);
          return approval.decision;
        }
      : undefined;
    inFlight += 1;
    session.work = answerQuestion(question, {
      signal: controller.signal,
      approver,
      requestId,
      onFinish: (finished) => {
        stats = finished;
      },
    }).then(
      (value) => {
        metrics.recordRequest("ok", stats);
        return { ok: true as const, value };
      },
      (error: unknown) => {
        // Why it failed: a stop we caused (client left, approval expired) outranks the error that stop produced.
        const code: ErrorCode =
          session.stoppedBy === "approval_expired" ? "approval_expired" : session.stoppedBy === "client_left" ? "cancelled" : codeOf(error);
        session.failure = code;
        // Our errors carry fixed messages, so only the message is logged (no objects or stacks).
        console.error("Request failed:", error instanceof Error ? error.message : "unknown error");
        logStage({ event: "request_failed", requestId, code, ...(stats ? { modelCalls: stats.modelCalls, elapsedMs: stats.elapsedMs } : {}) });
        metrics.recordRequest(code, stats);
        return { ok: false as const };
      }
    );
    void session.work.then(() => {
      finished = true;
      inFlight -= 1;
      for (const id of session.approvalIds) sessions.delete(id);
      for (const waiter of waiters.splice(0)) waiter(null);
    });
    return session;
  }

  // Sends the next thing the client should see: a pending approval (202) or the final answer.
  async function respond(res: Response, session: Session): Promise<void> {
    // If the client leaves while we wait (before the response is finished), stop the work.
    res.on("close", () => {
      if (!res.writableFinished) session.abort();
    });
    const approval = await session.next();
    if (approval) {
      return sendJson(res, 202, {
        approval_id: approval.id,
        status: "pending",
        action: approval.action,
        expires_in_s: approvals.expiresInSeconds,
      });
    }
    const outcome = await session.work;
    if (outcome.ok) return sendJson(res, 200, outcome.value);
    // The client left: nobody is waiting for an answer. An expired approval, however, may leave a
    // client waiting, and it must get an answer (not a hung connection).
    if (session.stoppedBy === "client_left") return;
    sendError(res, session.failure ?? "internal"); // an expired approval gives 410, everything else the 502 it always did
  }

  const app = express();
  app.disable("x-powered-by");

  // Every request gets an opaque id (header + error bodies + log lines). It carries no user data.
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader("X-Request-Id", res.locals.requestId as string);
    next();
  });

  // Parses the body as JSON whatever the Content-Type, and refuses bodies over the byte limit.
  // Express matches "/ask" ignoring the query string and a trailing slash.
  const parseJson = express.json({ limit: LIMITS.MAX_BODY_BYTES, type: () => true });

  app.post("/ask", parseJson, async (req, res) => {
    // 1. Validate the input.
    const question: unknown = (req.body as { question?: unknown } | undefined)?.question;
    if (typeof question !== "string" || question.trim() === "") {
      metrics.recordRequest("bad_request");
      return sendError(res, "bad_request", { message: '"question" must be a non-empty string' });
    }

    // 2. Limit how many questions run at once.
    if (inFlight >= LIMITS.MAX_CONCURRENT_REQUESTS) {
      metrics.recordRequest("busy");
      return sendError(res, "busy");
    }

    // 3. Ask the agents. If the client disconnects before we answer, stop the work.
    await respond(res, startSession(question.trim(), res.locals.requestId as string));
  });

  // A human's decision on a pending approval. The body only says approve or reject: the action is
  // the one the application stored, so a decision can never change what is being approved.
  app.post("/approvals/:id", parseJson, async (req, res) => {
    const id = String(req.params.id);
    if (!approvals.get(id)) return sendError(res, "bad_request", { status: 404, message: "Unknown approval" });
    const body = DecisionSchema.safeParse(req.body);
    if (!body.success) return sendError(res, "bad_request", { message: '"decision" must be "approve" or "reject"' });
    const decision = body.data.decision === "approve" ? "approved" : "rejected";
    const session = sessions.get(id);
    try {
      approvals.decide(id, decision);
    } catch (error) {
      if (error instanceof InvalidTransition) {
        return sendError(res, "bad_request", { status: 409, message: "This approval already has a final status" });
      }
      throw error;
    }
    logStage({ event: "approval", ...(session ? { requestId: session.requestId } : {}), approval: decision });
    if (!session) return sendError(res, "bad_request", { status: 409, message: "This question is no longer running" });
    res.setHeader("X-Request-Id", session.requestId); // the question keeps its own id across both HTTP calls
    res.locals.requestId = session.requestId;
    await respond(res, session);
  });
  app.all("/approvals/:id", (_req, res) => sendError(res, "bad_request", { status: 405, message: "Use POST" }));

  // Counters for this process: numbers only (see src/observability/metrics.ts).
  app.get("/metrics", (_req, res) => sendJson(res, 200, metrics.snapshot()));

  app.all("/ask", (_req, res) => sendError(res, "bad_request", { status: 405, message: "Use POST" }));
  app.use((_req, res) => sendError(res, "bad_request", { status: 404, message: "Not found" }));

  // Body-parser failures arrive here. Responses are fixed messages, never the raw error.
  // Express treats a handler as an error handler only if it declares 4 parameters, so `_next` stays.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const type = (error as { type?: string }).type;
    if (type === "entity.too.large") {
      res.setHeader("Connection", "close");
      metrics.recordRequest("bad_request");
      return sendError(res, "bad_request", { status: 413, message: "Request body too large" });
    }
    if (type === "entity.parse.failed") {
      metrics.recordRequest("bad_request");
      return sendError(res, "bad_request", { message: "Body must be valid JSON" });
    }
    console.error("Request failed:", error instanceof Error ? error.message : "unknown error");
    metrics.recordRequest("bad_request");
    return sendError(res, "bad_request", { message: "Could not read the request body" });
  };
  app.use(onError);

  return createServer(app);
}
