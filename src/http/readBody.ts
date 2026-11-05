import type { IncomingMessage } from "node:http";
import { LIMITS } from "../config.js";

export class BodyTooLargeError extends Error {
  constructor() {
    super("Body too large");
  }
}

// Reads the request body into a string, refusing anything bigger than the limit.
// The limit counts BYTES (not characters), so multi-byte text cannot sneak past it.
// When the limit is exceeded the rest of the upload is discarded (not buffered) so the
// early error response can still be delivered.
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buffer.length;
      if (total > LIMITS.MAX_BODY_BYTES) {
        cleanup();
        req.resume(); // drain and throw away the remainder
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}
