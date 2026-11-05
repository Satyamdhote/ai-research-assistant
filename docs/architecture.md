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

## Ground truth comes from the application

The analysis agent is told two separate facts, both recorded by our code:

- `search_outcomes`: what each real search returned (`SEARCH_OK`, `SEARCH_OK_NO_RESULTS`, `SEARCH_UNAVAILABLE`, or `NOT_USED`).
- `research_stage`: `not_needed`, `completed`, or `failed:<reason>` (the research *model step*, not the web).

Source URLs in the notes are kept only if a real search returned them (compared without a trailing slash).
That proves a URL was returned, not that a claim is supported by that page.

## Limits (all in `src/config.ts`)

| Limit | Value |
|---|---|
| Model calls per question | typical 2 (concept) or 4 (one search); design max 5; hard cap 6 |
| Searches per question | 2 |
| Tool calls per round | 3 (more fails before anything runs) |
| Whole-question deadline | 90 s, checked before every network call; per-call timeouts are bounded by the time left |
| Analysis reserve | 25 s is held back while researching, so slow research cannot starve the analysis |
| Single model call / search | 30 s / 10 s (or less if less time is left) |
| Concurrent questions | 2 (HTTP 429 beyond that) |
| Request body | 10,000 bytes |

## What fails how

| Situation | Result |
|---|---|
| Supervisor output unusable | falls back to `analysis_only` |
| Research output unusable, network error, time budget used up, non-JSON reply | research marked `failed:<reason>`; analysis still runs and says so |
| Provider error (401, 402, 429, ...) at any stage | 502, nothing hidden or retried |
| Whole-question deadline reached, or client disconnected | work stops; 502 / nothing sent |
| Analysis output invalid | 502 |

## Dependency direction

`http` -> `agents` -> `llm` / `tools` -> `request` / `observability` -> `config` / `types`. Nothing imports `http`.
No module does anything when imported; `src/index.ts` is the only entry point.
