"use client";
import { useEffect, useState } from "react";
import { staffError, staffFetch, staffJson, type StaffSession } from "../../lib/staff-fetch";
import CrmNav from "../components/crm-nav";
type Lead = { id: string; customer_name?: string; source?: string; social_handle?: string; service: string; travel_date?: string; pax?: number; quoted_amount?: number; status: string; assigned_staff?: string; human_takeover: boolean; created_at: string };
const channelName = (source?: string) => ({ whatsapp: "WhatsApp", facebook: "Facebook", instagram: "Instagram", xiaohongshu: "小红书", website: "Website", web_demo: "Website Demo" }[source || ""] || source || "Unknown");
export default function Dashboard() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [user, setUser] = useState<StaffSession | null>(null);
  const [source, setSource] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      staffJson<Lead[]>("/api/leads", { signal: controller.signal }),
      staffJson<{ user: StaffSession }>("/api/staff/session", { signal: controller.signal }),
    ]).then(([items, session]) => {
      if (!controller.signal.aborted) { setLeads(items); setUser(session.user); }
    }).catch(reason => {
      if (!controller.signal.aborted) { setLeads([]); setError(staffError(reason)); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  async function logout() {
    setSigningOut(true); setError("");
    try { await staffFetch("/api/staff/logout", { method: "POST" }); window.location.replace("/staff/login"); }
    catch (reason) { setError(staffError(reason)); setSigningOut(false); }
  }
  const statuses = ["NEW", "QUALIFYING", "QUOTED", "FOLLOW_UP", "CONFIRMED", "LOST"];
  const shown = source === "all" ? leads : leads.filter(lead => lead.source === source);
  return <main>
    <section className="hero compact"><div><b>TOURPLUS</b><span>OMNICHANNEL SALES CRM · V1.4</span></div><h1>Lead Dashboard</h1><p>Facebook · Instagram · WhatsApp · 小红书 · Website</p>{user && <p>{user.email} · {user.role === "admin" ? "Admin" : "Sales"}{user.role === "sales" && " · Your assigned leads"}</p>}<button type="button" onClick={logout} disabled={signingOut}>{signingOut ? "Signing out…" : "Sign out"}</button></section>
    <CrmNav role={user?.role} />
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">Loading leads…</p> : !error && <>
      <div className="channels">{["all", "whatsapp", "facebook", "instagram", "xiaohongshu", "website", "web_demo"].map(channel => <button type="button" key={channel} className={source === channel ? "active" : ""} onClick={() => setSource(channel)}>{channel === "all" ? "All Channels" : channelName(channel)} <b>{channel === "all" ? leads.length : leads.filter(lead => lead.source === channel).length}</b></button>)}</div>
      <div className="metrics">{statuses.slice(0, 5).map(status => <div key={status}><small>{status}</small><strong>{shown.filter(lead => lead.status === status).length}</strong></div>)}</div>
      <section className="leadtable"><header><b>Recent Leads</b><span>{shown.length} shown</span></header>{shown.length === 0 ? <div className="empty">No leads in this channel yet.</div> : shown.map(lead => <a className="leadrow" href={"/dashboard/" + lead.id} key={lead.id}><div><b>{lead.customer_name || lead.social_handle || "New customer"}</b><small><span className={"source " + (lead.source || "")}>{channelName(lead.source)}</span> · {lead.service?.replaceAll("_", " ")} · {lead.pax ? lead.pax + " pax" : "pax pending"}</small></div><div>{lead.travel_date || "Date pending"}</div><div>{lead.quoted_amount ? "RM " + Number(lead.quoted_amount).toLocaleString() : "Not quoted"}</div><span>{lead.status}</span>{lead.human_takeover && <em>HUMAN</em>}</a>)}</section>
    </>}
  </main>;
}
