import { LIMITS } from "../config.js";
import { callModel } from "../llm/openrouter.js";
import { logStage } from "../observability/log.js";
import { StageFailure, type RequestContext } from "../request/context.js";
import { getToolDefinitions, isToolName, runTool } from "../tools/index.js";
import { normalizeUrl } from "../tools/searchResult.js";
import type { ChatMessage, Stage, ToolName } from "../types.js";

// One agent = a role prompt + the tools it may use + a bounded loop.
export type AgentConfig = {
  stage: Stage;
  system: string; // the agent's role prompt
  user: string; // what the orchestrator wants it to work on
  toolNames: ToolName[]; // [] means this agent gets no tools at all
  maxToolRounds: number; // how many times it may ask for tools; model calls = rounds + 1
  maxTokens: number;
};

// Runs one agent and returns its final text. The model may ask for tools first; we run
// them and send the results back, but only up to maxToolRounds times.
export async function runAgent(config: AgentConfig, ctx: RequestContext): Promise<string> {
  const allowed = new Set<string>(config.toolNames);
  const tools = getToolDefinitions(config.toolNames);
  // Each agent starts with its OWN message list: this is its separate context window.
  const messages: ChatMessage[] = [
    { role: "system", content: config.system },
    { role: "user", content: config.user },
  ];

  // The last allowed call must produce the final answer, not another tool request.
  const maxCalls = config.maxToolRounds + 1;

  for (let call = 1; call <= maxCalls; call++) {
    const { finish_reason, message } = await callModel(
      messages,
      { stage: config.stage, tools, maxTokens: config.maxTokens },
      ctx
    );
    const toolCalls = message.tool_calls;

    if (toolCalls && toolCalls.length > 0) {
      // Checks come BEFORE anything runs or is added to the history. Either we
      // handle every requested call or we fail, never half of them.
      if (allowed.size === 0) {
        throw new StageFailure("unexpected_tool_call");
      }
      if (call === maxCalls) {
        throw new StageFailure("too_many_tool_rounds");
      }
      if (toolCalls.length > LIMITS.MAX_TOOL_CALLS_PER_ROUND) {
        throw new StageFailure("too_many_tool_calls");
      }
      for (const toolCall of toolCalls) {
        if (typeof toolCall?.id !== "string" || typeof toolCall.function?.name !== "string") {
          throw new StageFailure("malformed_tool_call");
        }
      }

      // 1. Keep the model's complete request in the history, exactly as received.
      messages.push(message);

      // 2. Our code runs each tool, and every tool_call_id gets exactly one result.
      for (const toolCall of toolCalls) {
        const name = toolCall.function.name;
        const result =
          isToolName(name) && allowed.has(name)
            ? await runTool(name, String(toolCall.function.arguments ?? ""), ctx)
            : { text: "Error: unknown tool" }; // not allowed for this agent: treated as if it does not exist

        // The APPLICATION records what really happened (never the model's own claim).
        if (result.search) {
          ctx.searchOutcomes.push(result.search.outcome);
          for (const url of result.search.urls) ctx.observedUrls.add(normalizeUrl(url));
        }
        logStage({
          event: "tool_call",
          stage: config.stage,
          call: ctx.modelCalls, // the request-wide number of the model call that asked for this tool
          tool: isToolName(name) ? name : "<invalid>",
          ...(result.search ? { searchOutcomes: [result.search.outcome] } : {}),
        });

        messages.push({ role: "tool", tool_call_id: toolCall.id, content: result.text });
      }
      // 3. Loop: the model now sees the results and continues.
      continue;
    }

    // No tool request: this is the agent's final answer.
    // "length" means the model hit max_tokens: any JSON would be cut off and invalid.
    if (finish_reason === "length") {
      throw new StageFailure("truncated");
    }
    // content is unchecked provider data: only a non-empty string counts as an answer.
    const answer = message.content;
    if (typeof answer !== "string" || answer.trim() === "") {
      throw new StageFailure("model_error");
    }
    return answer;
  }

  throw new StageFailure("too_many_tool_rounds");
}
