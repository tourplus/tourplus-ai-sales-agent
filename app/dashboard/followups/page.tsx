"use client";
import { useEffect, useState } from "react";
import CrmNav from "../../components/crm-nav";
import { followUpBucket, followUpViews, formatFollowUp, type FollowUpView } from "../../../lib/follow-ups";
import { staffError, staffJson, type StaffSession } from "../../../lib/staff-fetch";
type QueueLead = { id: string; customer_name?: string; phone?: string; service: string; status: string; assigned_staff?: string; next_follow_up_at: string | null; last_follow_up_at: string | null; updated_at: string };
type Queue = { leads: QueueLead[]; counts: Record<FollowUpView, number>; total: number; page: number; pageSize: number; serverTime: string };
const labels: Record<FollowUpView, string> = { all: "All open leads", overdue: "Overdue", today: "Due today", upcoming: "Upcoming", unscheduled: "Needs a date" };
export default function FollowUps() {
  const [user, setUser] = useState<StaffSession | null>(null), [queue, setQueue] = useState<Queue | null>(null);
  const [view, setView] = useState<FollowUpView>("all"), [mine, setMine] = useState(false), [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    Promise.all([
      staffJson<Queue>(`/api/followups?view=${view}&mine=${mine}&page=${page}`, { signal: controller.signal }),
      staffJson<{ user: StaffSession }>("/api/staff/session", { signal: controller.signal })
    ]).then(([data, session]) => { if (!controller.signal.aborted) { setQueue(data); setUser(session.user); } })
      .catch(reason => { if (!controller.signal.aborted) setError(staffError(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [view, mine, page, revision]);
  async function complete(lead: QueueLead) {
    if (busy) return; setBusy(lead.id); setError(""); setNotice("");
    try {
      await staffJson(`/api/leads/${lead.id}/follow-up`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "complete", expected_updated_at: lead.updated_at }) });
      setNotice("Follow-up completed. Open the lead to schedule the next contact."); setRevision(value => value + 1);
    } catch (reason) { setError(staffError(reason)); }
    finally { setBusy(""); }
  }
  return <main><section className="hero compact"><b>TOURPLUS · SALES WORKFLOW</b><h1>Follow-up queue</h1><p>Prioritize overdue enquiries and plan your next customer contact.</p></section><CrmNav role={user?.role} />
    <p className="timezone-note">All dates and times use Malaysia time (MYT, UTC+8). Confirmed and lost leads are excluded.</p>
    {user?.role === "admin" && <label className="inline-check"><input type="checkbox" checked={mine} onChange={event => { setMine(event.target.checked); setPage(1); }} /> Only leads assigned to me</label>}
    <div className="channels queue-tabs" aria-label="Follow-up filters">{followUpViews.map(item => <button type="button" key={item} className={view === item ? "active" : ""} aria-pressed={view === item} onClick={() => { setView(item); setPage(1); }}>{labels[item]} {queue && <b>{queue.counts[item]}</b>}</button>)}</div>
    {error && <p role="alert">{error} <button type="button" onClick={() => setRevision(value => value + 1)}>Reload queue</button></p>}{notice && <p role="status">{notice}</p>}
    {loading ? <p role="status">Loading follow-ups…</p> : queue && <section className="leadtable queue-table"><header><b>{labels[view]}</b><span>{queue.total} leads</span></header>
      {!queue.leads.length ? <div className="empty">{view === "overdue" ? "No overdue follow-ups." : "No leads in this queue."}</div> : queue.leads.map(lead => {
        const bucket = followUpBucket(lead.next_follow_up_at, new Date(queue.serverTime));
        return <article className="queue-row" key={lead.id}><div><a className="queue-title" href={`/dashboard/${lead.id}`}>{lead.customer_name || "New customer"}</a><small>{lead.service?.replaceAll("_", " ")} · {lead.status} · {lead.assigned_staff || "Unassigned"}</small>{lead.phone && <small>{lead.phone}</small>}</div><div><span className={`due-badge ${bucket}`}>{labels[bucket]}</span><p>{formatFollowUp(lead.next_follow_up_at)}</p>{lead.last_follow_up_at && <small>Last contact: {formatFollowUp(lead.last_follow_up_at)}</small>}</div><div className="queue-actions"><a href={`/dashboard/${lead.id}`}>Open / reschedule</a>{lead.next_follow_up_at && <button type="button" disabled={!!busy} onClick={() => void complete(lead)}>{busy === lead.id ? "Saving…" : "Mark done"}</button>}</div></article>;
      })}
      <footer className="pagination"><button type="button" disabled={page <= 1 || !!busy} onClick={() => setPage(value => value - 1)}>Previous</button><span>Page {page} of {Math.max(1, Math.ceil(queue.total / queue.pageSize))}</span><button type="button" disabled={page * queue.pageSize >= queue.total || !!busy} onClick={() => setPage(value => value + 1)}>Next</button></footer>
    </section>}
  </main>;
}
