import test from "node:test";
import assert from "node:assert/strict";
import { followUpBucket, followUpFilter, followUpTimestamp, malaysiaDateInput, malaysiaDayEnd, malaysiaInputToUtc } from "../lib/follow-ups";
test("Malaysia day boundaries do not depend on server/browser timezone", () => {
  const now = new Date("2026-10-22T16:15:00Z");
  assert.equal(malaysiaDayEnd(now).toISOString(), "2026-10-23T16:00:00.000Z");
  assert.equal(followUpBucket("2026-10-22T16:14:00Z", now), "overdue");
  assert.equal(followUpBucket("2026-10-23T15:59:59Z", now), "today");
  assert.equal(followUpBucket("2026-10-23T16:00:00Z", now), "upcoming");
  assert.equal(followUpBucket(null, now), "unscheduled");
});
test("local scheduling roundtrips across UTC midnight and leap dates", () => {
  assert.equal(malaysiaInputToUtc("2026-10-23T00:15"), "2026-10-22T16:15:00.000Z");
  assert.equal(malaysiaDateInput("2026-10-22T16:15:00Z"), "2026-10-23T00:15");
  assert.equal(malaysiaInputToUtc("2028-02-29T09:00"), "2028-02-29T01:00:00.000Z");
  for (const value of ["2027-02-29T09:00", "2026-10-23T24:00", "2026-10-23T00:61", "2026-10-23"]) assert.throws(() => malaysiaInputToUtc(value));
});
test("API dates require an explicit timezone and real calendar date", () => {
  assert.equal(followUpTimestamp("2026-10-23T09:00:00+08:00"), "2026-10-23T01:00:00.000Z");
  assert.equal(followUpTimestamp(null), null);
  for (const value of [undefined, 1, "2026-02-30T09:00:00Z", "2026-10-23T09:00", "2026-10-23T24:00:00Z", "infinity"]) assert.throws(() => followUpTimestamp(value));
  assert.match(followUpFilter("today", new Date("2026-10-22T16:15:00Z")), /2026-10-23T16/);
});
