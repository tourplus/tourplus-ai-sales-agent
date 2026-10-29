import { createHmac, timingSafeEqual } from "node:crypto";
import { CHANNEL_WORKER_ORIGIN, CHANNEL_WORKER_PATH } from "./worker-kickoff";

export const CHANNEL_WORKER_URL = CHANNEL_WORKER_ORIGIN + CHANNEL_WORKER_PATH;
export const WORKER_TIMESTAMP_HEADER = "X-Tourplus-Worker-Timestamp";
export const WORKER_NONCE_HEADER = "X-Tourplus-Worker-Nonce";
export const WORKER_SIGNATURE_HEADER = "X-Tourplus-Worker-Signature";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// This byte-for-byte format is also implemented by the signed-dispatch SQL.
// The transport queue receives a short-lived signature, never the Vault key.
export function workerSigningMessage(timestamp: string, nonce: string): string {
  return `tourplus-worker-v1\nPOST\n${CHANNEL_WORKER_URL}\n${timestamp}\n${nonce}\n{}`;
}

export function signWorkerDispatch(secret: string, timestamp: string, nonce: string): string {
  return "v1=" + createHmac("sha256", secret).update(workerSigningMessage(timestamp, nonce), "utf8").digest("hex");
}

export type VerifiedWorkerDispatch = { nonce: string; timestamp: number };

export function verifyWorkerDispatch(input: {
  method: string; url: string; body: string; headers: Headers; secret: string; now?: number;
}): VerifiedWorkerDispatch | null {
  if (input.method !== "POST" || input.url !== CHANNEL_WORKER_URL || input.body !== "{}") return null;
  if (input.secret.length < 32 || input.secret.length > 4096 || /[\u0000-\u0020\u007f]/.test(input.secret)) return null;
  const timestampText = input.headers.get(WORKER_TIMESTAMP_HEADER) || "";
  const nonce = input.headers.get(WORKER_NONCE_HEADER) || "";
  const signature = input.headers.get(WORKER_SIGNATURE_HEADER) || "";
  if (!/^[1-9][0-9]{0,11}$/.test(timestampText) || !uuid.test(nonce) || !/^v1=[0-9a-f]{64}$/.test(signature)) return null;
  const timestamp = Number(timestampText), now = Math.floor((input.now ?? Date.now()) / 1000);
  if (!Number.isSafeInteger(now) || timestamp < now - 120 || timestamp > now + 5) return null;
  const expected = signWorkerDispatch(input.secret, timestampText, nonce);
  return timingSafeEqual(Buffer.from(signature, "ascii"), Buffer.from(expected, "ascii")) ? { nonce, timestamp } : null;
}

// The canonical signed body is only two bytes. Bound streaming as well as the
// Content-Length hint so an unauthenticated request cannot buffer a large body.
export async function readWorkerBody(request: Request): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > 256)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 3000);
  try {
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 256) { await reader.cancel(); return null; }
      chunks.push(next.value);
    }
    return timedOut ? null : new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch { return null; }
  finally { clearTimeout(deadline); reader.releaseLock(); }
}
