import test from "node:test";
import assert from "node:assert/strict";
import { activityAction, activityDate, activityFieldName, activityFields, activitySource, activityValue } from "../lib/lead-activity-format";

test("activity dates use Malaysia time across the UTC day boundary", () => {
  const formatted = activityDate("2026-10-22T18:15:00Z");
  assert.match(formatted, /23 Oct 2026/);
  assert.match(formatted, /02:15/);
  assert.match(formatted, /MYT$/);
  assert.equal(activityDate("invalid"), "Time unavailable");
});

test("activity changes retain useful before and after values and hide redundant ownership IDs", () => {
  const notes = { before: null, after: "Call customer" };
  assert.deepEqual(activityFields({ assigned_staff_id: { before: null, after: "staff-uuid" }, assigned_staff: { before: null, after: "sales@example.com" }, notes }), [
    ["assigned_staff", { before: null, after: "sales@example.com" }], ["notes", notes],
  ]);
  assert.deepEqual(activityFields({ assigned_staff_id: { before: "one", after: "two" } }), [["assigned_staff_id", { before: "one", after: "two" }]]);
  assert.deepEqual(activityFields({ unexpected: notes, notes: {} as never }), []);
  assert.deepEqual(activityFields(null), []);
});

test("activity values distinguish false, null, text and follow-up dates", () => {
  assert.equal(activityValue("human_takeover", false), "AI handling");
  assert.equal(activityValue("human_takeover", true), "Human takeover");
  assert.equal(activityValue("assigned_staff", null), "Unassigned");
  assert.equal(activityValue("next_follow_up_at", null), "Not set");
  assert.match(activityValue("next_follow_up_at", "2026-10-22T18:15:00Z"), /23 Oct 2026/);
  assert.equal(activityValue("status", "FOLLOW_UP"), "FOLLOW UP");
  const text = "<script>alert('unsafe')</script>\nCustomer note";
  assert.equal(activityValue("notes", text), text);
});

test("activity labels describe recorded source and action", () => {
  assert.equal(activityAction("follow_up_completed"), "Follow-up completed");
  assert.equal(activityAction("created"), "Lead created");
  assert.equal(activitySource("ai"), "AI chat");
  assert.equal(activityFieldName("last_follow_up_at"), "Last follow-up");
});

test("channel activity shows safe event details without identifiers or payload fields", () => {
  const change = { before: null, after: { channel: "whatsapp", direction: "inbound", status: "delivered", messageId: "private-message-uuid", outboxId: "private-outbox-uuid", content: "private content" } };
  assert.deepEqual(activityFields({ channel_message: change }), [["channel_message", change]]);
  assert.equal(activityFieldName("channel_message"), "Channel message");
  assert.equal(activityValue("channel_message", change.after), "WhatsApp · Incoming message · Delivered");
  assert.equal(activityValue("channel_message", { outboxId: "private-outbox-uuid", status: "unknown" }), "Needs reconciliation");
  assert.equal(activityValue("channel_message", { channel: "private-uuid", status: "unexpected private data" }), "Channel message event");
  assert.equal(activityValue("channel_message", { channel: "constructor", status: "__proto__" }), "Channel message event");
  assert.equal(activityValue("channel_message", "private-uuid"), "Channel message event");
});
