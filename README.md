# AI Research Assistant

A small Node + TypeScript API that answers research questions with a **supervisor agent** and two
specialist agents (research and analysis). It is a step-by-step learning project about Claude and
agentic systems, built on Node's built-in `node:http` (no web framework).

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

The response is always a report with exactly these fields: `title`, `summary`, `key_findings`, `risks`, `conclusion`.

| Status | Meaning |
|---|---|
| 200 | the report |
| 400 | body is not valid JSON, `question` missing/blank, or the body is over 10,000 bytes |
| 404 / 405 | wrong path / not POST |
| 429 | too many questions are already being answered (limit 2 at a time) |
| 502 | the model could not answer (a generic message; details are logged server-side, never returned) |

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
See [docs/architecture.md](docs/architecture.md) for the details and the safety limits.

## Project layout

```
src/index.ts            entry point (load .env, check config, listen)
src/config.ts           every environment variable and every limit
src/types.ts            shared types
src/http/               server.ts (routes, status codes), readBody.ts (size-limited body)
src/agents/             orchestrator.ts (the flow), runAgent.ts (bounded tool loop),
                        schemas.ts (route, notes, report), prompts.ts (one prompt per role)
src/llm/                openrouter.ts (the only OpenRouter caller), parseJson.ts
src/tools/              index.ts (definitions + runTool), search.ts (Tavily), searchResult.ts (markers)
src/request/context.ts  per-question state: deadline, call counter, search budget
src/observability/      log.ts (text-free stage logs, optional local trace)
test/                   node:test tests and a fake OpenRouter/Tavily (test/helpers/mock.ts)
scripts/probe-llm.ts    manual live check
```

## Safety rules

- Keys live only in `.env` (git-ignored). Logs never contain keys, model reasoning or user content.
- `TRACE_AGENTS=1` is the one exception: a local learning aid that prints agent contexts. Never share its output; it is refused when `NODE_ENV=production`.
- Search results and research notes are treated as untrusted data (prompt-injection risk), never as instructions.
