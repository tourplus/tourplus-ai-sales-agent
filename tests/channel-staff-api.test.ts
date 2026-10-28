import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

const leadId = "00000000-0000-4000-8000-000000000001", staffId = "00000000-0000-4000-8000-000000000002", conversationId = "00000000-0000-4000-8000-000000000003", outboxId = "00000000-0000-4000-8000-000000000004", key = "00000000-0000-4000-8000-000000000005";
let role = "sales", authStatus = 0, leadVisible = true, conversationVisible = true, mode = "disabled", leadStatus = "NEW", windowOpen = true, outboxStatus = "draft";
let reads: { token: string; path: string }[] = [], writes: { token: string; input: unknown }[] = [], healthCalls = 0;
class RequestError extends Error { constructor(public status: number, message: string) { super(message); } }
class ChannelStoreError extends Error { constructor(public status: number, public code: string) { super("Store failed"); } }
const account = { channel: "whatsapp", accountId: "1234", label: "Pilot inbox", allowedRecipients: ["5678"], templates: [{ name: "booking_update", language: "en", parameterCount: 1 }] };
const configuration = () => ({ mode, accounts: [account] });
const conversation = () => ({ id: conversationId, lead_id: leadId, channel: "whatsapp", account_id: "1234", customer_id: "5678", ai_mode: "draft", last_inbound_at: new Date(Date.now() - (windowOpen ? 1000 : 25 * 3600000)).toISOString(), closed_at: null });
const outbox = () => ({ id: outboxId, conversation_id: conversationId, lead_id: leadId, status: outboxStatus, content: "Draft reply", template: null, created_at: new Date().toISOString(), lease_token: "sensitive-fixture-lease" });
const runtime = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = runtime._load;
runtime._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  if (request.endsWith("/lib/staff-auth") || request === "./staff-auth") return {
    RequestError,
    isUuid: (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
    requireStaff: async () => { if (authStatus) throw new RequestError(authStatus, "Denied"); return { id: staffId, role, accessToken: "fixture-user-token" }; },
    requireSameOrigin: (req: Request) => { if (req.headers.get("origin") !== new URL(req.url).origin) throw new RequestError(403, "Origin denied"); },
    readJsonObject: (req: Request) => req.json(),
    privateJson: (body: unknown, status = 200) => Response.json(body, { status }),
    errorResponse: (error: unknown) => Response.json({ error: error instanceof Error ? error.message : "Error" }, { status: error instanceof RequestError ? error.status : 503 }),
  };
  if (request.endsWith("/lib/channels/config")) return {
    getChannelConfiguration: configuration,
    accountFor: () => account,
    accountCanSend: () => mode === "sandbox",
    templateAllowed: (_account: unknown, template: { name: string; language: string; parameters: string[] }) => template.name === "booking_update" && template.language === "en" && template.parameters.length === 1,
    safeChannelHealth: () => { healthCalls++; return { mode, accounts: [{ channel: "whatsapp", configured: false, canSend: false, missing: ["access token"] }] }; },
  };
  if (request.endsWith("/lib/channels/store")) return {
    ChannelStoreError, conversationColumns: "id,lead_id,channel,account_id,customer_id,ai_mode,last_inbound_at,closed_at", outboxColumns: "id,conversation_id,lead_id,content,status,template,created_at", channelMessageColumns: "id,conversation_id,role,content,created_at,delivery_status,media",
    enqueueStaffReply: async (token: string, input: unknown) => { writes.push({ token, input }); return { ...outbox(), status: "queued" }; },
    approveOutboundDraft: async (token: string, input: unknown) => { writes.push({ token, input }); return { ...outbox(), status: "queued" }; },
    openNewEnquiry: async (token: string, input: unknown) => { writes.push({ token, input }); return { conversationId, leadId }; },
  };
  if (request.endsWith("/lib/public-chat")) return { consumeLimit: async () => true, requestKey: () => "fixture" };
  if (request.endsWith("/lib/supabase") || request === "./supabase") return { supabaseForUser: async (token: string, path: string) => {
    reads.push({ token, path });
    if (path.startsWith("leads?")) return Response.json(leadVisible ? [{ id: leadId, status: leadStatus }] : []);
    if (path.startsWith("channel_conversations?")) return Response.json(conversationVisible ? [conversation()] : []);
    if (path.startsWith("channel_outbox?")) return Response.json([outbox()]);
    if (path.startsWith("messages?")) return Response.json([{ id: outboxId, conversation_id: conversationId, role: "customer", content: "Enquiry", created_at: new Date().toISOString(), delivery_status: null, media: [{ url: "sensitive-fixture-media-url" }] }]);
    throw new Error("Unexpected fixture query");
  } };
  return originalLoad.call(this, request, parent, isMain);
};
const route = require("../app/api/leads/[id]/channel/route") as { GET: (req: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>; POST: (req: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> };
const health = require("../app/api/channels/route") as { GET: () => Promise<Response> };
runtime._load = originalLoad;
const context = { params: Promise.resolve({ id: leadId }) };
const get = () => route.GET(new Request(`https://example.com/api/leads/${leadId}/channel`), context);
const post = (body: object, origin = "https://example.com") => route.POST(new Request(`https://example.com/api/leads/${leadId}/channel`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }), context);
const reply = (extra: object = {}) => ({ action: "reply", conversationId, idempotencyKey: key, text: "Hello", ...extra });
function reset() { role = "sales"; authStatus = 0; leadVisible = conversationVisible = windowOpen = true; mode = "disabled"; leadStatus = "NEW"; outboxStatus = "draft"; reads = []; writes = []; healthCalls = 0; }

test("channel thread and reply deny anonymous, foreign lead and cross-origin requests", async () => {
  reset(); authStatus = 401; assert.equal((await get()).status, 401); assert.equal(reads.length, 0);
  reset(); leadVisible = false; assert.equal((await get()).status, 404); assert.equal(reads.length, 1); assert.ok(reads[0].path.includes(`assigned_staff_id=eq.${staffId}`));
  reset(); assert.equal((await post(reply(), "https://other.example")).status, 403); assert.equal(reads.length, 0); assert.equal(writes.length, 0);
});

test("disabled channels require no new schema and never enqueue replies", async () => {
  reset(); const response = await get(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { mode: "disabled", conversations: [], messages: [], outbox: [] });
  assert.ok(reads.every(item => item.path.startsWith("leads?")));
  assert.equal((await post(reply())).status, 503); assert.equal(writes.length, 0); assert.ok(reads.every(item => item.path.startsWith("leads?")));
});

test("channel mutations cannot choose recipients, accounts or another lead's conversation", async () => {
  for (const extra of [{ recipientId: "attacker" }, { accountId: "attacker" }, { idempotencyKey: "bad" }]) {
    reset(); mode = "sandbox"; assert.equal((await post(reply(extra))).status, 400); assert.equal(writes.length, 0);
  }
  reset(); mode = "sandbox"; conversationVisible = false; assert.equal((await post(reply())).status, 404); assert.equal(writes.length, 0);
});

test("thread DTO omits media URLs and outbox lease credentials", async () => {
  reset(); mode = "sandbox"; const response = await get(); assert.equal(response.status, 200); const text = await response.text(); assert.equal(text.includes("sensitive-fixture"), false);
  const body = JSON.parse(text); assert.equal(body.messages[0].mediaCount, 1); assert.equal(body.conversations[0].canSend, true); assert.ok(reads.every(item => item.token === "fixture-user-token"));
  assert.ok(reads.filter(item => item.path.startsWith("channel_outbox?")).every(item => !item.path.includes("select=*") && !item.path.includes("lease_token")));
});

test("expired freeform replies need an allowlisted WhatsApp template", async () => {
  reset(); mode = "sandbox"; windowOpen = false; assert.equal((await post(reply())).status, 409); assert.equal(writes.length, 0);
  assert.equal((await post({ action: "reply", conversationId, idempotencyKey: key, template: { name: "booking_update", language: "en", parameters: ["Confirmed time"] } })).status, 202);
  assert.equal(writes[0].token, "fixture-user-token"); assert.equal((writes[0].input as { idempotencyKey: string }).idempotencyKey, key);
  assert.equal((await post({ action: "reply", conversationId, idempotencyKey: key, template: { name: "not_approved", language: "en", parameters: [] } })).status, 400);
});

test("channel reply caps count multilingual UTF-8 bytes before enqueue", async () => {
  reset(); mode = "sandbox";
  assert.equal((await post(reply({ text: "旅".repeat(667) }))).status, 400);
  assert.equal(writes.length, 0);
  assert.equal((await post(reply({ text: "旅".repeat(666) }))).status, 202);
  assert.equal(writes.length, 1);
});

test("unknown outcomes cannot be approved or retried and terminal leads require a new enquiry", async () => {
  reset(); mode = "sandbox"; outboxStatus = "unknown"; assert.equal((await post({ action: "approve_draft", outboxId })).status, 409); assert.equal(writes.length, 0);
  assert.equal((await post({ action: "retry", outboxId })).status, 400); assert.equal(writes.length, 0);
  reset(); mode = "sandbox"; leadStatus = "CONFIRMED"; assert.equal((await post(reply())).status, 409); assert.equal(writes.length, 0);
  assert.equal((await post({ action: "new_enquiry", conversationId })).status, 201); assert.equal(writes.length, 1);
});

test("connection readiness is Admin only and reports no provider verification", async () => {
  reset(); assert.equal((await health.GET()).status, 403); assert.equal(healthCalls, 0);
  reset(); role = "admin"; const response = await health.GET(); assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.verification, "configuration_only"); assert.equal(body.mode, "disabled");
});
