import "dotenv/config";
import process from "process";
import { z } from "zod";
import { RESEARCH_ASSISTANT_PROMPT } from "./prompts.js";
import { createToolBudget, runTool, toolDefinitions } from "./tools.js";

const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL;

if (!apiKey || !model) {
  throw new Error("Missing OpenRouter configuration in .env");
}

// Cost safety: refuse to start with anything that is not an explicitly free model.
if (!model.endsWith(":free")) {
  throw new Error(`OPENROUTER_MODEL must end with ":free" (got "${model}")`);
}

// Safety limits for tool calling, so a misbehaving model can never loop forever.
const MAX_TOOL_ROUNDS = 3; // the model may ask for tools at most 3 times per question
const MAX_TOOL_CALLS_PER_ROUND = 3; // and request at most 3 tools at once

type ToolCall = { id: string; function: { name: string; arguments: string } };

// The assistant's reply. It is kept as an open object on purpose: when the model asks
// for a tool we must send the WHOLE message back unchanged (including fields such as
// reasoning_details that reasoning models need), so we never rebuild or trim it.
type AssistantMessage = {
  content?: string | null;
  tool_calls?: ToolCall[];
  [key: string]: unknown;
};

type ChatMessage = Record<string, unknown>;

type OpenRouterResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: AssistantMessage;
  }>;
  error?: { message?: string };
};

// The shape we expect the model to return. A schema describes the data;
// Zod checks real data against it at runtime (TypeScript types vanish after compiling).
// .strict() rejects unexpected extra fields instead of silently dropping them.
const ResearchSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    key_findings: z.array(z.string()),
    risks: z.array(z.string()),
    conclusion: z.string(),
  })
  .strict();

// The TypeScript type is generated from the schema, so they can never disagree.
export type ResearchResult = z.infer<typeof ResearchSchema>;

// Turns the model's raw text into a validated object, or throws.
// Error messages never include the raw model text (it must not reach clients).
export function parseResearch(text: string): ResearchResult {
  // Some models wrap JSON in ```json fences even when told not to. Strip them.
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  // Layer 1: is it JSON at all? JSON.parse turns a string into a JS object.
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Model output is not valid JSON");
  }

  // Layer 2: is it the right shape? safeParse returns a result instead of throwing.
  const result = ResearchSchema.safeParse(parsed);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Model output failed schema validation: ${problems}`);
  }
  return result.data;
}

// One request to the model. Returns the first choice (finish_reason + message).
async function callModel(messages: ChatMessage[]) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    // Give up after 30s so a slow model can't hang our endpoint forever.
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model,
      messages,
      // Tell the model which tools exist. It may reply with a tool request
      // instead of an answer, but it can never run anything itself.
      tools: toolDefinitions,
      tool_choice: "auto",
      // A practical budget, NOT a guarantee: reasoning tokens count against it too,
      // so a broad question can still be cut off. We check finish_reason below.
      max_tokens: 2048,
      temperature: 0.2,
      // Never silently fall back to another (possibly paid) provider.
      provider: { allow_fallbacks: false },
    }),
  });

  const data = (await response.json()) as OpenRouterResponse;

  if (!response.ok) {
    throw new Error(
      `OpenRouter error (${response.status}): ${data.error?.message ?? "Unknown error"}`
    );
  }

  const choice = data.choices?.[0];
  if (!choice?.message) {
    throw new Error("No message returned from model");
  }
  return { finish_reason: choice.finish_reason, message: choice.message };
}

// Sends one question to the LLM and returns a validated research report.
// The model may ask for tools first; we run them and send the results back.
export async function askLLM(question: string): Promise<ResearchResult> {
  const messages: ChatMessage[] = [
    // System message: standing rules written by us, always sent first.
    { role: "system", content: RESEARCH_ASSISTANT_PROMPT },
    // User message: the actual question, different on every request.
    { role: "user", content: question },
  ];

  // Limits how many (paid-credit) searches this one question may trigger.
  const budget = createToolBudget();

  // Round 0 is the first request; each later round follows a batch of tool results.
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const { finish_reason, message } = await callModel(messages);
    console.log("FINISH REASON", finish_reason);
    console.log("MESSAGE", message);
    const toolCalls = message.tool_calls;
    console.log("TOOLCALLS", toolCalls);

    if (toolCalls && toolCalls.length > 0) {
      // Checks come BEFORE anything runs or is added to the history. Either we
      // handle every requested call or we fail, never half of them.
      if (round === MAX_TOOL_ROUNDS) {
        throw new Error("Too many tool rounds");
      }
      if (toolCalls.length > MAX_TOOL_CALLS_PER_ROUND) {
        throw new Error(`Too many tool calls in one round (${toolCalls.length})`);
      }
      for (const call of toolCalls) {
        if (typeof call?.id !== "string" || typeof call.function?.name !== "string") {
          throw new Error("Malformed tool call from model");
        }
      }

      // 1. Keep the model's complete request in the history, exactly as received.
      messages.push(message);

      // 2. Our code runs each tool, and every tool_call_id gets exactly one result.
      for (const call of toolCalls) {
        console.log("Tool requested: TTTTTTTT", JSON.stringify(call.function.name).slice(0, 60));
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: await runTool(call.function.name, String(call.function.arguments ?? ""), budget),
        });
      }
      // 3. Loop: the model now sees the results and writes the final answer.
      continue;
    }

    // No tool request: this is the final answer.
    // "length" means the model hit max_tokens: any JSON would be cut off and invalid.
    if (finish_reason === "length") {
      throw new Error("Model output was truncated (hit max_tokens)");
    }
    const answer = message.content;
    if (!answer) {
      throw new Error(`Empty answer from model (finish_reason: ${finish_reason})`);
    }
    return parseResearch(answer);
  }

  throw new Error("Too many tool rounds");
}
