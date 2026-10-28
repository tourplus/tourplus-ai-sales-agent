import test from "node:test";
import assert from "node:assert/strict";
import { CHANNEL_WORKER_ORIGIN, CHANNEL_WORKER_PATH, scheduleChannelWorkerKickoff, workerKickoffAllowed, workerKickoffBudget } from "../lib/channels/worker-kickoff";

const environment = { CHANNELS_MODE: "live", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "tourplus-ai-sales-agent.vercel.app" };
const configuration = { mode: "live" as const, workerSecret: "offline-worker-fixture-" + "x".repeat(32) };
const permitted = { method: "POST", status: 200, configuration };

test("worker kickoff requires successful durable POST and exact production binding", () => {
  assert.equal(workerKickoffAllowed(permitted, environment), true);
  for (const changed of [{ CHANNELS_MODE: "disabled" }, { CHANNELS_MODE: "sandbox" }, { VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { VERCEL_PROJECT_PRODUCTION_URL: "other-project.vercel.app" }, { VERCEL_PROJECT_PRODUCTION_URL: "tourplus-ai-sales-agent.vercel.app.evil.example" }]) {
    assert.equal(workerKickoffAllowed(permitted, { ...environment, ...changed }), false);
  }
  assert.equal(workerKickoffAllowed(permitted, {}), false);
  assert.equal(workerKickoffAllowed({ ...permitted, method: "GET" }, environment), false);
  for (const status of [400, 401, 403, 413, 415, 503]) assert.equal(workerKickoffAllowed({ ...permitted, status }, environment), false);
  for (const workerSecret of [undefined, "short", "x".repeat(32) + "\n"]) assert.equal(workerKickoffAllowed({ ...permitted, configuration: { mode: "live", workerSecret } }, environment), false);
  assert.equal(workerKickoffAllowed({ ...permitted, configuration: { ...configuration, mode: "sandbox" } }, environment), false);
});

test("kickoff is capped at ten seconds and stays inside the webhook's fifty-five-second budget", () => {
  assert.equal(workerKickoffBudget(0, 100), 10000);
  assert.equal(workerKickoffBudget(0, 50000), 5000);
  assert.equal(workerKickoffBudget(0, 54000), 1000);
  assert.equal(workerKickoffBudget(0, 54001), 0);
  assert.equal(workerKickoffBudget(0, 60000), 0);
  assert.equal(workerKickoffBudget(NaN, 0), 0);
  assert.equal(workerKickoffBudget(5000, 0), 0);
});

test("after callback posts only to the canonical existing worker with authorization and no query parameters", async () => {
  let callback: (() => Promise<void>) | undefined;
  let calls = 0;
  assert.equal(scheduleChannelWorkerKickoff({ ...permitted, requestStartedAt: 0, environment, now: () => 100,
    schedule: action => { callback = action; }, fetcher: async (url, init) => {
      calls++; assert.equal(url, CHANNEL_WORKER_ORIGIN + CHANNEL_WORKER_PATH); assert.equal(new URL(String(url)).search, "");
      assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.body, "{}");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer " + configuration.workerSecret);
      assert.ok(init?.signal); return Response.json({ ok: true });
    }, warn: () => assert.fail("Unexpected kickoff warning"),
  }), true);
  assert.equal(calls, 0); assert.ok(callback); await callback!(); assert.equal(calls, 1);
});

test("expired after callbacks, rejected persistence, and preview/local runtimes never contact production", async () => {
  let callback: (() => Promise<void>) | undefined; let now = 0; let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ ok: true }); };
  scheduleChannelWorkerKickoff({ ...permitted, requestStartedAt: 0, environment, now: () => now, fetcher, schedule: action => { callback = action; } });
  now = 55000; await callback!(); assert.equal(calls, 0);
  for (const env of [{}, { ...environment, VERCEL_ENV: "preview" }, { ...environment, CHANNELS_MODE: "sandbox" }]) {
    assert.equal(scheduleChannelWorkerKickoff({ ...permitted, requestStartedAt: 0, environment: env, now: () => 0, fetcher, schedule: () => assert.fail("Must not schedule") }), false);
  }
  assert.equal(scheduleChannelWorkerKickoff({ ...permitted, status: 503, requestStartedAt: 0, environment, now: () => 0, fetcher, schedule: () => assert.fail("Must not schedule") }), false);
  assert.equal(calls, 0);
});

test("kickoff errors are sanitized and do not turn a committed webhook into an error or resend", async () => {
  for (const result of ["network", "http"] as const) {
    let callback: (() => Promise<void>) | undefined; let warnings = 0; let calls = 0;
    assert.equal(scheduleChannelWorkerKickoff({ ...permitted, requestStartedAt: 0, environment, now: () => 0,
      schedule: action => { callback = action; }, warn: () => { warnings++; },
      fetcher: async () => { calls++; if (result === "network") throw new Error("private provider detail"); return Response.json({ secret: "must-not-be-read" }, { status: 503 }); },
    }), true);
    await assert.doesNotReject(callback!()); assert.equal(warnings, 1); assert.equal(calls, 1);
  }
  let warnings = 0;
  assert.equal(scheduleChannelWorkerKickoff({ ...permitted, requestStartedAt: 0, environment, now: () => 0, schedule: () => { throw new Error("after context unavailable"); }, warn: () => { warnings++; } }), false);
  assert.equal(warnings, 1);
});
