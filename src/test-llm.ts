import "dotenv/config";
import process from "process";

const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL;

if (!apiKey || !model) {
  throw new Error("Missing OpenRouter configuration in .env");
}

async function testLLM() {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: "In two sentences, explain what an AI agent is.",
        },
      ],
      max_tokens: 1024,
      temperature: 0.2,
      provider: {
        allow_fallbacks: false,
      },
    }),
  });

  const data = await response.json() as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string | null };
    }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(
      `OpenRouter error (${response.status}): ${data.error?.message ?? "Unknown error"}`
    );
  }

  console.log("Model:", model);
  const choice = data.choices?.[0];
  const answer = choice?.message?.content;
  if (!answer) {
    throw new Error(
      `No answer returned (finish_reason: ${choice?.finish_reason}). ` +
        "Reasoning models can spend all max_tokens on thinking; raise max_tokens."
    );
  }
  console.log("Answer:", answer);
}

testLLM().catch((error: unknown) => {
  console.error("Request failed:", error);
  process.exitCode = 1;
});