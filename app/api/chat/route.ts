import OpenAI from "openai";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { system } from "../../../lib/chat-prompt";
import { customerMessage, extractedFields } from "../../../lib/chat-validation";
import { CHAT_COOKIE, consumeLimit, hashToken, jsonRows, newToken, requestKey } from "../../../lib/public-chat";

export const maxDuration = 60;
const respond = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function POST(req: Request) {
  if (req.headers.get("origin") !== new URL(req.url).origin) return respond({ error: "Forbidden" }, 403);
  if (!req.headers.get("content-type")?.includes("application/json")) return respond({ error: "JSON required" }, 415);
  let input: ReturnType<typeof customerMessage>;
  let issuedToken: string | undefined;
  try {
    const raw = await req.text();
    if (raw.length > 20000) return respond({ error: "Request too large" }, 413);
    input = customerMessage(JSON.parse(raw));
  } catch { return respond({ error: "Invalid message or lead ID" }, 400); }
  try {
    const token = (await cookies()).get(CHAT_COOKIE)?.value;
    const sessionHash = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? hashToken(token) : undefined;
    const sessions = sessionHash ? await jsonRows(`chat_sessions?token_hash=eq.${sessionHash}&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=lead_id`) : [];
    let leadId: string | undefined = sessions[0]?.lead_id;
    // Lead IDs are never credentials. Check ownership before AI calls or writes.
    if (input.leadId && input.leadId !== leadId) return respond({ error: "Conversation not found" }, 403);
    if (!(await consumeLimit(requestKey(req, "chat-ip"), 30, 600))) return respond({ error: "Please try again later" }, 429);
    if (sessionHash && !(await consumeLimit("chat-session:" + sessionHash, 20, 600))) return respond({ error: "Please try again later" }, 429);
    if (!(await consumeLimit("chat-global", 500, 86400))) return respond({ error: "Our team will assist you. Please try again later." }, 429);
    if (!leadId) {
      issuedToken = newToken();
      const leads = await jsonRows("leads", { method: "POST", body: JSON.stringify({ source: "web_demo", status: "NEW" }) });
      leadId = leads[0].id;
      await jsonRows("chat_sessions", { method: "POST", body: JSON.stringify({ token_hash: hashToken(issuedToken), lead_id: leadId, expires_at: new Date(Date.now() + 86400000).toISOString() }) });
    }
    const lead = (await jsonRows(`leads?id=eq.${leadId}&select=human_takeover,status,updated_at`))[0];
    if (!lead) return respond({ error: "Conversation unavailable" }, 404);
    await jsonRows("messages", { method: "POST", body: JSON.stringify({ lead_id: leadId, role: "customer", content: input.text }) });
    let reply = "Our reservation team will assist you shortly.";
    if (!lead.human_takeover && process.env.OPENAI_API_KEY) {
      const history: { role: string; content: string }[] = await jsonRows(`messages?lead_id=eq.${leadId}&select=role,content&order=created_at.desc&limit=30`);
      const transcript = history.reverse().map(m => ({ role: m.role === "customer" ? "user" as const : "assistant" as const, content: m.content.slice(0, 4000) }));
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 22000, maxRetries: 0 });
      const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
      const result = await client.chat.completions.create({ model, max_completion_tokens: 800, messages: [{ role: "system", content: system }, ...transcript] });
      reply = result.choices[0]?.message?.content?.slice(0, 6000) || reply;
      try {
        const extraction = await client.chat.completions.create({ model, max_completion_tokens: 600, response_format: { type: "json_object" }, messages: [
          { role: "system", content: `Extract only service (coaster/airport_transfer/other), travel_date YYYY-MM-DD, pax, pickup, destination, itinerary, quoted_amount, status (NEW/QUALIFYING/QUOTED), ai_summary. Today is ${new Date().toISOString().slice(0, 10)}. Use null for unknowns. QUOTED only when an approved actual price was quoted. Never invent missing facts.` },
          { role: "user", content: JSON.stringify({ transcript, reply }) }
        ] });
        const fields = extractedFields(JSON.parse(extraction.choices[0]?.message?.content || "{}"));
        // Optimistic condition preserves concurrent staff edits and human takeover.
        if (["NEW", "QUALIFYING", "QUOTED"].includes(lead.status)) await jsonRows(`leads?id=eq.${leadId}&human_takeover=eq.false&updated_at=eq.${encodeURIComponent(lead.updated_at)}`, { method: "PATCH", body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }) });
      } catch { console.error("Lead extraction unavailable"); }
      const current = (await jsonRows(`leads?id=eq.${leadId}&select=human_takeover`))[0];
      if (current?.human_takeover) reply = "Our reservation team will assist you shortly.";
    }
    await jsonRows("messages", { method: "POST", body: JSON.stringify({ lead_id: leadId, role: "agent", content: reply }) });
    const response = respond({ reply, leadId });
    if (issuedToken) response.cookies.set(CHAT_COOKIE, issuedToken, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 86400 });
    return response;
  } catch {
    console.error("Public chat request failed");
    const response = respond({ error: "Chat is temporarily unavailable. Please try again.", reply: "Our reservation team can assist you. Please try again shortly." }, 503);
    if (issuedToken) response.cookies.set(CHAT_COOKIE, issuedToken, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: 86400 });
    return response;
  }
}
