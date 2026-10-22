"use client";
import { useState } from "react";
type Msg = { role: "customer" | "agent"; text: string };
export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([{ role: "agent", text: "Hi! Welcome to Tourplus 👋 Are you looking for an airport transfer or luxury coaster charter?" }]);
  const [input, setInput] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function send() {
    if (!input.trim() || busy) return;
    const text = input.trim(); setBusy(true); setError(""); setInput("");
    setMessages(m => [...m, { role: "customer", text }]);
    try {
      const r = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Unable to send message");
      setMessages(m => [...m, { role: "agent", text: data.reply }]);
    } catch (e) { setError(e instanceof Error ? e.message : "Connection failed. Please try again."); }
    finally { setBusy(false); }
  }
  return <main><section className="hero"><div><b>TOURPLUS</b><span>AI SALES AGENT · V1.3</span></div><h1>Sales enquiries,<br />qualified automatically.</h1><p>Demo · Airport Transfer + Luxury Coaster</p><a href="/staff/login">Staff sign in</a></section><section className="grid"><div className="chat"><header>Customer Conversation <i>{busy ? "Thinking…" : "● AI online"}</i></header><div className="messages" aria-live="polite">{messages.map((m, i) => <div key={i} className={m.role}><small>{m.role === "agent" ? "Tourplus AI" : "Customer"}</small>{m.text}</div>)}</div>{error && <p role="alert" style={{ padding: "0 16px" }}>{error}</p>}<footer><input aria-label="Message" maxLength={4000} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Try: I need a coaster for 12 pax in KL" /><button disabled={busy} onClick={send}>Send</button></footer></div><aside><h2>V1 Pipeline</h2>{[["NEW", "Intent classification"], ["QUALIFY", "Collect trip details"], ["QUOTE", "Approved pricing only"], ["HANDOVER", "Human takeover when needed"]].map(x => <div className="stat" key={x[0]}><strong>{x[0]}</strong><span>{x[1]}</span></div>)}<p className="note">AI never invents prices. Special itineraries, availability and negotiations are escalated.</p></aside></section></main>;
}
