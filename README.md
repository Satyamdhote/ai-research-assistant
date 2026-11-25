# AI Research Assistant

A small Node + TypeScript API that answers research questions with a **supervisor agent** and two
specialist agents (research and analysis). It is a step-by-step learning project about Claude and
agentic systems, built on Express 5.

- Models: [OpenRouter](https://openrouter.ai) **free models only** (`:free` model IDs; the app refuses to start otherwise).
- Web search: [Tavily](https://tavily.com) free plan (optional; the app works without it).
- No paid fallbacks, no payment methods, no automatic upgrades.

## Quick start

```bash
npm install
cp .env.example .env      # then fill in your own keys; never commit .env
npm run dev               # restarts on code changes (restart manually after editing .env)
```

Ask a question:

```bash
curl -s -X POST localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"What is an AI agent?"}'
```

The response is a report with these fields: `title`, `summary`, `key_findings`, `risks`, `conclusion`. When web research ran, it also has an optional `evidence` array: one `{claim, source_url, status}` per research finding, where `status` is computed by the application (`supported`, `weak`, `conflicting`, `unsourced`, `unverified`), never by a model. `supported` means the cited source's search snippet shares the claim's key terms, contains every number the claim states, and does not contradict its negation. It is not proof the claim is true.

**Optional human approval.** With `REQUIRE_SEARCH_APPROVAL=1` on the server, a web search waits for a human: `/ask` returns `202` with an `approval_id` and the proposed query, and `POST /approvals/:id` with `{"decision":"approve"}` or `{"decision":"reject"}` continues the question (details in `docs/architecture.md`). Unset by default; responses are unchanged then.

| Status | Meaning |
|---|---|
| 200 | the report |
| 202 | only with `REQUIRE_SEARCH_APPROVAL=1`: a search is waiting for a human (`approval_id`, the proposed `action`, `expires_in_s`) |
| 400 | body is not valid JSON, `question` missing/blank, or (on `/approvals/:id`) `decision` is not `approve` or `reject` |
| 404 / 405 | wrong path or unknown approval id / not POST |
| 409 | `/approvals/:id` only: that approval already has a final status, or its question is no longer running |
| 410 | `/approvals/:id` only: an approval expired, so the question was stopped |
| 413 | request body is over 10,000 bytes |
| 429 | too many questions are already being answered (limit 2 at a time) |
| 502 | the model could not answer (a generic message; details are logged server-side, never returned) |

Every error body is `{ "error", "code", "request_id" }`. `code` is one fixed word saying why (`bad_request`, `busy`, `auth_failed`, `payment_required`, `rate_limited`, `provider_error`, `model_unavailable`, `truncated`, `invalid_output`, `timeout`, `limit_reached`, `approval_expired`, `internal`); `request_id` is an opaque id, also sent in the `X-Request-Id` header on every response and on every log line of that question. Success bodies are unchanged. `GET /metrics` returns in-memory counters (numbers only: requests by outcome, model/tool calls, searches, search retries, latency buckets); it is unauthenticated, so do not expose it publicly.

## Configuration (`.env`)

See `.env.example` (names only). `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` (must end in `:free`) are
required; `TAVILY_API_KEY`, `PORT`, `DEBUG_LLM` and `TRACE_AGENTS` are optional.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | server with auto-restart (`tsx watch`) |
| `npm start` | server once |
| `npm test` | all automated tests (mocked OpenRouter and Tavily: no network, no quota) |
| `npm run typecheck` | TypeScript check |
| `npm run probe:llm` | one real OpenRouter call to check your key and model (uses 1 free request) |

## How it works (short)

```
question -> Supervisor -> analysis_only ------------------------> Analysis -> report
                      \-> research_then_analysis -> Research -/
```

Each agent is the same free model with its own role prompt, its own tools and its own context window.
Our code (not the models) runs them in a fixed order and passes only validated data between them.
See [docs/architecture.md](docs/architecture.md) for the details and the safety limits, and [docs/production-readiness.md](docs/production-readiness.md) for what is missing before real exposure (no authentication yet).

## Project layout

```
src/index.ts            entry point (load .env, check config, listen)
src/config.ts           every environment variable and every limit
src/types.ts            shared types
src/http/               server.ts (Express routes, size-limited JSON body, status codes)
src/agents/             orchestrator.ts (the flow), runAgent.ts (bounded tool loop),
                        schemas.ts (route, notes, report), prompts.ts (one prompt per role)
src/llm/                openrouter.ts (the only OpenRouter caller), parseJson.ts
src/tools/              index.ts (definitions + runTool), search.ts (Tavily), searchResult.ts (markers)
src/request/context.ts  per-question state: id, deadline, call counters, search budget
src/errors.ts           error codes and the one mapping from an error to an HTTP answer
src/observability/      log.ts (text-free stage logs, optional local trace), metrics.ts (in-memory counters)
test/                   node:test tests and a fake OpenRouter/Tavily (test/helpers/mock.ts)
scripts/probe-llm.ts    manual live check
```

## Safety rules

- Keys live only in `.env` (git-ignored). Logs never contain keys, model reasoning or user content.
- `TRACE_AGENTS=1` is the one exception: a local learning aid that prints agent contexts. Never share its output; it is refused when `NODE_ENV=production`.
- Search results and research notes are treated as untrusted data (prompt-injection risk), never as instructions.
