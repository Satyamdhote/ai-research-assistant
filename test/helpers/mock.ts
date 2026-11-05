import { answerQuestion } from "../../src/agents/orchestrator.js";

// A fake OpenRouter and a fake Tavily, installed over fetch. No test uses the network or
// any real quota. Each agent is recognised by its role prompt, and each agent has its own
// list of scripted replies that are used in order.

export const TEST_KEY = "sk-or-v1-TESTKEYSECRET";
export const TEST_TAVILY_KEY = "tvly-TESTKEYSECRET";

export function setTestEnv(): void {
  process.env.OPENROUTER_API_KEY = TEST_KEY;
  process.env.OPENROUTER_MODEL = "mock/model:free";
  process.env.TAVILY_API_KEY = TEST_TAVILY_KEY;
  for (const name of ["DEBUG_LLM", "TRACE_AGENTS", "REQUEST_DEADLINE_MS", "NODE_ENV"]) {
    delete process.env[name];
  }
}

export type ToolCallSpec = { name: string; args: unknown; id?: string };

export type ModelReply = {
  content?: unknown; // the reply text (or anything else, to test odd provider data)
  toolCalls?: ToolCallSpec[]; // ask for tools instead of answering
  finish?: string; // finish_reason, default "stop" (or "tool_calls")
  status?: number; // answer with this HTTP status instead
  networkError?: boolean; // fetch itself fails
  badBody?: boolean; // 200 with a body that is not JSON
  delayMs?: number; // answer slowly (aborted if the caller gives up first)
};

export type TavilyReply = {
  status?: number;
  results?: Array<{ title: string; url: string; content: string }>;
  delayMs?: number;
};

export type Script = {
  supervisor?: ModelReply[];
  research?: ModelReply[];
  analysis?: ModelReply[];
  tavily?: TavilyReply[];
};

export type RecordedCall = { agent: string; body: Record<string, any> };

export const REPORT = {
  title: "A title",
  summary: "SENTINEL_REPORT summary",
  key_findings: ["finding"],
  risks: ["risk"],
  conclusion: "A conclusion",
};

export const route = (kind: "analysis_only" | "research_then_analysis", task = "look up the facts") =>
  JSON.stringify(
    kind === "analysis_only"
      ? { route: kind, reason: "concept question" }
      : { route: kind, research_task: task, reason: "needs current facts" }
  );

export const notes = (url: string | null = "https://example.com/one") =>
  JSON.stringify({ findings: [{ claim: "claim one", source_url: url }], gaps: [] });

export const DEFAULT_RESULTS = [
  { title: "Title One", url: "https://example.com/one", content: "Snippet one." },
  { title: "Title Two", url: "https://example.org/two", content: "Snippet two." },
];

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });

function modelResponse(reply: ModelReply): Response {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: reply.toolCalls ? null : (reply.content ?? ""),
    reasoning: "SENTINEL_REASONING",
    reasoning_details: [{ type: "reasoning.text", text: "SENTINEL_REASONING" }],
  };
  if (reply.toolCalls) {
    message.tool_calls = reply.toolCalls.map((call, i) => ({
      type: "function",
      index: i,
      id: call.id ?? `call_${i + 1}`,
      function: { name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args) },
    }));
  }
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: reply.finish ?? (reply.toolCalls ? "tool_calls" : "stop"), message }],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    })
  );
}

function agentOf(body: Record<string, any>): string {
  const system = String(body.messages?.[0]?.content ?? "");
  if (system.includes("supervisor of an AI research assistant")) return "supervisor";
  if (system.includes("research specialist")) return "research";
  if (system.includes("analysis specialist")) return "analysis";
  return "unknown";
}

export type Mock = {
  calls: RecordedCall[]; // every OpenRouter request, in order
  searches: Array<{ body: Record<string, any>; authorization: string }>; // every Tavily request
  logs: string[]; // everything printed to the console while the mock was installed
  analysisInput(): string; // the user message the analysis agent received
  restore(): void;
};

// Installs the mock. Requests to any other host (for example our own test server) pass through.
export function installMock(script: Script): Mock {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realError = console.error;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };

  const counters: Record<string, number> = {};
  const calls: RecordedCall[] = [];
  const searches: Mock["searches"] = [];
  let searchCount = 0;

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.tavily.com")) {
      const reply = script.tavily?.[searchCount] ?? script.tavily?.[script.tavily.length - 1] ?? {};
      searchCount += 1;
      const headers = init?.headers as Record<string, string>;
      searches.push({ body: JSON.parse(String(init?.body)), authorization: headers.Authorization ?? "" });
      if (reply.delayMs) await sleep(reply.delayMs, init?.signal);
      if (reply.status) return new Response("{}", { status: reply.status });
      return new Response(JSON.stringify({ results: reply.results ?? DEFAULT_RESULTS }));
    }
    if (url.includes("openrouter.ai")) {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      const agent = agentOf(body);
      calls.push({ agent, body });
      const index = counters[agent] ?? 0;
      counters[agent] = index + 1;
      const reply = (script as Record<string, ModelReply[] | undefined>)[agent]?.[index];
      if (!reply) return new Response("{}", { status: 500 }); // a test asked for more calls than it scripted
      if (reply.delayMs) await sleep(reply.delayMs, init?.signal);
      if (reply.networkError) throw new TypeError("fetch failed");
      if (reply.status) return new Response("{}", { status: reply.status });
      if (reply.badBody) return new Response("<html>not json</html>");
      return modelResponse(reply);
    }
    return realFetch(input, init);
  }) as typeof fetch;

  return {
    calls,
    searches,
    logs,
    analysisInput: () => String(calls.find((c) => c.agent === "analysis")?.body.messages[1].content ?? ""),
    restore() {
      globalThis.fetch = realFetch;
      console.log = realLog;
      console.error = realError;
    },
  };
}

export type RunResult = { mock: Mock; value?: Awaited<ReturnType<typeof answerQuestion>>; error?: Error; ms: number };

// Runs one question through the agents with the scripted mock, and always restores fetch/console.
// `env` sets extra environment variables (like DEBUG_LLM or REQUEST_DEADLINE_MS) for this run only.
export async function run(
  script: Script,
  question = "a test question",
  signal?: AbortSignal,
  env: Record<string, string> = {}
): Promise<RunResult> {
  setTestEnv();
  Object.assign(process.env, env);
  const mock = installMock(script);
  const started = Date.now();
  try {
    const value = await answerQuestion(question, signal ? { signal } : {});
    return { mock, value, ms: Date.now() - started };
  } catch (error) {
    return { mock, error: error as Error, ms: Date.now() - started };
  } finally {
    mock.restore();
    setTestEnv(); // clears the per-run flags again
  }
}
