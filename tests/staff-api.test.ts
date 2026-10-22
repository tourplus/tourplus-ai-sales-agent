import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const actorId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const email = "fixture@example.invalid";
const base = "https://crm.example.com";
const db = "https://database.example.com";
let role = "admin", authStatus = 0, confirmed = false, existing = false, membership = false, deliveryFailure = false;
let calls: string[] = [], rpcBody: Record<string, unknown> = {};
const row = () => ({ user_id: memberId, role: "sales", active: true, display_name: null, invited_at: "2026-10-23T00:00:00Z", created_at: "2026-10-23T00:00:00Z" });
const identity = () => ({ id: memberId, email, email_confirmed_at: confirmed ? "2026-10-23T00:00:00Z" : null });
class RequestError extends Error { constructor(public status: number, message: string) { super(message); } }
const runtime = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = runtime._load;
const originalFetch = global.fetch;

runtime._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  if (request.endsWith("/lib/staff-auth") || request === "./staff-auth") return {
    RequestError,
    isUuid: (value: unknown) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value),
    requireStaff: async () => { if (authStatus) throw new RequestError(authStatus, "Access denied"); return { id: actorId, role, accessToken: "fixture-token" }; },
    requireSameOrigin: (req: Request) => { if (req.headers.get("origin") !== new URL(req.url).origin) throw new RequestError(403, "Origin denied"); },
    readJsonObject: (req: Request) => req.json(),
    privateJson: (body: unknown, status = 200) => Response.json(body, { status }),
    errorResponse: (error: unknown) => Response.json({ error: error instanceof Error ? error.message : "Error" }, { status: error instanceof RequestError ? error.status : 503 }),
  };
  if (request.endsWith("/lib/public-chat")) return { consumeLimit: async () => true, requestKey: () => "fixture", hashToken: () => "fixture-email-hash" };
  if (request.endsWith("/lib/supabase") || request === "./supabase") return {
    supabaseConfig: () => ({ url: db, anon: "fixture-anon" }),
    supabase: async (_path: string, init: RequestInit = {}) => {
      if (init.method === "POST") { calls.push("membership-create"); membership = true; return Response.json([row()]); }
      calls.push("membership-read"); return Response.json(membership ? [row()] : []);
    },
    supabaseForUser: async (token: string, path: string, init: RequestInit) => {
      assert.equal(token, "fixture-token"); assert.equal(path, "rpc/manage_staff_member");
      rpcBody = JSON.parse(String(init.body)); calls.push("membership-rpc"); return Response.json({ ...row(), display_name: rpcBody.p_display_name });
    },
  };
  return originalLoad.call(this, request, parent, isMain);
};
const { POST } = require("../app/api/staff/invitations/route") as { POST: (request: Request) => Promise<Response> };
const { PATCH } = require("../app/api/staff/members/[id]/route") as { PATCH: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
runtime._load = originalLoad;

function reset() {
  role = "admin"; authStatus = 0; confirmed = false; existing = false; membership = false; deliveryFailure = false; calls = []; rpcBody = {};
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fixture-service-key";
  global.fetch = async (input, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/admin/users") && !init.method) { calls.push("auth-lookup"); return Response.json({ users: existing ? [identity()] : [] }); }
    if (url.pathname.endsWith("/admin/users") && init.method === "POST") { calls.push("auth-create"); existing = true; return Response.json(identity()); }
    if (url.pathname.endsWith("/admin/users/" + memberId)) return Response.json(identity());
    if (url.pathname.endsWith("/admin/generate_link")) {
      calls.push("generate-link");
      assert.equal(membership, true, "membership must exist before a redeemable token is generated");
      const body = JSON.parse(String(init.body));
      assert.equal(body.type, "invite"); assert.equal(body.redirect_to, base + "/staff/reset");
      assert.equal(url.searchParams.get("redirect_to"), base + "/staff/reset");
      return Response.json({ ...identity(), action_link: `${db}/auth/v1/verify?type=invite&token=fixture-opaque-token&redirect_to=${encodeURIComponent(body.redirect_to)}` });
    }
    if (url.pathname.endsWith("/invite")) { calls.push("email-invite"); assert.equal(membership, true); return Response.json({}, { status: deliveryFailure ? 422 : 200 }); }
    throw new Error("Unexpected fixture request");
  };
}
const request = (body: object, path = "/api/staff/invitations", origin = base) => new Request(base + path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const invite = (extra: object = {}) => POST(request({ email, role: "sales", mode: "link", ...extra }));

test("staff invitations reject anonymous, Sales and cross-origin requests before side effects", async () => {
  reset(); authStatus = 401; assert.equal((await invite()).status, 401); assert.deepEqual(calls, []);
  reset(); role = "sales"; assert.equal((await invite()).status, 403); assert.deepEqual(calls, []);
  reset(); assert.equal((await POST(request({ email, role: "sales", mode: "link" }, undefined, "https://other.example"))).status, 403); assert.deepEqual(calls, []);
});

test("inviting an existing non-staff or confirmed account cannot modify credentials or membership", async () => {
  reset(); existing = true; assert.equal((await invite()).status, 409); assert.deepEqual(calls, ["auth-lookup", "membership-read"]);
  reset(); existing = membership = confirmed = true; assert.equal((await invite({ resend: true })).status, 409); assert.deepEqual(calls, ["auth-lookup", "membership-read"]);
});

test("manual invitation provisions staff before generating a link and returns only safe fields", async () => {
  reset(); const response = await invite(); assert.equal(response.status, 201);
  assert.deepEqual(calls, ["auth-lookup", "auth-create", "membership-create", "generate-link"]);
  const body = await response.json(); assert.equal(body.delivery, "link"); assert.equal(body.member.status, "pending");
  assert.equal(new URL(body.invitation_link).searchParams.get("redirect_to"), base + "/staff/reset");
  assert.equal(body.access_token, undefined); assert.equal(body.member.email_confirmed_at, undefined); assert.equal(body.member.identities, undefined);
});

test("pending resend is explicit and cannot silently change the saved role", async () => {
  reset(); existing = membership = true; assert.equal((await invite()).status, 409); assert.ok(!calls.includes("generate-link"));
  reset(); existing = membership = true; assert.equal((await invite({ resend: true, role: "admin" })).status, 409); assert.ok(!calls.includes("generate-link"));
  reset(); existing = membership = true; assert.equal((await invite({ resend: true })).status, 201); assert.ok(!calls.includes("auth-create")); assert.ok(!calls.includes("membership-create"));
});

test("native email rejection reports delivery failure while preserving pending access", async () => {
  reset(); deliveryFailure = true; const response = await invite({ mode: "email" }); assert.equal(response.status, 502);
  const body = await response.json(); assert.equal(body.delivery, "failed"); assert.equal(body.member.status, "pending"); assert.equal(membership, true); assert.equal(body.invitation_link, undefined);
});

test("name-only changes preserve permission fields inside the locked RPC", async () => {
  reset(); existing = membership = true;
  const response = await PATCH(request({ display_name: "Renamed" }, "/api/staff/members/" + memberId), { params: Promise.resolve({ id: memberId }) });
  assert.equal(response.status, 200); assert.equal(rpcBody.p_target_user_id, memberId); assert.equal(rpcBody.p_role, null); assert.equal(rpcBody.p_active, null); assert.equal(rpcBody.p_display_name, "Renamed");
});

test.after(() => { global.fetch = originalFetch; });
