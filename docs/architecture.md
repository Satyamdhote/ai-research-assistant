# Architecture

## The flow

1. **HTTP layer** (`src/http/server.ts`) validates the request, limits concurrency and calls `answerQuestion()`.
2. **Supervisor** (1 model call, no tools) returns a small JSON routing decision:
   `analysis_only` or `research_then_analysis` (with a `research_task`). If its output is unusable the
   orchestrator falls back to `analysis_only` and logs `routeFallback=true`. Provider errors still stop the request.
3. **Research specialist** (only for the research route; tools `search_web` and `get_current_date`;
   at most 2 tool rounds = at most 3 model calls) returns notes: `{ findings: [{claim, source_url|null}], gaps: [] }`.
4. **Analysis specialist** (1 model call, no tools) writes the final strict report.

Specialists never talk to each other. Each starts with its own message list (its own context window);
the orchestrator in `src/agents/orchestrator.ts` decides what crosses between them.

## What runs in parallel (Milestone 7)

| Work | Depends on | Parallel? |
|---|---|---|
| Supervisor | the question | no: every later step needs its route |
| Research | the route | no |
| Analysis | the research notes | no: it must wait for research (and still runs if research failed) |
| Tool calls from ONE model reply (up to 3) | the same reply, nothing else | **yes** (`Promise.all` in `runAgent.ts`) |

The agents form a dependency chain, so the only independent work is the tools of one reply.
Rules that keep this safe:

- `runTool` never throws, so one failed tool cannot lose the others' results.
- The search budget is checked and spent in one synchronous stretch (no `await` between), so parallel
  searches cannot both take the last one. Keep it that way.
- Results are recorded after all tools finish, in the order the model asked, so history, logs and
  `search_outcomes` are the same on every run.
- One abort signal reaches every in-flight search.

Measured with mocked 200 ms searches (`test/parallel.test.ts`): 2 searches in one round took about
420 ms sequentially and about 215 ms in parallel. Model calls, searches and the response are unchanged.

## Ground truth comes from the application

The analysis agent is told two separate facts, both recorded by our code:

- `search_outcomes`: what each real search returned (`SEARCH_OK`, `SEARCH_OK_NO_RESULTS`, `SEARCH_UNAVAILABLE`, or `NOT_USED`).
- `research_stage`: `not_needed`, `completed`, or `failed:<reason>` (the research *model step*, not the web).

Source URLs in the notes are kept only if a real search returned them (compared without a trailing slash).
That proves a URL was returned, not that a claim is supported by that page.

**Evidence verification (Milestone 9).** After research, `src/agents/verify.ts` (plain code, no model call) compares each finding with the search snippet stored for its URL (`ctx.observedSnippets`, capped at `MAX_STORED_SNIPPET_CHARS` per URL). Statuses: `supported` (snippet shares >= 40% of the claim's key terms, contains every number in the claim, and the claim and the best-matching snippet sentence agree on negation), `weak` (observed URL, but the key terms, a number or the negation do not match), `conflicting` (two findings on the same subject where one negates, or both give different numbers for the same thing, i.e. after the same key word; facts that merely contain different numbers are not a conflict), `unsourced` (no observed URL), `unverified` (the check itself failed; the request still succeeds). These are keyword heuristics over snippets, not full-page reading. A research model that copies a snippet's wording into its claim can still earn `supported`, so the status means "the claim resembles the snippet", not "the claim is true". Statuses go to the analysis stage in the input block and are returned as the additive `evidence` field of `/ask`.

## Request state (Milestone 8)

All state of one question lives in one `RequestContext` (`src/request/context.ts`). It is created by
`answerQuestion()`, passed down explicitly and dropped when the request ends. Nothing is stored in a
module-level variable, so one request cannot see another's state (`test/state.test.ts` runs two overlapping
requests to check this). Nothing is persisted.

| Field | Meaning | Written by (only through) |
|---|---|---|
| `modelCalls` | model calls started | `callModel` via `countModelCall()` |
| search budget (private) | searches left (2) | `search_web` via `spendSearch()` |
| `searchOutcomes` | what each real search returned, in order | `runAgent` via `recordSearch()` |
| `observedUrls` | normalized URLs real results contained, capped at 50 | `runAgent` via `recordSearch()` |
| `reserveActive` (private switch) | analysis time is held back | `withAnalysisReserved()` |
| `startedAt`, `signal`, `remainingMs()` | fixed at creation | nobody |

Rules:

- The context module is the only writer. Other modules get read-only views (`readonly` arrays, `ReadonlySet`)
  and change state through the three methods, which hold the rules (limits, de-duplication, the URL cap).
- Each module takes only what it needs: `callModel` a `ModelContext`, tools a `ToolContext`.
- `spendSearch()` checks and spends in one synchronous step, so parallel tools cannot both take the last search.
- `recordSearch()` expects URLs already normalized (`normalizeUrl` lives in `tools`, and `request` must not import it).
- Agents do not share message lists. What crosses between specialists is chosen by the orchestrator: validated
  notes plus the application-written status block, never another agent's history.

## Human approval (Milestone 10)

Off by default. With `REQUIRE_SEARCH_APPROVAL=1` (a server setting; a client cannot turn it off) every `search_web` call is a **gated action**: it waits for a human before anything is spent or sent.

State machine (`src/request/approvals.ts`, in memory, one store per app instance):

```
pending --approve--> approved   (terminal)
pending --reject---> rejected   (terminal)
pending --timeout--> expired    (terminal; also when the client abandons the question)
```

Any other transition is an `InvalidTransition` (HTTP 409).

Flow: `POST /ask` runs the supervisor and research model calls as usual. When research asks for a search, the question pauses and `/ask` answers `202 {approval_id, status:"pending", action:{tool,query}, expires_in_s}`. `POST /approvals/:id` with `{"decision":"approve"|"reject"}` resumes it and returns the report (200), or the next pending approval (202) if a second search is requested. Rejected means the model is told "not approved" and no search runs; the report then says `search_outcomes: NOT_USED`. Expired or abandoned means the whole question is stopped; a client that is waiting at that moment gets `410` (and a client that has left gets nothing).

Several searches in one round (the model may ask for up to 3) each get their own approval. They are queued per question and shown one at a time, in order, so none is lost. The search budget is taken **before** a human is asked (a search that could not run anyway is never put to a human), and it is given back if the human rejects, so a rejected search does not use up the question's budget.

Rules:
- The application stores the action; the decision body is strict and carries only `decision`, so it can never change the query. Approval covers that one search only.
- `approval_id` is a random UUID tied to one question. Knowing it is what allows deciding (a bearer capability): **there is no approver authentication**, so production would need real identity separate from the requester.
- The wait is not charged to the 90 s question deadline (`requestApproval` in `src/request/context.ts` shifts it), but is bounded by `APPROVAL_TTL_MS` (120 s). While waiting, no model calls run. The question keeps its concurrency slot, so at most `MAX_CONCURRENT_REQUESTS` approvals can be pending.
- Logs record the approval state (`pending`, `approved`, `rejected`, `expired`) only; never the query or the id.
- State is lost on restart; finished approvals are remembered for one TTL so a duplicate decision gets 409, not 404.

## Errors, retries and observability (Milestone 11)

**Error codes.** Every failure that can end a question carries one fixed `ErrorCode` (`src/types.ts`, mapped in `src/errors.ts`). `toClientError` is the only place an error becomes an HTTP answer: statuses and messages are the ones the API always used (a 502 stays a 502, the message stays generic), and the body adds `code` and `request_id`. Provider text, model output, stacks and keys never reach the body.

| Code | From | Status |
|---|---|---|
| `bad_request` | invalid input, wrong path or method, unknown or finished approval | 400 / 404 / 405 / 409 / 413 |
| `busy` | 2 questions already in progress | 429 |
| `auth_failed`, `payment_required`, `rate_limited`, `provider_error` | OpenRouter 401 / 402 / 429 / other | 502 |
| `model_unavailable` | network error, timeout, unreadable or empty model reply | 502 |
| `truncated`, `invalid_output` | cut off by `max_tokens`; reply or tool use failed our validation | 502 |
| `timeout`, `limit_reached` | question deadline; model-call cap | 502 |
| `approval_expired` | a human did not answer in time | 410 |
| `cancelled` | the client left (nothing is sent; counted and logged only) | none |
| `internal` | anything unexpected | 502 |

**Retries: search only, at most once, and never beyond the budgets.** A search failure is *transient* when it could succeed if repeated (timeout, network error, 5xx) and *permanent* otherwise (401, 429, 432/433, unreadable reply). Only a transient one is retried, once, when all of these hold: a search is still left in the per-question budget (the retry **spends** it, so Tavily requests stay at most 2 per question), the backoff (500 ms, fixed, abort-aware) plus a usable call still fit before the deadline, and the client is still there. The retry reuses the already-approved query, so a human is asked once, not per attempt. Only the final outcome is recorded. **Model calls are never retried**: each retry would spend the 6-call cap and free quota, and a failed model stage already degrades or fails safely.

**Correlation.** Each HTTP request gets an opaque `request_id` (random UUID, no user data). It is the `X-Request-Id` header, the `request_id` of error bodies, and `requestId=` on every structured log line of that question (an approval decision call reuses the question's id). Not every line carries it: the debug-only `parse_failed` line and the plain `console.error` lines do not. `request_failed` logs the error `code`.

**Metrics.** `src/observability/metrics.ts` keeps per-process counters (requests by outcome, model and tool calls, searches by outcome, search retries, latency buckets), created once per app. Inputs are counts and fixed words only. `GET /metrics` returns them as JSON. They reset on restart, and the endpoint has no authentication.

## Limits (all in `src/config.ts`)

| Limit | Value |
|---|---|
| Model calls per question | typical 2 (concept) or 4 (one search); design max 5; hard cap 6 |
| Searches per question | 2 |
| Observed URLs per question | 50 (backstop; 2 searches give at most 10) |
| Tool calls per round | 3 (more fails before anything runs) |
| Whole-question deadline | 90 s, checked before every network call; per-call timeouts are bounded by the time left |
| Analysis reserve | 30 s is held back while researching, so slow research cannot starve the analysis |
| Single model call / search | 30 s / 10 s (or less if less time is left) |
| Search retries | at most 1 per search, taken from the 2-search budget; 500 ms backoff |
| Concurrent questions | 2 (HTTP 429 beyond that) |
| Request body | 10,000 bytes |

## What fails how

| Situation | Result |
|---|---|
| Supervisor output unusable | falls back to `analysis_only` |
| Research output unusable, network error, time budget used up, non-JSON reply | research marked `failed:<reason>`; analysis still runs and says so |
| Search timeout, network error or 5xx | retried once if budget and time allow, else `SEARCH_UNAVAILABLE` |
| Provider error (401, 402, 429, ...) at any stage | 502 with its own `code`, nothing hidden or retried |
| Whole-question deadline reached, or client disconnected | work stops; 502 / nothing sent |
| Analysis output invalid | 502 |

## Production gaps

What this architecture does not yet cover (authentication, per-client limits, persistence, shutdown, evaluation) and when each component would be justified: [production-readiness.md](production-readiness.md).

## Dependency direction

`http` -> `agents` -> `llm` / `tools` -> `request` / `observability` -> `config` / `types`. Nothing imports `http`.
No module does anything when imported; `src/index.ts` is the only entry point.
