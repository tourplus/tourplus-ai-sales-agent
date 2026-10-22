import test from "node:test";
import assert from "node:assert/strict";
const verifier = import("../scripts/verify-v14-production.mjs");

test("V1.4 verifier only accepts the selected project and safe verification origins", async () => {
  const { validateTarget } = await verifier;
  const db = "https://oetnbcxbfvlancnmespu.supabase.co";
  for (const base of ["https://tourplus-ai-sales-agent.vercel.app", "https://tourplus-ai-sales-agent-abcdef-tourplusdev.vercel.app", "http://localhost:3000"]) assert.doesNotThrow(() => validateTarget(base, db));
  for (const base of ["https://evil.example", "https://tourplus-ai-sales-agent.vercel.app.evil.example", "https://user:pass@tourplus-ai-sales-agent.vercel.app", "https://tourplus-ai-sales-agent.vercel.app/path", "http://tourplus-ai-sales-agent.vercel.app"]) assert.throws(() => validateTarget(base, db));
  assert.throws(() => validateTarget("https://tourplus-ai-sales-agent.vercel.app", "https://another.supabase.co"));
});

test("V1.4 verifier creates only bounded disposable example.invalid addresses", async () => {
  const { fixtureEmail } = await verifier;
  assert.match(fixtureEmail("a".repeat(24), "invited"), /^v14-[a-f0-9]{24}-invited@example\.invalid$/);
  assert.throws(() => fixtureEmail("a".repeat(24), "person@real.example"));
  assert.throws(() => fixtureEmail("unsafe", "admin"));
});

test("V1.4 verifier classifies exact Malaysia midnight and overdue boundaries", async () => {
  const { followupBucket, malaysiaDayEnd } = await verifier;
  const now = "2026-10-23T15:30:00Z";
  assert.equal(new Date(malaysiaDayEnd(now)).toISOString(), "2026-10-23T16:00:00.000Z");
  assert.equal(followupBucket("2026-10-23T15:29:59Z", now), "overdue");
  assert.equal(followupBucket(now, now), "today");
  assert.equal(followupBucket("2026-10-23T15:59:59Z", now), "today");
  assert.equal(followupBucket("2026-10-23T16:00:00Z", now), "upcoming");
  assert.equal(followupBucket(null, now), "unscheduled");
});

test("original record digests ignore JSON key order but detect changed data", async () => {
  const { rowDigest } = await verifier;
  assert.equal(rowDigest({ a: 1, nested: { b: true, a: null } }), rowDigest({ nested: { a: null, b: true }, a: 1 }));
  assert.notEqual(rowDigest({ role: "admin", active: true }), rowDigest({ role: "admin", active: false }));
});
