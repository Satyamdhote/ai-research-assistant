import { randomUUID } from "node:crypto";
import type { ApprovalAction, ApprovalDecision } from "../types.js";

// Human approval for gated actions (Milestone 10).
//
// A gated action is one whose side effect (here: a web search that costs quota and sends
// model-written text to a third party) must not happen until a human says yes.
//
// State machine (the ONLY legal transitions):
//
//     pending --approve--> approved      (terminal)
//     pending --reject---> rejected      (terminal)
//     pending --timeout--> expired       (terminal; also used when the request is abandoned)
//
// Terminal states never change again, so a second decision on the same approval is an
// InvalidTransition (the HTTP layer answers 409). An approval belongs to exactly ONE request and
// ONE action, both stored by the application; the human's decision carries neither, so it can
// not change what is being approved.
//
// The store is created per app instance and passed down (no module-level state).
// Everything is in memory: a restart forgets pending approvals.

export type ApprovalStatus = "pending" | ApprovalDecision;

export class InvalidTransition extends Error {
  constructor(from: ApprovalStatus, to: ApprovalStatus) {
    super(`Invalid approval transition: ${from} -> ${to}`);
  }
}

export type Approval = {
  readonly id: string;
  readonly action: ApprovalAction;
  readonly status: ApprovalStatus;
  /** Resolves once, with the terminal status. */
  readonly decision: Promise<ApprovalDecision>;
};

type Entry = {
  id: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  decision: Promise<ApprovalDecision>;
  settle: (status: ApprovalDecision) => void;
  expiryTimer: NodeJS.Timeout;
  onExpire?: () => void;
};

export class ApprovalStore {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly ttlMs: number) {}

  get expiresInSeconds(): number {
    return Math.ceil(this.ttlMs / 1000);
  }

  /** Opens a new pending approval. `onExpire` runs only if it ends by timeout or `expire()`. */
  create(action: ApprovalAction, onExpire?: () => void): Approval {
    const id = randomUUID(); // unguessable: knowing the id is what lets someone decide
    let settle!: (status: ApprovalDecision) => void;
    const decision = new Promise<ApprovalDecision>((resolve) => {
      settle = resolve;
    });
    const entry: Entry = {
      id,
      action,
      status: "pending",
      decision,
      settle,
      expiryTimer: setTimeout(() => this.expire(id), this.ttlMs),
      onExpire,
    };
    entry.expiryTimer.unref(); // a pending approval must never keep the process alive
    this.entries.set(id, entry);
    return this.view(entry);
  }

  get(id: string): Approval | undefined {
    const entry = this.entries.get(id);
    return entry ? this.view(entry) : undefined;
  }

  /** A human decision. Throws InvalidTransition unless the approval is still pending. */
  decide(id: string, decision: "approved" | "rejected"): Approval {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown approval");
    return this.finish(entry, decision);
  }

  /** Timeout or abandonment. Does nothing if the approval already has a decision. */
  expire(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== "pending") return;
    this.finish(entry, "expired");
    entry.onExpire?.();
  }

  private finish(entry: Entry, to: ApprovalDecision): Approval {
    if (entry.status !== "pending") throw new InvalidTransition(entry.status, to);
    entry.status = to;
    clearTimeout(entry.expiryTimer);
    entry.settle(to);
    // Keep the finished entry for one TTL so a duplicate decision gets 409, not 404; then forget it.
    setTimeout(() => this.entries.delete(entry.id), this.ttlMs).unref();
    return this.view(entry);
  }

  private view(entry: Entry): Approval {
    return { id: entry.id, action: entry.action, status: entry.status, decision: entry.decision };
  }
}
