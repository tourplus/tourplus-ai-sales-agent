"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { staffError, staffFetch, staffJson, type StaffMember, type StaffSession } from "../../../lib/staff-fetch";
type LeadRecord = { id: string; customer_name?: string; service?: string; pax?: number; travel_date?: string; quoted_amount?: number; pickup?: string; destination?: string; ai_summary?: string; status: string; assigned_staff?: string | null; assigned_staff_id?: string | null; notes?: string | null; human_takeover: boolean };
type LeadData = { lead: LeadRecord; messages: { id: string; role: string; content: string }[] };
type LeadUpdate = Partial<Pick<LeadRecord, "status" | "assigned_staff" | "assigned_staff_id" | "notes" | "human_takeover">>;
export default function Lead() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<LeadData | null>(null);
  const [user, setUser] = useState<StaffSession | null>(null);
  const [members, setMembers] = useState<StaffMember[]>([]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setData(null); setError(""); setNotice("");
    async function load() {
      try {
        const [details, session] = await Promise.all([
          staffJson<LeadData>("/api/leads/" + encodeURIComponent(id), { signal: controller.signal }),
          staffJson<{ user: StaffSession }>("/api/staff/session", { signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        setData(details); setNotes(details.lead.notes || ""); setUser(session.user);
        if (session.user.role === "admin") {
          const result = await staffJson<{ members: StaffMember[] }>("/api/staff/members", { signal: controller.signal });
          if (!controller.signal.aborted) setMembers(result.members);
        }
      } catch (reason) { if (!controller.signal.aborted) setError(staffError(reason)); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load(); return () => controller.abort();
  }, [id]);
  async function save(update: LeadUpdate) {
    if (saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      await staffFetch("/api/leads/" + encodeURIComponent(id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update) });
      const updated = await staffJson<LeadData>("/api/leads/" + encodeURIComponent(id));
      setData(updated); if ("notes" in update) setNotes(updated.lead.notes || ""); setNotice("Changes saved.");
    } catch (reason) { setError(staffError(reason)); }
    finally { setSaving(false); }
  }
  if (loading) return <main><a href="/dashboard">← Dashboard</a><p role="status">Loading lead…</p></main>;
  if (!data?.lead) return <main><a href="/dashboard">← Dashboard</a><p role="alert">{error || "Lead unavailable."}</p></main>;
  const lead = data.lead;
  const assignedMember = members.find(member => member.user_id === lead.assigned_staff_id);
  return <main><a href="/dashboard">← Dashboard</a><section className="hero compact"><h1>{lead.customer_name || "New customer"}</h1><p>{lead.service?.replaceAll("_", " ")} · {lead.pax || "?"} pax · {lead.travel_date || "Date pending"}</p>{user && <p>{user.email} · {user.role === "admin" ? "Admin" : "Sales"}</p>}</section>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <section className="crmgrid"><div className="crmcard"><h2>Lead Details</h2><p><b>Quote</b><br />{lead.quoted_amount ? "RM " + Number(lead.quoted_amount).toLocaleString() : "Not quoted"}</p><p><b>Pickup</b><br />{lead.pickup || "Pending"}</p><p><b>Destination</b><br />{lead.destination || "Pending"}</p><p><b>AI Summary</b><br />{lead.ai_summary || "—"}</p>
      <label>Status<select value={lead.status} disabled={saving} onChange={event => void save({ status: event.target.value })}>{["NEW", "QUALIFYING", "QUOTED", "FOLLOW_UP", "CONFIRMED", "LOST"].map(status => <option key={status} value={status}>{status}</option>)}</select></label>
      {user?.role === "admin" ? <label>Assigned Staff<select value={lead.assigned_staff_id || ""} disabled={saving || members.length === 0} onChange={event => { const member = members.find(item => item.user_id === event.target.value); void save({ assigned_staff_id: event.target.value || null, assigned_staff: member?.email || member?.user_id || null }); }}><option value="">Unassigned</option>{lead.assigned_staff_id && !assignedMember && <option value={lead.assigned_staff_id}>{lead.assigned_staff || lead.assigned_staff_id} (current)</option>}{members.map(member => <option key={member.user_id} value={member.user_id}>{member.email || member.user_id} · {member.role === "admin" ? "Admin" : "Sales"}</option>)}</select></label> : <p><b>Assigned Staff</b><br />{lead.assigned_staff_id === user?.id ? "You" : lead.assigned_staff || "Unassigned"}</p>}
      <label>Notes<textarea value={notes} disabled={saving} onChange={event => setNotes(event.target.value)} maxLength={10000} /></label><button type="button" onClick={() => void save({ notes })} disabled={saving || notes === (lead.notes || "")}>Save notes</button>{" "}<button type="button" disabled={saving} onClick={() => void save({ human_takeover: !lead.human_takeover })}>{lead.human_takeover ? "Return to AI" : "Human Takeover"}</button>{saving && <small role="status"> Saving…</small>}
    </div><div className="crmcard"><h2>Conversation</h2>{data.messages?.length ? data.messages.map(message => <div className="transcript" key={message.id}><small>{message.role}</small><p>{message.content}</p></div>) : <p>No stored messages yet.</p>}</div></section>
  </main>;
}
