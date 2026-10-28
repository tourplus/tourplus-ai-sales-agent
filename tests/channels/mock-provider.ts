import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Socket } from "node:net";

export type MockBehavior = "success" | "rate_limit" | "unavailable" | "rejected" | "uncertain";
export type ReceivedSend = { path: string; method: string; body: Record<string, unknown>; authorization: string | undefined };

export async function createMockProvider() {
  const received: ReceivedSend[] = [];
  const behaviors: MockBehavior[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk.toString();
      if (raw.length > 65536) { response.writeHead(413).end(); return; }
    }
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { response.writeHead(400).end(); return; }
    received.push({ path: request.url || "", method: request.method || "", body, authorization: request.headers.authorization });
    const behavior = behaviors.shift() || "success";
    response.setHeader("Content-Type", "application/json");
    if (behavior === "uncertain") { request.socket.destroy(); return; }
    if (behavior === "rate_limit") { response.writeHead(429, { "Retry-After": "1" }).end(JSON.stringify({ error: { code: 4, type: "OAuthException" } })); return; }
    if (behavior === "unavailable") { response.writeHead(503).end(JSON.stringify({ error: { code: 2 } })); return; }
    if (behavior === "rejected") { response.writeHead(400).end(JSON.stringify({ error: { code: 100 } })); return; }
    const id = `local-provider-message-${received.length}`;
    response.writeHead(200).end(JSON.stringify({ messages: [{ id }], message_id: id, recipient_id: "fixture-recipient" }));
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const realFetch = globalThis.fetch;
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.origin, origin, "Offline tests must never contact a production or external provider");
    return realFetch(input, options);
  };
  return {
    origin, received, behaviors, fetcher,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export function blockExternalFetch(allowedOrigin: string) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.origin, allowedOrigin, "Offline suite blocked an attempted external request");
    return realFetch(input, options);
  };
  return () => { globalThis.fetch = realFetch; };
}
