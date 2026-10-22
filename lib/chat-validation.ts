export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function customerMessage(body: unknown): { text: string; leadId?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid request");
  const b = body as Record<string, unknown>;
  if (b.leadId !== undefined && (typeof b.leadId !== "string" || !uuid.test(b.leadId))) throw new Error("Invalid lead ID");
  let text = b.message;
  // Compatibility for older open demo tabs. Only the last customer message is accepted.
  if (text === undefined && Array.isArray(b.messages) && b.messages.length <= 50) {
    const last = b.messages.at(-1);
    if (last?.role === "customer") text = last.text;
  }
  if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new Error("Message must be 1–4000 characters");
  return { text: text.trim(), leadId: b.leadId as string | undefined };
}

export function extractedFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>, result: Record<string, unknown> = {};
  if (["coaster", "airport_transfer", "other"].includes(String(v.service))) result.service = v.service;
  if (typeof v.travel_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.travel_date) && Number.isFinite(Date.parse(v.travel_date)) && new Date(v.travel_date).toISOString().slice(0, 10) === v.travel_date) result.travel_date = v.travel_date;
  if (Number.isInteger(v.pax) && Number(v.pax) > 0 && Number(v.pax) <= 1000) result.pax = v.pax;
  if (typeof v.quoted_amount === "number" && Number.isFinite(v.quoted_amount) && v.quoted_amount >= 0 && v.quoted_amount < 10000000) result.quoted_amount = v.quoted_amount;
  for (const name of ["pickup", "destination", "itinerary", "ai_summary"]) {
    if (typeof v[name] === "string") {
      const text = v[name].replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 4000);
      if (text) result[name] = text;
    }
  }
  if (["NEW", "QUALIFYING", "QUOTED"].includes(String(v.status))) result.status = v.status;
  return result;
}

export class LeadExtractionError extends Error {
  constructor(public category: "incomplete" | "refusal" | "empty" | "invalid_json" | "invalid_fields", public finishReason?: string) {
    super("Lead extraction could not be completed");
  }
}

export function extractionFields(choice?: { finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }) {
  const reason = choice?.finish_reason;
  const safeReason = ["stop", "length", "content_filter", "tool_calls", "function_call"].includes(reason || "") ? reason! : "missing_or_unknown";
  if (reason !== "stop") throw new LeadExtractionError("incomplete", safeReason);
  if (choice?.message?.refusal) throw new LeadExtractionError("refusal", safeReason);
  const content = choice?.message?.content?.trim();
  if (!content) throw new LeadExtractionError("empty", safeReason);
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new LeadExtractionError("invalid_json", safeReason); }
  const fields = extractedFields(parsed);
  // A nominally successful provider response must yield useful CRM information.
  if (!fields.service || !fields.status || typeof fields.ai_summary !== "string" || !fields.ai_summary.trim()) throw new LeadExtractionError("invalid_fields", safeReason);
  return fields;
}
