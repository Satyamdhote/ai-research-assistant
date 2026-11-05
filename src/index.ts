import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "process";
import { answerQuestion } from "./agents.js";

// Port 3000 by default; override with e.g. `PORT=3001 npm start` if it is taken.
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 10_000; // a question should never be bigger than this

// Helper: send a JSON response with a status code.
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// Helper: read the request body into a string (with a size limit).
async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new Error("Body too large");
  }
  return body;
}

const server = createServer(async (req, res) => {
  if (req.url !== "/ask") {
    return sendJson(res, 404, { error: "Not found" });
  }
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Use POST" });
  }

  // 1. Parse and validate the input.
  let question: unknown;
  try {
    question = (JSON.parse(await readBody(req)) as { question?: unknown }).question;
  } catch {
    return sendJson(res, 400, { error: "Body must be valid JSON" });
  }
  if (typeof question !== "string" || question.trim() === "") {
    return sendJson(res, 400, { error: '"question" must be a non-empty string' });
  }

  // 2. Ask the LLM. Log details server-side, return a generic error to the client.
  try {
    const result = await answerQuestion(question.trim());
    sendJson(res, 200, result);
  } catch (error) {
    // Our errors carry fixed messages, so only the message is logged (no objects or stacks).
    console.error("Request failed:", error instanceof Error ? error.message : "unknown error");
    sendJson(res, 502, { error: "The AI model could not answer. Try again." });
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
