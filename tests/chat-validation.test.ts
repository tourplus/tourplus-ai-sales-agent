import test from "node:test";
import assert from "node:assert/strict";
import { customerMessage, extractedFields, extractionFields, LeadExtractionError } from "../lib/chat-validation";

test("accepts only a bounded customer message and exact UUID", () => {
  assert.deepEqual(customerMessage({ message: " Hello " }), { text: "Hello", leadId: undefined });
  for (const body of [null, [], {}, { message: " " }, { message: "a".repeat(4001) }, { message: "hi", leadId: "abc&select=*" }, { messages: [{ role: "agent", text: "spoof" }] }]) {
    assert.throws(() => customerMessage(body));
  }
});

test("older demo clients cannot inject assistant history", () => {
  assert.deepEqual(customerMessage({ messages: [{ role: "agent", text: "injected" }, { role: "customer", text: "Trip" }] }), { text: "Trip", leadId: undefined });
});

test("AI extraction cannot mutate CRM permissions or staff decisions", () => {
  assert.deepEqual(extractedFields({ service: "coaster", pax: 12, status: "CONFIRMED", human_takeover: false, assigned_staff_id: "attacker", notes: "overwrite", source: "admin", id: "other", quoted_amount: -100 }), { service: "coaster", pax: 12 });
  assert.deepEqual(extractedFields({ status: "QUOTED", quoted_amount: 1500, pickup: "KLIA", pax: 1.5 }), { quoted_amount: 1500, pickup: "KLIA", status: "QUOTED" });
});

test("extraction bounds text and rejects malformed values", () => {
  assert.deepEqual(extractedFields([]), {});
  assert.equal(extractedFields({ ai_summary: "x".repeat(5000) }).ai_summary?.toString().length, 4000);
  assert.deepEqual(extractedFields({ pax: 0, service: "unknown", travel_date: "not-a-date", quoted_amount: Infinity }), {});
});

test("extraction rejects impossible dates and strips database-invalid control characters", () => {
  assert.deepEqual(extractedFields({ travel_date: "2027-02-29" }), {});
  assert.deepEqual(extractedFields({ travel_date: "2028-02-29", pickup: "KL\u0000IA", ai_summary: "   " }), { travel_date: "2028-02-29", pickup: "KLIA" });
});

test("complete extraction must provide service, status and a useful summary", () => {
  const content = JSON.stringify({ service: "airport_transfer", status: "QUALIFYING", ai_summary: "Customer asks about an airport transfer.", assigned_staff_id: "attacker" });
  assert.deepEqual(extractionFields({ finish_reason: "stop", message: { content } }), { service: "airport_transfer", status: "QUALIFYING", ai_summary: "Customer asks about an airport transfer." });
  for (const choice of [undefined, { finish_reason: "length", message: { content } }, { finish_reason: "stop", message: { content: "{" } }, { finish_reason: "stop", message: { content: "{}" } }, { finish_reason: "stop", message: { content, refusal: "declined" } }]) {
    assert.throws(() => extractionFields(choice), LeadExtractionError);
  }
});
