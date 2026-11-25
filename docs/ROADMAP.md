# AI Research Assistant: Learning Roadmap

## Project goal

Build a practical, API-only multi-agent AI research assistant while learning the engineering concepts behind it. The project is developed incrementally with Node.js, TypeScript, Express, OpenRouter, Zod, and native tools where practical.

## Working principles

- Learn one milestone at a time; understand the design before implementation.
- Inspect the current code before proposing changes.
- Plan substantial work first and wait for explicit approval before implementation.
- Prefer simple, understandable implementations over unnecessary frameworks or dependencies.
- Keep explanations, prompts, and implementation scope concise.
- Preserve the API-only architecture; do not add a frontend unless explicitly requested.
- Use free OpenRouter model variants only. Keep `allow_fallbacks: false`.
- Never add paid fallbacks, automatic top-ups, or payment flows.
- Preserve and enforce model-call, search, token, and time budgets. Any proposed change must be explicit and justified.
- Never expose or commit API keys, `.env` files, credentials, or sensitive data.
- Test with mocks before live API calls. Obtain explicit approval before any live API test.
- Use feature branches and pull requests. Never force-push or push directly to `main`.
- After each milestone, report changed files, concepts learned, tests, resource costs, limitations, and remaining work.
- Update this roadmap only after checking what is actually implemented and tested. Do not mark work complete based only on a plan.

## Technology and project constraints

- Runtime: Node.js with TypeScript
- API: Express; API-only, tested with tools such as curl or Postman
- LLM provider: OpenRouter
- Validation: Zod
- HTTP: Node's built-in `fetch` where suitable
- No orchestration framework unless a later, explicit learning objective justifies one
- Keep free-model safeguards active on every model request

## Milestone tracker

| # | Milestone | Status |
|---|---|---|
| 1 | LLM API integration and basic question-answering agent | Complete |
| 2 | System prompts and research-agent behavior | Complete |
| 3 | Structured outputs and Zod validation | Complete |
| 4 | Tool-calling fundamentals | Complete |
| 5 | Web search integration | Complete |
| 6 | Supervisor and specialist agents | Complete |
| 7 | Parallel agent execution (scoped to parallel tool calls) | Complete |
| 8 | Shared context and state management | Complete |
| 9 | Evidence verification | Complete |
| 10 | Human approval workflow | Complete |
| 11 | Retries, error handling, and observability | **Next** |
| 12 | Production evolution | Planned |

**Current next action:** Plan Milestone 11 (retries, error handling, and observability) by inspecting the existing implementation. Do not implement until the plan is reviewed and approved.

---

## Completed milestones

### Milestone 1: LLM API integration and basic agent

**Learning objectives**
- Call an LLM API from Node.js.
- Understand chat messages, request parameters, and model responses.
- Load configuration from environment variables.

**Outcome recorded**
- Basic API-backed question-answering flow.
- OpenRouter integration using a free model variant.
- API key loaded from `.env`, which must remain untracked.

### Milestone 2: System prompts and research-agent behavior

**Learning objectives**
- Separate system instructions from user input.
- Shape response behavior and communicate uncertainty.
- Avoid claiming research or tool use that did not happen.

**Outcome recorded**
- Dedicated prompt module.
- Instructions for clear, balanced, structured, appropriately concise answers.

### Milestone 3: Structured outputs and Zod

**Learning objectives**
- Request machine-readable model output.
- Parse and validate model responses.
- Distinguish syntactically valid JSON from data that satisfies an application contract.

**Outcome recorded**
- Strict `ResearchSchema` and inferred TypeScript type.
- Parsing and validation of model output.
- Existing report contract returns a structured five-field report.

### Milestone 4: Tool-calling fundamentals

**Learning objectives**
- Understand the difference between a model requesting a tool and application code executing it.
- Validate tool arguments and enforce an application-owned allow-list.
- Bound tool loops and correctly pair tool-call IDs with tool results.

**Outcome recorded**
- `get_current_date` tool.
- Bounded tool loop and validated tool arguments.
- Application-controlled execution rather than model-controlled code execution.

### Milestone 5: Web search integration

**Learning objectives**
- Connect an external search service as an application tool.
- Handle empty results, provider failures, timeouts, and invalid requests.
- Treat retrieved web content as untrusted input.

**Outcome recorded**
- Tavily-backed `search_web` tool.
- Two-search-per-request budget.
- Distinct outcomes: `SEARCH_OK`, `SEARCH_OK_NO_RESULTS`, and `SEARCH_UNAVAILABLE`.
- Search availability is not assumed when a search fails or returns no results.

### Milestone 6: Supervisor and specialist agents

**Learning objectives**
- Separate routing, research, and analysis responsibilities.
- Understand an orchestrator-controlled, hub-and-spoke agent pattern.
- Validate inter-agent inputs and outputs.
- Enforce request-level budgets and preserve provenance.

**Outcome recorded**
- Supervisor chooses `analysis_only` or `research_then_analysis`.
- Research specialist can use the existing date and web-search tools.
- Analysis specialist produces the final structured report.
- Live tests confirmed two model calls for the analysis-only route and four for the research route.
- App-observed search outcomes and returned source URLs are used to constrain attribution.
- Tolerant parsing may handle formatting irregularities, but strict Zod validation remains authoritative.

### Milestone 7: Parallel agent execution (scoped to parallel tool calls)

**Learning objectives**
- Understand concurrency versus parallelism in Node.js.
- Use `Promise.all()` for independent work.
- Identify task dependencies and avoid parallelizing work that depends on unfinished research.
- Handle partial failures and cancellation safely.
- Measure latency changes and resource usage.

**Outcome recorded**
- Dependency analysis: supervisor, research, and analysis form a dependency chain, so the only independent work is the tool calls of one model reply.
- Those tool calls now run with `Promise.all` in `runAgent.ts`; results are recorded afterwards in request order.
- The search budget stays race-free because its check and decrement are synchronous (documented in code).
- Mocked tests (56/56 total, 5 new) cover overlap, ordering, partial failure, budget, and cancellation.
- Latency with mocked 200 ms searches: about 420 ms sequential vs about 215 ms parallel.
- Design documented in `docs/architecture.md`.
- No live API tests; model-call, search, deadline, and API contract unchanged.

**Not done**
- Parallel research agents (two research specialists on independent sub-questions). This needs a route schema change and a budget decision, so it needs separate approval.

### Milestone 8: Shared context and state management

**Learning objectives**
- Understand request-scoped context and state.
- Pass relevant information between agents without sharing entire conversation histories unnecessarily.
- Define ownership and mutation rules for shared state.
- Prevent cross-request data leakage.

**Outcome recorded**
- Audit: no module-level mutable state in `src/`, so a request's state can only live in its `RequestContext`.
- `src/request/context.ts` is now the only writer of request state. Other modules read through `readonly` views and change state via `countModelCall()`, `spendSearch()` and `recordSearch()`; the search budget and analysis-reserve switch are private.
- `callModel` and the tools receive narrow `ModelContext` / `ToolContext` types instead of the full context.
- New size limit: `MAX_OBSERVED_URLS` (50) caps the observed-URL set; the search budget check-and-spend stays synchronous for parallel tools.
- Agents still do not share message lists; the orchestrator passes only validated notes plus an application-written status block.
- Lifecycle, owners and rules documented in `docs/architecture.md` ("Request state").
- Mocked tests: 62/62 total, 6 new in `test/state.test.ts` (context isolation, budget exhaustion, call numbering, URL de-duplication and cap, reserve reset, two overlapping requests with no leakage). Typecheck, lint and build pass.
- No live API tests; model-call, search, deadline limits and the `/ask` contract unchanged.

**Not done**
- No persistence or state store (not approved; state stays request-scoped).
- `recordSearch` relies on the caller to pass normalized URLs (`normalizeUrl` lives in `tools`).

### Milestone 9: Evidence verification

**Learning objectives**
- Distinguish claims, evidence, and inference.
- Verify that cited sources were actually retrieved.
- Detect unsupported claims and conflicting evidence.
- Communicate uncertainty and research gaps.

**Completion criteria**
- Verification logic has explicit rules and validated inputs/outputs.
- Claims cannot be marked verified solely because an agent says so.
- Mock tests cover missing, irrelevant, conflicting, and unobserved sources.
- The report clearly distinguishes supported findings from uncertainty.

**Outcome recorded**
- `src/agents/verify.ts` (pure code, no model call) gives each research finding a status: `supported`, `weak`, `conflicting`, `unsourced` or `unverified`. Status never comes from a model.
- `recordSearch` now also stores a capped snippet per observed URL (`observedSnippets`, `MAX_STORED_SNIPPET_CHARS` 700); still written only by `request/context.ts`.
- The analysis stage receives `evidence_check` counts and a status per finding; its prompt separates supported findings from uncertainty.
- `/ask` has an additive optional `evidence` array (present only when research ran); other fields unchanged. This API change was explicitly approved by the user on 2026-11-25 (code review finding 5). Output is validated by `EvidenceListSchema`; a verification failure degrades to `unverified` instead of failing the request.
- Review fixes (2026-11-25): `supported` now also requires every number in the claim to appear in the snippet and the claim to agree with its best-matching snippet sentence on negation; `conflicting` compares numbers only when they follow the same key word, and a bare `no` (as in "no. 1") is no longer a negation.
- Mocked tests: 84/84 (22 new: 19 in `test/verify.test.ts`, 2 in `test/agents.test.ts`, 1 HTTP end-to-end including prompt-injection text in a snippet). Typecheck, lint and build pass; suite run 3 times with no flakes (before the verifier was tightened).
- Live test (approved, 1 request): 4 model calls, 1 Tavily search, HTTP 200, `evidence` present with 4 findings all `supported`. The model noted a v26.13.0 vs v26.13.1 discrepancy in `risks` that the heuristic did not flag. Verification adds no model or search calls; all limits unchanged. Docs updated (`README.md`, `docs/architecture.md`).

**Not done**
- Heuristics only: keyword overlap on snippets, not full pages or semantic checks. A model that copies snippet wording into a claim can still earn `supported`. Thresholds (0.4 / 0.5) are untuned and unverified against real search results.
- "Unobserved" is merged into `unsourced` because `parseNotes` already drops unobserved URLs.

### Milestone 10: Human approval workflow

**Learning objectives**
- Identify actions that require human review.
- Represent pending, approved, rejected, and expired decisions.
- Prevent execution of gated actions before approval.
- Understand safe handling of approval identity and request association.

**Completion criteria**
- Approval boundaries and state transitions are documented.
- Gated actions cannot proceed without an explicit valid approval.
- Tests cover approval, rejection, expiry, duplicate requests, and invalid transitions.
- No external side effect is enabled without explicit authorization.

**Approved API additions (2026-11-25).** The user explicitly approved: opt-in `REQUIRE_SEARCH_APPROVAL=1` (off by default, responses unchanged when off); `/ask` may answer `202` with a pending approval; new endpoint `POST /approvals/:id` (200/202/400/404/409/410). Approver identity is NOT authenticated (mechanism only; see `docs/architecture.md`).

**Outcome recorded**
- Gated action: `search_web`, behind `REQUIRE_SEARCH_APPROVAL=1` (server setting, off by default). Nothing is spent or sent before a human approves that exact query.
- State machine in `src/request/approvals.ts`: `pending -> approved | rejected | expired`, all terminal; any other transition is `InvalidTransition` (HTTP 409). The application stores the action; the decision body carries only `decision`, so it cannot change the query. Ids are random UUIDs tied to one question.
- Flow: `/ask` returns 202 with the pending approval, `POST /approvals/:id` resumes it (200 report, or 202 for a further approval). Human wait is not charged to the 90 s deadline; it is bounded by `APPROVAL_TTL_MS` (120 s). Expiry or an abandoned client stops the question. Documented in `docs/architecture.md` and `README.md`.
- Budget changes found by live testing (user-approved): analysis `max_tokens` 2048 -> 3072 and `ANALYSIS_RESERVE_MS` 25 s -> 30 s, plus a brevity line in the analysis prompt. A live analysis call had used 1888 of 2048 tokens (mostly hidden reasoning) and one earlier run was truncated (`finishReason=length`).
- Mocked tests: 100/100 (state machine, no search before approval, approve, reject, expiry, duplicate, unknown id, bad body, policy off, logs without query or id, client disconnect, human wait not charged to the deadline). Typecheck, lint and build pass.
- Live tests (approved), 3 runs with the gate on: approve then reject of a second search both worked. Run 1 ended in a 502 (analysis truncated). After the budget changes the analysis call used 1033 of 3072 tokens, took about 20 s, and the question returned 200 with `evidence` (5 model calls, 1 search).

**Not done**
- No approver authentication: the approval id works like a password. Production would need real identity separate from the requester.
- State is in memory only (lost on restart); a pending question keeps its concurrency slot for up to the TTL.
- Expiry and parallel approvals are covered by mocked tests only, not live. The token and reserve changes rest on two live runs and provider speed varies.

---

## Remaining milestones

### Milestone 11: Retries, error handling, and observability

**Learning objectives**
- Classify transient and permanent failures.
- Design bounded retries, backoff, and timeout behavior.
- Add structured, privacy-conscious logs and request correlation.
- Measure model calls, tool calls, latency, and failure rates.

**Completion criteria**
- Retry rules are bounded and do not bypass request budgets.
- Errors are classified and exposed safely to API clients.
- Logs avoid credentials, raw sensitive content, and unnecessary model reasoning.
- Mock tests cover retry limits, timeouts, and failure paths.

### Milestone 12: Production evolution

**Learning objectives**
- Assess production requirements and trade-offs.
- Explore persistence, authentication, authorization, rate limiting, deployment, monitoring, and evaluation.
- Understand when components such as PostgreSQL, queues, tracing, or additional infrastructure are justified.
- Document operational and security risks.

**Completion criteria**
- A production-readiness assessment identifies gaps and priorities.
- Architecture decisions explain why each proposed component is needed.
- Security, privacy, cost, reliability, and deployment considerations are documented.
- No infrastructure or paid service is added without explicit approval.

---

## Resource and safety guardrails

These are the safeguards established during earlier milestones. Verify the current source code before relying on them; do not assume a planned or historical value is still enforced.

- OpenRouter model ID must be a free variant, ending in `:free`.
- Every model request must retain `allow_fallbacks: false`.
- No paid fallback, auto top-up, or payment flow.
- Existing Milestone 6 request budgets included a six-model-call hard cap, a 90-second deadline, and a two-search budget.
- Search results and model-generated notes are untrusted data.
- Tool execution is application-controlled, allow-listed, and argument-validated.
- Never log or publish API keys, authorization headers, `.env` contents, or sensitive user data.
- Use mocks for routine testing; live API tests require explicit approval.

## Session handoff checklist

**At the start of a milestone**
1. Read this roadmap and the root `CLAUDE.md`.
2. Inspect the actual code and current Git state.
3. Confirm the last completed milestone and its tests.
4. Explain the next milestone's concepts and propose a scoped plan.
5. Wait for approval before implementation.

**At the end of a milestone**
1. Run the agreed tests and report exact results.
2. Explain the implementation and important trade-offs.
3. Record actual call, search, token, and latency implications where measurable.
4. Update this roadmap to reflect verified progress.
5. Review the diff and secret exposure before any commit or push.
6. Wait for explicit approval before pushing or opening a pull request.
