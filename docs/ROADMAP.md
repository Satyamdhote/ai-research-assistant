





AI Research Assistant --- Learning Roadmap
Project goal
Build a practical, API-only multi-agent AI research assistant while
learning the engineering concepts behind it. The project is developed
incrementally with Node.js, TypeScript, Express, OpenRouter, Zod, and
native tools where practical.

Working principles
Learn one milestone at a time; understand the design before
implementation.
Inspect the current code before proposing changes.
Plan substantial work first and wait for explicit approval before
implementation.
Prefer simple, understandable implementations over unnecessary
frameworks or dependencies.
Keep explanations, prompts, and implementation scope concise.
Preserve the API-only architecture; do not add a frontend unless
explicitly requested.
Use free OpenRouter model variants only. Keep
allow_fallbacks: false.
Never add paid fallbacks, automatic top-ups, or payment flows.
Preserve and enforce model-call, search, token, and time budgets.
Any proposed change must be explicit and justified.
Never expose or commit API keys, .env files, credentials, or
sensitive data.
Test with mocks before live API calls. Obtain explicit approval
before any live API test.
Use feature branches and pull requests. Never force-push or push
directly to main.
After each milestone, report changed files, concepts learned, tests,
resource costs, limitations, and remaining work.
Update this roadmap only after checking what is actually implemented
and tested. Do not mark work complete based only on a plan.
Technology and project constraints
Runtime: Node.js with TypeScript
API: Express; API-only, tested with tools such as curl or Postman
LLM provider: OpenRouter
Validation: Zod
HTTP: Node's built-in fetch where suitable
No orchestration framework unless a later, explicit learning
objective justifies one
Keep free-model safeguards active on every model request
Milestone tracker
# Milestone Status

1 LLM API integration and Complete
basic
question-answering
agent

2 System prompts and Complete
research-agent behavior

3 Structured outputs and Complete
Zod validation

4 Tool-calling Complete
fundamentals

5 Web search integration Complete

6 Supervisor and Complete
specialist agents

7 Parallel agent Next
execution

8 Shared context and Planned
state management

9 Evidence verification Planned

10 Human approval workflow Planned

11 Retries, error Planned
handling, and
observability

12 Production evolution Planned
Completed milestones
Milestone 1 --- LLM API integration and basic agent
Learning objectives - Call an LLM API from Node.js. - Understand
chat messages, request parameters, and model responses. - Load
configuration from environment variables.

Outcome recorded - Basic API-backed question-answering flow. -
OpenRouter integration using a free model variant. - API key loaded from
.env, which must remain untracked.

Milestone 2 --- System prompts and research-agent behavior
Learning objectives - Separate system instructions from user
input. - Shape response behavior and communicate uncertainty. - Avoid
claiming research or tool use that did not happen.

Outcome recorded - Dedicated prompt module. - Instructions for
clear, balanced, structured, appropriately concise answers.

Milestone 3 --- Structured outputs and Zod
Learning objectives - Request machine-readable model output. - Parse
and validate model responses. - Distinguish syntactically valid JSON
from data that satisfies an application contract.

Outcome recorded - Strict ResearchSchema and inferred TypeScript
type. - Parsing and validation of model output. - Existing report
contract returns a structured five-field report.

Milestone 4 --- Tool-calling fundamentals
Learning objectives - Understand the difference between a model
requesting a tool and application code executing it. - Validate tool
arguments and enforce an application-owned allow-list. - Bound tool
loops and correctly pair tool-call IDs with tool results.

Outcome recorded - get_current_date tool. - Bounded tool loop and
validated tool arguments. - Application-controlled execution rather than
model-controlled code execution.

Milestone 5 --- Web search integration
Learning objectives - Connect an external search service as an
application tool. - Handle empty results, provider failures, timeouts,
and invalid requests. - Treat retrieved web content as untrusted input.

Outcome recorded - Tavily-backed search_web tool. -
Two-search-per-request budget. - Distinct outcomes: SEARCH_OK,
SEARCH_OK_NO_RESULTS, and SEARCH_UNAVAILABLE. - Search availability
is not assumed when a search fails or returns no results.

Milestone 6 --- Supervisor and specialist agents
Learning objectives - Separate routing, research, and analysis
responsibilities. - Understand an orchestrator-controlled, hub-and-spoke
agent pattern. - Validate inter-agent inputs and outputs. - Enforce
request-level budgets and preserve provenance.

Outcome recorded - Supervisor chooses analysis_only or
research_then_analysis. - Research specialist can use the existing
date and web-search tools. - Analysis specialist produces the final
structured report. - Live tests confirmed two model calls for the
analysis-only route and four for the research route. - App-observed
search outcomes and returned source URLs are used to constrain
attribution. - Tolerant parsing may handle formatting irregularities,
but strict Zod validation remains authoritative.

Remaining milestones
Milestone 7 --- Parallel agent execution
Status: Next --- planning required.

Learning objectives - Understand concurrency versus parallelism in
Node.js. - Use Promise.all() for independent work. - Identify task
dependencies and avoid parallelizing work that depends on unfinished
research. - Handle partial failures and cancellation safely. - Measure
latency changes and resource usage.

Design constraints - Inspect the current Milestone 6 implementation
first. - Parallelize only genuinely independent specialist tasks. -
Research-dependent analysis must wait for research results. - Preserve
shared request budgets and avoid race conditions. - Keep the API
response contract and validation unchanged.

Completion criteria - A documented design identifies safe parallel
work and dependencies. - Mock tests verify concurrency, ordering,
partial failures, and budget enforcement. - Latency is compared against
the sequential baseline. - No live API tests occur without explicit
approval.

Milestone 8 --- Shared context and state management
Learning objectives - Understand request-scoped context and state. -
Pass relevant information between agents without sharing entire
conversation histories unnecessarily. - Define ownership and mutation
rules for shared state. - Prevent cross-request data leakage.

Completion criteria - A clear context/state schema and lifecycle are
documented. - State is scoped to the request unless persistent storage
is explicitly approved. - Validation, size limits, and tests cover state
updates and isolation.

Milestone 9 --- Evidence verification
Learning objectives - Distinguish claims, evidence, and inference. -
Verify that cited sources were actually retrieved. - Detect unsupported
claims and conflicting evidence. - Communicate uncertainty and research
gaps.

Completion criteria - Verification logic has explicit rules and
validated inputs/outputs. - Claims cannot be marked verified solely
because an agent says so. - Mock tests cover missing, irrelevant,
conflicting, and unobserved sources. - The report clearly distinguishes
supported findings from uncertainty.

Milestone 10 --- Human approval workflow
Learning objectives - Identify actions that require human review. -
Represent pending, approved, rejected, and expired decisions. - Prevent
execution of gated actions before approval. - Understand safe handling
of approval identity and request association.

Completion criteria - Approval boundaries and state transitions are
documented. - Gated actions cannot proceed without an explicit valid
approval. - Tests cover approval, rejection, expiry, duplicate requests,
and invalid transitions. - No external side effect is enabled without
explicit authorization.

Milestone 11 --- Retries, error handling, and observability
Learning objectives - Classify transient and permanent failures. -
Design bounded retries, backoff, and timeout behavior. - Add structured,
privacy-conscious logs and request correlation. - Measure model calls,
tool calls, latency, and failure rates.

Completion criteria - Retry rules are bounded and do not bypass
request budgets. - Errors are classified and exposed safely to API
clients. - Logs avoid credentials, raw sensitive content, and
unnecessary model reasoning. - Mock tests cover retry limits, timeouts,
and failure paths.

Milestone 12 --- Production evolution
Learning objectives - Assess production requirements and
trade-offs. - Explore persistence, authentication, authorization, rate
limiting, deployment, monitoring, and evaluation. - Understand when
components such as PostgreSQL, queues, tracing, or additional
infrastructure are justified. - Document operational and security risks.

Completion criteria - A production-readiness assessment identifies
gaps and priorities. - Architecture decisions explain why each proposed
component is needed. - Security, privacy, cost, reliability, and
deployment considerations are documented. - No infrastructure or paid
service is added without explicit approval.

Resource and safety guardrails
These are the safeguards established during earlier milestones. Verify
the current source code before relying on them; do not assume a planned
or historical value is still enforced.

OpenRouter model ID must be a free variant, ending in :free.
Every model request must retain allow_fallbacks: false.
No paid fallback, auto top-up, or payment flow.
Existing Milestone 6 request budgets included a six-model-call hard
cap, a 90-second deadline, and a two-search budget.
Search results and model-generated notes are untrusted data.
Tool execution is application-controlled, allow-listed, and
argument-validated.
Never log or publish API keys, authorization headers, .env
contents, or sensitive user data.
Use mocks for routine testing; live API tests require explicit
approval.
Session handoff checklist
At the start of a milestone: 1. Read this roadmap and the root
CLAUDE.md. 2. Inspect the actual code and current Git state. 3.
Confirm the last completed milestone and its tests. 4. Explain the next
milestone's concepts and propose a scoped plan. 5. Wait for approval
before implementation.

At the end of a milestone: 1. Run the agreed tests and report exact
results. 2. Explain the implementation and important trade-offs. 3.
Record actual call/search/token/latency implications where measurable.
4. Update this roadmap to reflect verified progress. 5. Review the diff
and secret exposure before any commit or push. 6. Wait for explicit
approval before pushing or opening a pull request.

Current next action: Plan Milestone 7 by inspecting the existing
implementation. Do not implement until the plan is reviewed and
approved.



⋮⋮⋮⋮
⋮⋮⋮⋮
