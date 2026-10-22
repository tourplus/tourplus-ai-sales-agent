import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const leadId = "00000000-0000-4000-8000-000000000001";
const staffId = "00000000-0000-4000-8000-000000000002";
const activityId = "00000000-0000-4000-8000-000000000003";
let role = "sales";
let authStatus = 0;
let visible = true;
let rows: { id: string; created_at: string }[] = [];
let requests: { token: string; path: string }[] = [];
class RequestError extends Error { constructor(public status: number, message: string) { super(message); } }
const runtime = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = runtime._load;
runtime._load = function (request, parent, isMain) {
  if (request.endsWith("/lib/staff-auth")) return {
    isUuid: (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    RequestError,
    requireStaff: async () => {
      if (authStatus) throw new RequestError(authStatus, "Access denied");
      return { id: staffId, role, accessToken: "test-user-token" };
    },
    privateJson: (body: unknown, status = 200) => Response.json(body, { status }),
    errorResponse: (error: unknown) => Response.json({ error: error instanceof Error ? error.message : "Error" }, { status: error instanceof RequestError ? error.status : 503 }),
  };
  if (request.endsWith("/lib/supabase")) return { supabaseForUser: async (token: string, path: string) => {
    requests.push({ token, path });
    return Response.json(path.startsWith("leads?") ? visible ? [{ id: leadId }] : [] : rows);
  } };
  if (request === "../../validation") return { databaseError: (status: number) => { throw new RequestError(status, "Database request failed"); } };
  return originalLoad.call(this, request, parent, isMain);
};
// Requiring after the dependency substitutions exercises the real route handler.
const { GET } = require("../app/api/leads/[id]/activities/route") as { GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
runtime._load = originalLoad;

function reset() { role = "sales"; authStatus = 0; visible = true; rows = []; requests = []; }
const request = (query = "", id = leadId) => GET(new Request("https://example.com/api/leads/" + id + "/activities" + query), { params: Promise.resolve({ id }) });

test("activity API denies unauthenticated callers before database access", async () => {
  reset(); authStatus = 401;
  assert.equal((await request()).status, 401);
  assert.equal(requests.length, 0);
});

test("activity API hides another Sales lead before querying history", async () => {
  reset(); visible = false;
  assert.equal((await request()).status, 404);
  assert.equal(requests.length, 1);
  const query = new URLSearchParams(requests[0].path.split("?")[1]);
  assert.equal(query.get("assigned_staff_id"), "eq." + staffId);
  assert.equal(requests[0].token, "test-user-token");
});

test("activity API bounds pages and preserves microsecond timestamp plus UUID tie-breaker", async () => {
  reset(); role = "admin";
  const stamp = "2026-10-23T01:02:03.123456+00:00";
  rows = [{ id: activityId, created_at: stamp }, { id: staffId, created_at: stamp }];
  const response = await request("?limit=1");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.activities.length, 1);
  assert.deepEqual(JSON.parse(Buffer.from(body.nextCursor, "base64url").toString()), { id: activityId, created_at: stamp });
  let query = new URLSearchParams(requests[1].path.split("?")[1]);
  assert.equal(query.get("order"), "created_at.desc,id.desc");
  assert.equal(query.get("limit"), "2");
  assert.equal(new URLSearchParams(requests[0].path.split("?")[1]).has("assigned_staff_id"), false);
  rows = [];
  await request("?cursor=" + body.nextCursor);
  query = new URLSearchParams(requests[3].path.split("?")[1]);
  assert.equal(query.get("or"), `(created_at.lt.${stamp},and(created_at.eq.${stamp},id.lt.${activityId}))`);
  assert.ok(requests.every(item => item.token === "test-user-token"));
});

test("activity API rejects malformed IDs, oversized pages and injected cursor filters", async () => {
  for (const query of ["?limit=0", "?limit=51", "?limit=1.5", "?limit=-1", "?cursor=invalid"]) {
    reset(); assert.equal((await request(query)).status, 400); assert.equal(requests.length, 0);
  }
  for (const cursor of [
    { id: activityId, created_at: "2026-10-23T01:02:03Z),id.neq.secret" },
    { id: "bad&id=all", created_at: "2026-10-23T01:02:03Z" },
    { id: activityId, created_at: "2026-02-31T01:02:03Z" },
  ]) {
    reset();
    assert.equal((await request("?cursor=" + Buffer.from(JSON.stringify(cursor)).toString("base64url"))).status, 400);
    assert.equal(requests.length, 0);
  }
  reset(); assert.equal((await request("", "bad-id")).status, 400); assert.equal(requests.length, 0);
});
