import { createServer, type Server } from "node:http";
import express, { type ErrorRequestHandler, type Response } from "express";
import { answerQuestion } from "../agents/orchestrator.js";
import { z } from "zod";
import { LIMITS, getApprovalTtlMs, searchApprovalRequired } from "../config.js";
import { logStage } from "../observability/log.js";
import { ApprovalStore, InvalidTransition, type Approval } from "../request/approvals.js";
import type { ApprovalAction, Approver } from "../types.js";

// The HTTP layer: routing, input checks and status codes. It knows nothing about prompts,
// models or tools; it only calls answerQuestion().

function sendJson(res: Response, status: number, body: unknown): void {
  res.status(status).json(body);
}

// One question being answered. With approvals on, it can stop and wait for a human between
// two HTTP calls: /ask reports the first pending approval (202), /approvals/:id resumes it.
type Session = {
  controller: AbortController;
  work: Promise<{ ok: true; value: unknown } | { ok: false }>;
  approvalIds: string[];
  /** Why the question was stopped early, if it was. It decides whether anyone is left to answer. */
  stoppedBy?: "client_left" | "approval_expired";
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

  // Starts answering a question and wires up the approver (only when the server requires approval).
  function startSession(question: string): Session {
    const controller = new AbortController();
    // Approvals created but not yet shown to a client, and callers of next() waiting for one.
    // Both are lists: several searches of one round can ask for approval at the same moment.
    const ready: Approval[] = [];
    const waiters: Array<(approval: Approval | null) => void> = [];
    let finished = false;
    const session: Session = {
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
            logStage({ event: "approval", approval: "expired" });
            session.stoppedBy ??= "approval_expired";
            controller.abort();
          });
          session.approvalIds.push(approval.id);
          sessions.set(approval.id, session);
          logStage({ event: "approval", approval: "pending" });
          const waiter = waiters.shift();
          if (waiter) waiter(approval);
          else ready.push(approval);
          return approval.decision;
        }
      : undefined;
    inFlight += 1;
    session.work = answerQuestion(question, { signal: controller.signal, approver }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => {
        // Our errors carry fixed messages, so only the message is logged (no objects or stacks).
        console.error("Request failed:", error instanceof Error ? error.message : "unknown error");
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
    if (session.stoppedBy === "approval_expired") {
      return sendJson(res, 410, { error: "The approval expired, so the question was stopped. Ask again." });
    }
    sendJson(res, 502, { error: "The AI model could not answer. Try again." });
  }

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
    await respond(res, startSession(question.trim()));
  });

  // A human's decision on a pending approval. The body only says approve or reject: the action is
  // the one the application stored, so a decision can never change what is being approved.
  app.post("/approvals/:id", parseJson, async (req, res) => {
    const id = String(req.params.id);
    if (!approvals.get(id)) return sendJson(res, 404, { error: "Unknown approval" });
    const body = DecisionSchema.safeParse(req.body);
    if (!body.success) return sendJson(res, 400, { error: '"decision" must be "approve" or "reject"' });
    const decision = body.data.decision === "approve" ? "approved" : "rejected";
    const session = sessions.get(id);
    try {
      approvals.decide(id, decision);
    } catch (error) {
      if (error instanceof InvalidTransition) {
        return sendJson(res, 409, { error: "This approval already has a final status" });
      }
      throw error;
    }
    logStage({ event: "approval", approval: decision });
    if (!session) return sendJson(res, 409, { error: "This question is no longer running" });
    await respond(res, session);
  });
  app.all("/approvals/:id", (_req, res) => sendJson(res, 405, { error: "Use POST" }));

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
