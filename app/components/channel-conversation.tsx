"use client";
import { useEffect, useRef, useState } from "react";
import { staffError, staffJson } from "../../lib/staff-fetch";
import { validChannelText } from "../../lib/channels/policy";
import type { Channel } from "../../lib/channels/types";

type Template = { name: string; language: string; parameterCount: number };
type Conversation = { id: string; channel: Channel; label: string; aiMode: string; windowOpen: boolean; closed: boolean; canOpenEnquiry: boolean; canSend: boolean; templates: Template[] };
type ChannelMessage = { id: string; conversationId: string; role: string; content: string; createdAt: string; deliveryStatus: string | null; mediaCount: number };
type PendingMessage = { id: string; conversationId: string; text: string; status: string; createdAt: string; kind: string; templateName?: string | null };
type Thread = { mode: "disabled" | "sandbox" | "live"; conversations: Conversation[]; messages: ChannelMessage[]; outbox: PendingMessage[] };
const statusLabel: Record<string, string> = { draft: "Awaiting approval", queued: "Queued", leased: "Preparing", sending: "Sending", sent: "Sent to provider", delivered: "Delivered", read: "Read", retry: "Retry scheduled", failed: "Failed", unknown: "Needs reconciliation", cancelled: "Cancelled" };
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat("en-MY", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kuala_Lumpur" }).format(new Date(value)) : "";

export default function ChannelConversation({ leadId, humanTakeover = false, onChanged }: { leadId: string; humanTakeover?: boolean; onChanged?: () => Promise<void> }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [selected, setSelected] = useState("");
  const [text, setText] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const [parameters, setParameters] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(""); setThread(null); setText(""); setTemplateKey(""); setParameters([]); attempt.current = null;
    staffJson<Thread>(`/api/leads/${leadId}/channel`, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) { setThread(data); setSelected(data.conversations[0]?.id || ""); } }).catch(reason => { if (!controller.signal.aborted) setError(staffError(reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [leadId]);
  const conversation = thread?.conversations.find(item => item.id === selected);
  const template = conversation?.templates.find(item => `${item.name}:${item.language}` === templateKey);
  const messages = thread?.messages.filter(item => item.conversationId === selected) || [];
  const outbox = thread?.outbox.filter(item => item.conversationId === selected) || [];
  const unresolved = outbox.some(item => item.status === "unknown");
  async function reload() {
    setError("");
    try { const data = await staffJson<Thread>(`/api/leads/${leadId}/channel`); setThread(data); setSelected(current => data.conversations.some(item => item.id === current) ? current : data.conversations[0]?.id || ""); }
    catch (reason) { setError(staffError(reason)); }
  }
  async function mutate(body: object, key: string) {
    setBusy(key); setError(""); setNotice("");
    try {
      const result = await staffJson<{ leadId?: string }>(`/api/leads/${leadId}/channel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setNotice(key === "send" ? "Reply queued. Delivery is confirmed only when its status updates." : key === "new" ? "New enquiry opened." : "Draft approved and queued.");
      if (key === "send") { setText(""); setParameters([]); setTemplateKey(""); attempt.current = null; }
      if (key === "new" && result.leadId && result.leadId !== leadId) { window.location.assign(`/dashboard/${result.leadId}`); return; }
      await reload();
      void onChanged?.();
    } catch (reason) { setError(staffError(reason)); }
    finally { setBusy(""); }
  }
  function send(event: React.FormEvent) {
    event.preventDefault(); if (!conversation) return;
    const payload = { action: "reply", conversationId: conversation.id, ...(template ? { template: { name: template.name, language: template.language, parameters } } : { text }) };
    const signature = JSON.stringify(payload);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
    void mutate({ ...payload, idempotencyKey: attempt.current.key }, "send");
  }
  return <section className="crmcard channel-inbox"><header className="channel-heading"><div><h2>Channel conversation</h2><p>WhatsApp · Facebook · Instagram</p></div><button type="button" disabled={loading || !!busy} onClick={() => void reload()}>Refresh delivery status</button></header>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Loading channel conversation…</p> : !thread ? <p>Channel conversation is unavailable. Refresh to try again.</p> : !thread.conversations.length ? <p>{thread.mode === "disabled" ? "Not connected. Channel messaging is disabled until an Admin completes setup and testing." : "No connected channel conversation for this lead."}</p> : <>
      <label>Conversation<select value={selected} disabled={!!busy} onChange={event => { setSelected(event.target.value); setText(""); setTemplateKey(""); setParameters([]); setNotice(""); attempt.current = null; }}>{thread.conversations.map(item => <option key={item.id} value={item.id}>{item.label} · {item.channel}</option>)}</select></label>
      {conversation && <><p className="channel-statusline"><span className="channel-badge">{conversation.channel}</span><span>AI: {humanTakeover ? "Paused for staff" : conversation.aiMode === "auto" ? "Automatic" : conversation.aiMode === "draft" ? "Drafts for approval" : "Off"}</span>{thread.mode === "sandbox" && <strong>Sandbox</strong>}{!conversation.canSend && <strong>Not connected for sending</strong>}</p>
        {!conversation.windowOpen && <p className="channel-notice">The customer reply window has expired. {conversation.channel === "whatsapp" ? "Use a configured, approved WhatsApp template or wait for a new customer message." : "Wait for a new customer message before replying."}</p>}
        {unresolved && <p className="channel-notice" role="status">A previous send has an unknown outcome. Check the provider inbox and reconcile it before sending again. Automatic retries and the reply composer are paused here.</p>}
        <div className="channel-history" aria-label="Stored channel messages">{messages.length ? messages.map(message => <article className={`channel-message ${message.role === "customer" ? "inbound" : "outbound"}`} key={message.id}><small>{message.role === "customer" ? "Customer" : "Staff / agent"} · {date(message.createdAt)}{message.deliveryStatus ? ` · ${statusLabel[message.deliveryStatus] || message.deliveryStatus}` : ""}</small><p>{message.content || (message.mediaCount ? "Media message" : "Message")}</p>{message.mediaCount > 0 && <small>{message.mediaCount} media attachment{message.mediaCount === 1 ? "" : "s"}. Open the provider inbox to view it.</small>}</article>) : <p>No stored channel messages yet.</p>}</div>
        {outbox.length > 0 && <div className="channel-outbox"><h3>Outgoing queue and drafts</h3>{outbox.map(item => <article key={item.id} className="channel-queue-item"><div><strong>{statusLabel[item.status] || item.status}</strong><small>{date(item.createdAt)}</small><p>{item.text || (item.templateName ? `Template: ${item.templateName}` : "Approved template")}</p></div>{item.status === "draft" && <button type="button" disabled={!!busy || !conversation.canSend || !conversation.windowOpen || conversation.closed || unresolved} onClick={() => void mutate({ action: "approve_draft", outboxId: item.id }, item.id)}>Approve draft</button>}{item.status === "retry" && <small>A retry is scheduled automatically.</small>}{item.status === "unknown" && <small>Reconciliation required. Do not resend.</small>}</article>)}</div>}
        {conversation.closed ? <div className="channel-notice"><p>{conversation.canOpenEnquiry ? "This enquiry is closed. Open a new enquiry to resume this conversation." : "This conversation is closed. Its stored messages remain available here."}</p>{conversation.canOpenEnquiry && <button type="button" disabled={!!busy || !conversation.canSend} onClick={() => void mutate({ action: "new_enquiry", conversationId: conversation.id }, "new")}>Open new enquiry</button>}</div> : <form className="channel-composer" onSubmit={send}>
          {conversation.channel === "whatsapp" && conversation.templates.length > 0 && <label>Reply type<select value={templateKey} disabled={!!busy || !conversation.canSend || unresolved} onChange={event => { setTemplateKey(event.target.value); setParameters([]); }}><option value="">Text reply{!conversation.windowOpen ? " — window expired" : ""}</option>{conversation.templates.map(item => <option key={`${item.name}:${item.language}`} value={`${item.name}:${item.language}`}>{item.name} · {item.language}</option>)}</select></label>}
          {template ? Array.from({ length: template.parameterCount }, (_, index) => <label key={index}>Template value {index + 1}<input required maxLength={1000} value={parameters[index] || ""} disabled={!!busy || !conversation.canSend || unresolved} onChange={event => setParameters(values => Array.from({ length: template.parameterCount }, (_value, position) => position === index ? event.target.value : values[position] || ""))} /></label>) : <label>Reply<textarea value={text} required maxLength={4000} disabled={!!busy || !conversation.canSend || !conversation.windowOpen || unresolved} onChange={event => setText(event.target.value)} placeholder="Reply to this customer" /></label>}
          {!template && text.trim() && !validChannelText(conversation.channel, text) && <p role="alert">This reply is too long or contains unsupported characters for this channel. Shorten or edit it before queuing.</p>}
          <p>Replying switches this lead to human takeover and cancels queued AI replies. Times are shown in Malaysia time.</p><button type="submit" disabled={!!busy || !conversation.canSend || unresolved || (!template && (!conversation.windowOpen || !validChannelText(conversation.channel, text)))}>{busy === "send" ? "Queuing…" : "Queue reply"}</button>
        </form>}
      </>}
    </>}
  </section>;
}
