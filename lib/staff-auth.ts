import "server-only";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { supabase, supabaseAuth, supabaseForUser } from "./supabase";

export const STAFF_ACCESS_COOKIE = "tp_staff_session";
export const STAFF_REFRESH_COOKIE = "tp_staff_refresh";
export const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export type Staff = { id: string; email: string; role: "admin" | "sales"; accessToken: string };
export type AuthSession = { access_token: string; refresh_token: string; expires_in: number };

export class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: {
    "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache", "Expires": "0", "Vary": "Cookie",
  } });
}

export function errorResponse(error: unknown) {
  return error instanceof RequestError
    ? privateJson({ error: error.message }, error.status)
    : privateJson({ error: "Service temporarily unavailable. Please try again." }, 503);
}

export function requireSameOrigin(req: Request) {
  if (req.headers.get("origin") !== new URL(req.url).origin || req.headers.get("sec-fetch-site") === "cross-site") {
    throw new RequestError(403, "Request origin is not allowed");
  }
}

export async function readJsonObject(req: Request, maxBytes = 32768): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new RequestError(415, "Content-Type must be application/json");
  }
  if (Number(req.headers.get("content-length")) > maxBytes) throw new RequestError(413, "Request is too large");
  const reader = req.body?.getReader();
  if (!reader) throw new RequestError(400, "A JSON object is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new RequestError(413, "Request is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new RequestError(400, "Invalid JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError(400, "A JSON object is required");
  return body as Record<string, unknown>;
}

export const publicStaff = (staff: Staff) => ({ id: staff.id, email: staff.email, role: staff.role });

export async function staffForToken(token: string): Promise<Staff> {
  if (!token || token.length > 8192) throw new RequestError(401, "Please sign in");
  // Always contact Auth: decoding a JWT alone cannot establish a live session.
  const auth = await supabaseAuth("user", {}, token);
  if ([400, 401, 403].includes(auth.status)) throw new RequestError(401, "Please sign in");
  if (!auth.ok) throw new RequestError(503, "Authentication is temporarily unavailable");
  const user = await auth.json();
  if (!isUuid(user?.id) || typeof user?.email !== "string" || user.is_anonymous === true) throw new RequestError(401, "Please sign in");
  const session = await supabaseForUser(token, "rpc/current_staff_session_active", { method: "POST", body: "{}" });
  if ([401, 403].includes(session.status)) throw new RequestError(401, "Please sign in");
  if (!session.ok) throw new RequestError(503, "Session verification is temporarily unavailable");
  if ((await session.json()) !== true) throw new RequestError(401, "Please sign in");
  const lookup = await supabase(`staff_members?user_id=eq.${user.id}&active=eq.true&select=user_id,role&limit=1`);
  if (!lookup.ok) throw new RequestError(503, "Staff access is temporarily unavailable");
  const member = (await lookup.json())[0];
  if (!member || !["admin", "sales"].includes(member.role)) throw new RequestError(403, "This account does not have staff access");
  return { id: user.id, email: user.email, role: member.role, accessToken: token };
}

export async function requireStaff(): Promise<Staff> {
  const token = (await cookies()).get(STAFF_ACCESS_COOKIE)?.value;
  if (!token) throw new RequestError(401, "Please sign in");
  return staffForToken(token);
}

export async function staffUser(): Promise<Staff | null> {
  try { return await requireStaff(); } catch { return null; }
}

export async function staffRequired() { return (await staffUser()) !== null; }

export function setStaffCookies(response: NextResponse, session: AuthSession) {
  if (typeof session.access_token !== "string" || typeof session.refresh_token !== "string") throw new RequestError(503, "Unable to establish staff session");
  const options = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };
  response.cookies.set(STAFF_ACCESS_COOKIE, session.access_token, { ...options, maxAge: Math.min(Math.max(Number(session.expires_in) || 3600, 60), 3600) });
  response.cookies.set(STAFF_REFRESH_COOKIE, session.refresh_token, { ...options, maxAge: 60 * 60 * 24 * 7 });
  return response;
}

export function clearStaffCookies(response: NextResponse) {
  const options = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: 0 };
  response.cookies.set(STAFF_ACCESS_COOKIE, "", options);
  response.cookies.set(STAFF_REFRESH_COOKIE, "", options);
  return response;
}
