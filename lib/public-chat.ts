import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { supabase } from "./supabase";

export const CHAT_COOKIE = "tp_chat_session";
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

export async function consumeLimit(key: string, limit: number, seconds: number) {
  const r = await supabase("rpc/consume_chat_limit", {
    method: "POST", body: JSON.stringify({ p_key: key, p_limit: limit, p_window_seconds: seconds })
  });
  if (!r.ok) throw new Error("Rate limit service unavailable");
  return (await r.json()) === true;
}

export function requestKey(req: Request, namespace: string) {
  // Vercel overwrites this header. Do not trust a caller-supplied x-forwarded-for.
  const ip = process.env.VERCEL ? req.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown" : "local";
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("Server configuration missing");
  return namespace + ":" + createHmac("sha256", secret).update(ip).digest("hex");
}

export async function jsonRows(path: string, init?: RequestInit) {
  const response = await supabase(path, init);
  if (!response.ok) throw new Error("Database operation failed");
  return response.json();
}
