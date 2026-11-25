# Production readiness assessment (Milestone 12)

This is an assessment, not an implementation. It states what the app does today, what would go wrong if it were exposed to real users, and which component each gap would justify. **Nothing here has been built, and no infrastructure or paid service is added by this milestone.** Claims about "today" were checked against the code (file references in the last column of the baseline); if code and this document ever differ, trust the code and fix the document.

Rule used throughout: **a component is added only when a named failure makes it necessary.** Each decision record below names that trigger. Until the trigger is true, the answer is "do not add yet".

## 1. Baseline (verified)

| Area | Today | Where |
|---|---|---|
| Process model | one Node process, `tsx` at runtime (`npm start`); `npm run build` emits `dist/` | `package.json`, `src/index.ts` |
| State | per request only (`RequestContext`); **in memory and per process**: pending approvals, the concurrency counter, metrics | `src/request/context.ts`, `src/request/approvals.ts`, `src/http/server.ts`, `src/observability/metrics.ts` |
| Identity | none. No authentication or authorization on `/ask`, `/approvals/:id`, `/metrics` | `src/http/server.ts` |
| Abuse control | global cap of 2 concurrent questions (429 `busy`), 10,000-byte body, per-question budgets (6 model calls, 2 searches, 90 s) | `src/config.ts` |
| Provider cost guard | model ID must end in `:free`, `allow_fallbacks: false`; Tavily key is a free plan | `src/config.ts`, `src/llm/openrouter.ts` |
| Edge | no TLS, CORS, security headers, `trust proxy`; `x-powered-by` is disabled | `src/http/server.ts` |
| Lifecycle | no `/health` or readiness route, no `SIGTERM`/`SIGINT` handler, so a stop drops in-flight questions and pending approvals | `src/index.ts` |
| Logs | structured stdout lines with an opaque `requestId`; no keys, no reasoning, no user content (except the local-only `TRACE_AGENTS`) | `src/observability/log.ts` |
| Metrics | JSON counters at `GET /metrics`, unauthenticated, reset on restart | `src/observability/metrics.ts` |
| Failure handling | fixed error codes, one bounded search retry, no model retries | `src/errors.ts`, `src/tools/index.ts` |
| Tests | 126 mocked tests, no network. No CI configuration in the repo | `test/`, no `.github/` |
| Secrets | `.env` is git-ignored; `.env.example` holds placeholders | `.gitignore`, `.env.example` |

## 2. Gap assessment

Priority: **P0** blocks any exposure beyond your own machine. **P1** needed before real users or a second instance. **P2** useful, justified later.

| # | Area | Gap and the failure it causes | Priority |
|---|---|---|---|
| G1 | Authentication / authorization | Anyone who can reach the port can spend free quota and read `/metrics`. `POST /approvals/:id` accepts anyone who knows the UUID, so the requester can approve their own search (the human gate is only as strong as the secrecy of an id that is returned to the requester). | **P0** |
| G2 | Rate limiting | Only a global 2-concurrent cap. One caller can hold both slots and starve everyone else (a cheap denial of service) and burn the daily free quota. No per-client or per-day limit. | **P0** (with G1) |
| G3 | Edge and transport | No TLS, no `trust proxy` (client IPs are wrong behind a proxy, so IP-based limits would misfire), no CORS policy, no security headers. | P0 if internet-facing, otherwise delegated to a reverse proxy |
| G4 | Lifecycle | No graceful shutdown: a deploy kills running questions mid-call (wasted free quota) and expires pending approvals silently. No health or readiness endpoint, so an orchestrator cannot tell "up" from "ready". | P1 |
| G5 | Scaling and state | Concurrency cap, approvals and metrics are per process. With 2 instances the real cap doubles; an approval decision sent to the other instance returns 404; metrics are split. | P1 (only when a second instance is wanted) |
| G6 | Persistence | A restart loses pending approvals and all history. There is no audit record of who approved what. | P1 if audit or durability is required, else P2 |
| G7 | Observability | Logs go to stdout only; `/metrics` is not in a scrape format and has no auth; no alerts; no tracing; `parse_failed` and plain `console.error` lines lack a request id. | P1 |
| G8 | Reliability | A slow free provider can exhaust the 90 s deadline (seen live in Milestone 11: calls took 12-17 s, three research calls left too little for analysis). No circuit breaker or provider health signal; model calls are not retried by design. | P1 |
| G9 | Evaluation | Only mocked tests. Nothing measures answer quality, the verifier heuristics (`src/agents/verify.ts`) on real data, or regression across model changes. A successful live end-to-end answer was never recorded in Milestone 11. | P1 |
| G10 | Cost and quota | Spend is bounded by code caps, but free-tier limits are external and can change; there is no alarm when quota runs low, and no daily budget across requests. | P1 |
| G11 | Privacy | Questions are sent to OpenRouter and Tavily (third parties) and may include personal data. Retention, provider data policy, user notice and a logging policy are not written down. | P1 |
| G12 | Supply chain and CI | No CI, no `npm audit` in a pipeline, dependencies use caret ranges (lockfile present). No automated typecheck, lint, test and build on pull requests. | P2 |
| G13 | Configuration | Config errors fail at startup (good), but there is no schema for all env vars, no per-environment profiles, and secrets come from a local `.env`. | P2 |
| G14 | Runtime hardening | Node default HTTP timeouts are unchanged; no explicit `headersTimeout`/`requestTimeout`/max connections, so slow-client attacks are possible. `tsx` at runtime adds startup cost and is a dev tool. | P2 |

## 3. Decision records

Each record: **Need** (the failure), **Option**, **Trigger** (when to adopt), **Cost/risk**, **Decision now**.

### D1. Authentication and authorization (G1)
- **Need:** stop strangers from spending quota, reading metrics, and approving searches. Also separate **who asks** from **who approves**.
- **Option A, shared API key (header, constant-time compare, hashed in config):** one small middleware, no dependency, no database. **Option B, OIDC/JWT from an identity provider:** per-user identity and roles, needed for real approver identity. **Option C, rely on a gateway:** the proxy authenticates, the app trusts a header (risky if the app is reachable directly).
- **Trigger:** the first time the port is reachable by anyone you do not control. A is enough for a single team; B when approvals must be attributable to a person or the approver must differ from the requester.
- **Cost/risk:** A is trivial but has one shared secret and no revocation per user; B adds a dependency and an external service.
- **Decision now:** do not add; document as the first P0 slice. Approver identity is part of the same slice: bind each approval to the authenticated requester and require a different role to decide.

### D2. Rate limiting (G2)
- **Need:** fairness and quota protection per client, not just globally.
- **Option:** per-key token bucket plus a daily question budget, in memory first (no dependency); a shared store (Redis) only with more than one instance.
- **Trigger:** more than one client, or any exposure beyond localhost. Authentication (D1) comes first, since a limit needs an identity to count against.
- **Cost/risk:** in-memory limits reset on restart and are per instance. Redis adds a service and a failure mode.
- **Decision now:** do not add; build with D1.

### D3. PostgreSQL / persistence (G6)
- **Need:** durable approval records, an audit trail, history of questions or reports.
- **Option:** PostgreSQL (or SQLite for a single instance). The domain is small: approvals (id, state, timestamps, decider) and an audit log.
- **Trigger:** a requirement that survives a restart (audit, pending approvals across deploys, user history), or a second instance that must share approvals.
- **Cost/risk:** a stateful service to run, back up and secure; storing questions makes the privacy duties in G11 real (retention, deletion, encryption). Storing **only ids, states and timestamps** keeps user content out.
- **Decision now:** do not add. Today's in-memory choice is deliberate: it keeps state per request, has no user content at rest, and its failure (lost approvals on restart) is harmless for a single learning instance.

### D4. Queue and background jobs (G5)
- **Need:** only if a question must outlive its HTTP connection (long answers, retries after a crash, fan-out).
- **Option:** a job queue plus a status endpoint (`202` then poll), or keep the synchronous request.
- **Trigger:** typical answers regularly exceeding what a client will wait, or a need to survive deploys without losing work.
- **Cost/risk:** large: a broker, idempotency, result storage, and a new API contract. The 90 s deadline and 2-concurrent cap already bound work.
- **Decision now:** do not add.

### D5. Tracing and metrics export (G7)
- **Need:** answer "why was this question slow" across model and search calls, and alert on failure rate and latency.
- **Option:** keep `request_id` + structured logs (done); expose Prometheus text format behind auth; add OpenTelemetry spans only when there is more than one service or hop.
- **Trigger:** a second service, or a recurring problem logs cannot explain.
- **Cost/risk:** an exporter dependency and a backend to host; span attributes must follow the same "no user content" rule as logs.
- **Decision now:** do not add. Cheap P1 fixes first: put `/metrics` behind auth, add a request id to the remaining log lines, define three alerts (5xx rate, p95 latency, `busy` rate).

### D6. Deployment (G4, G13, G14)
- **Need:** reproducible runs, safe restarts, health checks.
- **Option:** a container image from `npm run build` output run with `node` (not `tsx`), a non-root user, read-only filesystem, env-provided secrets from the platform's secret store, health (`/healthz`) and readiness endpoints, `SIGTERM` drain (stop accepting, finish in-flight questions up to the deadline, expire pending approvals), and explicit HTTP timeouts. A reverse proxy or platform terminates TLS.
- **Trigger:** the first deployment off your machine.
- **Cost/risk:** hosting cost (free tiers exist but need approval, as the roadmap forbids paid services without it).
- **Decision now:** do not add; list as the P1 slice after D1/D2.

### D7. Evaluation (G9)
- **Need:** know whether answers are good and whether a prompt, model or verifier change makes them worse.
- **Option:** a small golden set (questions, expected facts, allowed sources) scored by deterministic checks first (schema validity, evidence statuses, banned phrases), run **mocked in CI** and **live by hand** with explicit approval and a stated call count; human spot checks before any LLM-as-judge (a judge is another model call and another source of error).
- **Trigger:** before trusting output for decisions, or before swapping the model.
- **Cost/risk:** live evaluation spends free quota; a flaky provider makes live results noisy (see M11).
- **Decision now:** do not add.

### D8. CI and supply chain (G12)
- **Option:** one CI job on pull requests: install from the lockfile, typecheck, lint, test, build, plus `npm audit` reporting. Pin or review major upgrades (TypeScript is pinned to `~6.0` for a stated reason).
- **Trigger:** a second contributor, or before the first deployment.
- **Decision now:** do not add.

## 4. Prioritized path

Each line would be its own milestone-sized slice with its own plan and approval.

| Order | Slice | Closes | New infrastructure? |
|---|---|---|---|
| Now (P0) | API-key auth on all routes, separate approver credential, per-key rate limit and daily budget, `/metrics` behind auth | G1, G2 | none |
| Next (P1) | Health/readiness, graceful shutdown, explicit HTTP timeouts, request id on every log line, alert definitions, privacy and retention note | G4, G7, G11, G14 | none |
| Next (P1) | Evaluation harness (mocked in CI, live by hand), a recorded successful live run, quota monitoring | G8, G9, G10 | none |
| Later (P1/P2) | Container image and CI pipeline | G12, G13 | hosting and CI (needs approval) |
| Later (trigger-based) | PostgreSQL, shared rate-limit store, queue, OpenTelemetry | G5, G6 | yes, each only when its trigger is met |

## 5. Threat sketch

| Threat | Today | Mitigation |
|---|---|---|
| Anonymous abuse of `/ask` | possible; capped by 2 concurrent and quotas, not by identity | D1, D2 |
| Requester approves own search | possible: the id is returned to the requester and decisions are unauthenticated | D1 (separate approver identity) |
| Prompt injection via search results | results are treated as untrusted data; tools are allow-listed and validated; sources must be observed URLs | keep; add injection cases to D7 |
| Key or credential leakage | keys are never logged or returned; `.env` ignored | keep; secret store in D6 |
| Log leakage of user content | logs hold structure only; `TRACE_AGENTS` is switched off when `NODE_ENV=production` | keep; a retention rule for any log sink |
| Metrics disclosure | `/metrics` is open (numbers only) | D5 |
| Slow-client or large-body attacks | body limit 10 kB; default Node timeouts | D6 timeouts, proxy limits |
| SSRF | not applicable: the app fetches only fixed provider hosts, never user-supplied URLs | keep it that way |
| Supply chain | lockfile, caret ranges, no audit job | D8 |

## 6. Checklists before first exposure

- **Security:** auth on every route, approver separate from requester, `/metrics` protected, TLS at the edge, security headers, no secret in the image or repo, `NODE_ENV=production` set (this also switches `TRACE_AGENTS` off).
- **Privacy:** state what is sent to OpenRouter and Tavily, what is logged and for how long, who can read logs, and how a user deletes data. Keep question text out of logs and metrics.
- **Cost:** keep `:free` and `allow_fallbacks: false`; a per-key daily budget; an alert when quota is nearly used; no automatic top-up.
- **Reliability:** graceful shutdown, readiness check, explicit timeouts, alerts on 5xx rate and p95 latency, a known provider-slowness mode (502 `model_unavailable`) with a runbook line.
- **Deployment:** build with `npm run build` and run `node`; one instance until D3/D5 triggers are met (the in-memory approvals and concurrency cap require it).

## 7. Known limits carried over

- Search retry is verified by mocks only; no successful live answer has been recorded since Milestone 11.
- Approvals, concurrency and metrics are per process and lost on restart.
- `bad_request` covers 400/404/405/409/413; fixed backoff without jitter.
- Heuristic evidence verification has not been measured on real data.
