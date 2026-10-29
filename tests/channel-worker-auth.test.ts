import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { randomUUID } from "node:crypto";
import { CHANNEL_WORKER_URL, WORKER_NONCE_HEADER, WORKER_SIGNATURE_HEADER, WORKER_TIMESTAMP_HEADER, readWorkerBody, signWorkerDispatch, verifyWorkerDispatch, workerSigningMessage } from "../lib/channels/worker-auth";

const secret = "offline-worker-signing-fixture-" + "x".repeat(32);
const nonce = "10000000-0000-4000-8000-000000000001";
const epoch = 1800000000;
function headers(timestamp = epoch, dispatchNonce = nonce) {
  return new Headers({ [WORKER_TIMESTAMP_HEADER]: String(timestamp), [WORKER_NONCE_HEADER]: dispatchNonce,
    [WORKER_SIGNATURE_HEADER]: signWorkerDispatch(secret, String(timestamp), dispatchNonce) });
}
const input = () => ({ method: "POST", url: CHANNEL_WORKER_URL, body: "{}", headers: headers(), secret, now: epoch * 1000 });

test("signed worker protocol binds canonical POST URL, exact body, timestamp and nonce", () => {
  assert.equal(workerSigningMessage(String(epoch), nonce), `tourplus-worker-v1\nPOST\n${CHANNEL_WORKER_URL}\n${epoch}\n${nonce}\n{}`);
  assert.deepEqual(verifyWorkerDispatch(input()), { nonce, timestamp: epoch });
  for (const change of [{ method: "GET" }, { url: CHANNEL_WORKER_URL + "?limit=10" }, { url: CHANNEL_WORKER_URL.replace("https:", "http:") },
    { url: CHANNEL_WORKER_URL.replace("tourplus-ai-sales-agent", "preview") }, { body: "{ }" }, { body: "{}\n" }, { body: '{"limit":10}' }, { secret: "wrong".repeat(10) }]) {
    assert.equal(verifyWorkerDispatch({ ...input(), ...change }), null);
  }
  for (const [name, value] of [[WORKER_TIMESTAMP_HEADER, String(epoch - 1)], [WORKER_NONCE_HEADER, randomUUID()], [WORKER_SIGNATURE_HEADER, "v1=" + "0".repeat(64)]]) {
    const request = input(); request.headers.set(name, value);
    assert.equal(verifyWorkerDispatch(request), null);
  }
});

test("worker signature clock limits are inclusive at minus120 and plus5 seconds", () => {
  for (const offset of [-120, 0, 5]) assert.ok(verifyWorkerDispatch({ ...input(), headers: headers(epoch + offset) }));
  for (const offset of [-121, 6]) assert.equal(verifyWorkerDispatch({ ...input(), headers: headers(epoch + offset) }), null);
  for (const timestamp of ["01800000000", "1800000000.0", "+1800000000", "1e9", "", "99999999999999"]) {
    const request = input(); request.headers.set(WORKER_TIMESTAMP_HEADER, timestamp);
    assert.equal(verifyWorkerDispatch(request), null);
  }
});

test("signed worker request reader bounds streamed and declared bodies", async () => {
  assert.equal(await readWorkerBody(new Request(CHANNEL_WORKER_URL, { method: "POST", body: "{}" })), "{}");
  assert.equal(await readWorkerBody(new Request(CHANNEL_WORKER_URL, { method: "POST", headers: { "Content-Length": "257" }, body: "{}" })), null);
  assert.equal(await readWorkerBody(new Request(CHANNEL_WORKER_URL, { method: "POST", body: "x".repeat(257) })), null);
});

test("worker route consumes issued nonce before work and denies replay, tamper and unissued signatures", async () => {
  const loader = Module as unknown as { _load: (request: string, parent: unknown, main: boolean) => unknown };
  const originalLoad = loader._load;
  const operations: string[] = [], consumed = new Set<string>(), issued = new Set<string>();
  let consumeFails = false;
  loader._load = function (name, parent, main) {
    if (name.endsWith("lib/channels/config")) return { getChannelConfiguration: () => ({ mode: "live", accounts: [], workerSecret: secret }) };
    if (name.endsWith("lib/channels/worker")) return { createChannelWorker: () => ({ run: async () => { operations.push("work"); return { processed: 0 }; } }) };
    if (name.endsWith("lib/channels/store") || name.endsWith("lib/channels/provider") || name.endsWith("lib/channels/ai")) return {};
    if (name.endsWith("lib/supabase")) return { supabase: async (path: string, init: RequestInit) => {
      assert.equal(path, "rpc/consume_channel_worker_nonce"); operations.push("consume");
      const payload = JSON.parse(String(init.body));
      if (consumeFails) return Response.json({ error: "private database detail" }, { status: 500 });
      const accepted = issued.has(payload.p_nonce) && !consumed.has(payload.p_nonce);
      if (accepted) consumed.add(payload.p_nonce);
      return Response.json(accepted);
    } };
    return name === "server-only" ? {} : originalLoad.call(this, name, parent, main);
  };
  let route: typeof import("../app/api/channels/worker/route");
  try { route = require("../app/api/channels/worker/route"); } finally { loader._load = originalLoad; }
  const timestamp = Math.floor(Date.now() / 1000);
  const request = (dispatchNonce: string, body = "{}") => new Request(CHANNEL_WORKER_URL, { method: "POST", body, headers: headers(timestamp, dispatchNonce) });
  const validNonce = randomUUID(); issued.add(validNonce);
  assert.equal((await route.POST(request(validNonce))).status, 200);
  assert.deepEqual(operations, ["consume", "work"]);
  assert.equal((await route.POST(request(validNonce))).status, 401);
  assert.deepEqual(operations, ["consume", "work", "consume"]);
  assert.equal((await route.POST(request(randomUUID()))).status, 401);
  const before = operations.length;
  assert.equal((await route.POST(request(randomUUID(), "{ }"))).status, 401);
  assert.equal((await route.POST(request(randomUUID(), "x".repeat(257)))).status, 401);
  assert.equal(operations.length, before);
  consumeFails = true;
  const failure = await route.POST(request(randomUUID()));
  assert.equal(failure.status, 503); assert.doesNotMatch(await failure.text(), /private database detail/);
  assert.equal(operations.filter(operation => operation === "work").length, 1);
  const bearer = await route.POST(new Request(CHANNEL_WORKER_URL, { method: "POST", body: "{}", headers: { Authorization: "Bearer " + secret } }));
  assert.equal(bearer.status, 200);
  assert.equal(operations.filter(operation => operation === "work").length, 2);
});
