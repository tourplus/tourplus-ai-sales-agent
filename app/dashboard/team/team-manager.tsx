"use client";
import { useCallback, useEffect, useState } from "react";
import { staffError, staffJson } from "../../../lib/staff-fetch";
import CrmNav from "../../components/crm-nav";

type Member = { user_id: string; email?: string; role: "admin" | "sales"; active: boolean; display_name: string | null; invited_at: string | null; status: "pending" | "confirmed" };
type InvitationResult = { delivery: "submitted" | "link"; invitation_link?: string; message: string };

function MemberEditor({ member, self, busy, onSave, onInvite }: { member: Member; self: boolean; busy: boolean; onSave: (member: Member, change: object) => Promise<void>; onInvite: (member: Member, mode: "email" | "link") => Promise<void> }) {
  const [name, setName] = useState(member.display_name || "");
  const [role, setRole] = useState(member.role);
  return <article className="crmcard" style={{ marginTop: 16 }}>
    <h3>{member.display_name || member.email || "Staff member"}{self ? " (you)" : ""}</h3><p>{member.email || "Email unavailable"}</p>
    <p><strong>{member.active ? "Active" : "Inactive"}</strong> · {member.status === "confirmed" ? "Email confirmed" : "Invitation pending"}</p>
    <form onSubmit={event => { event.preventDefault(); void onSave(member, {
      ...(name.trim() !== (member.display_name || "") ? { display_name: name.trim() || null } : {}),
      ...(role !== member.role ? { role } : {}),
    }); }}>
      <label>Display name<input maxLength={200} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label>Role<select value={role} disabled={busy || self} onChange={event => setRole(event.target.value as Member["role"])}><option value="sales">Sales</option><option value="admin">Admin</option></select></label>
      <button type="submit" disabled={busy || (name.trim() === (member.display_name || "") && role === member.role)}>Save staff details</button>{" "}
      <button type="button" disabled={busy || self} onClick={() => void onSave(member, { active: !member.active })}>{member.active ? "Deactivate" : "Reactivate"}</button>
    </form>
    {self && <p>Your own Admin access cannot be deactivated or changed to Sales.</p>}
    {member.status === "pending" && member.active && <div style={{ marginTop: 16 }}><p>Resend this pending invitation with the saved role and name.</p><button type="button" disabled={busy} onClick={() => void onInvite(member, "link")}>Generate new invitation link</button>{" "}<button type="button" disabled={busy} onClick={() => void onInvite(member, "email")}>Resend invitation email</button></div>}
  </article>;
}

export default function TeamManager({ currentUserId }: { currentUserId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Member["role"]>("sales");
  const [mode, setMode] = useState<"link" | "email">("link");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [invitationLink, setInvitationLink] = useState("");
  const load = useCallback(async () => {
    const result = await staffJson<{ members: Member[] }>("/api/staff/members?include_inactive=true");
    setMembers(result.members);
  }, []);
  useEffect(() => {
    let active = true;
    staffJson<{ members: Member[] }>("/api/staff/members?include_inactive=true").then(result => { if (active) setMembers(result.members); }).catch(reason => { if (active) setError(staffError(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function save(member: Member, change: object) {
    setBusy(true); setError(""); setNotice(""); setInvitationLink("");
    try {
      await staffJson(`/api/staff/members/${member.user_id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(change) });
      await load(); setNotice("Staff access updated. Permission changes apply immediately.");
    } catch (reason) { setError(staffError(reason)); }
    finally { setBusy(false); }
  }

  async function invite(request: { email: string; role: Member["role"]; display_name: string | null; mode: "email" | "link"; resend: boolean }) {
    setBusy(true); setError(""); setNotice(""); setInvitationLink("");
    try {
      const result = await staffJson<InvitationResult>("/api/staff/invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      setNotice(result.message);
      if (result.delivery === "link" && result.invitation_link) setInvitationLink(result.invitation_link);
      if (!request.resend) { setEmail(""); setName(""); }
      await load();
    } catch (reason) {
      setError(staffError(reason));
      // A delivery failure can still leave a safely provisioned pending member.
      await load().catch(() => undefined);
    } finally { setBusy(false); }
  }

  return <main><a href="/dashboard">← Dashboard</a><section className="hero compact"><b>TOURPLUS · ADMIN</b><h1>Staff access</h1><p>Invite staff, set Admin or Sales permissions, and manage active access.</p></section><CrmNav role="admin" />
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {invitationLink && <section className="crmcard" aria-label="Private invitation link" style={{ margin: "24px 0" }}><h2>Private invitation link</h2><p>Share only with the invited staff member. This link grants access to their account. No email was sent.</p><label>Invitation link<textarea readOnly value={invitationLink} /></label><button type="button" onClick={() => { void navigator.clipboard.writeText(invitationLink).then(() => setNotice("Invitation link copied."), () => setError("Copy failed. Select and copy the link above.")); }}>Copy link</button>{" "}<button type="button" onClick={() => setInvitationLink("")}>Hide link</button></section>}
    <section className="crmcard" style={{ marginTop: 24 }}><h2>Invite staff</h2><form onSubmit={event => { event.preventDefault(); void invite({ email, role, display_name: name.trim() || null, mode, resend: false }); }}>
      <label>Staff email<input type="email" autoComplete="off" required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
      <label>Display name<input maxLength={200} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label>Role<select value={role} disabled={busy} onChange={event => setRole(event.target.value as Member["role"])}><option value="sales">Sales — assigned leads only</option><option value="admin">Admin — all leads and staff access</option></select></label>
      <label>Invitation method<select value={mode} disabled={busy} onChange={event => setMode(event.target.value as "link" | "email")}><option value="link">Generate a private link to share</option><option value="email">Send an invitation email</option></select></label>
      <p>{mode === "link" ? "A private setup link will appear here. Send it to the intended staff member through your own trusted channel." : "Email delivery depends on the configured email provider. An accepted request does not confirm inbox delivery."}</p>
      <button type="submit" disabled={busy || loading}>{busy ? "Working…" : mode === "link" ? "Create invitation link" : "Send invitation email"}</button>
    </form></section>
    <section style={{ marginTop: 32 }}><h2>Team members</h2>{loading ? <p role="status">Loading staff…</p> : members.length === 0 ? <p>No staff members found.</p> : members.map(member => <MemberEditor key={`${member.user_id}-${member.role}-${member.active}-${member.display_name}`} member={member} self={member.user_id === currentUserId} busy={busy} onSave={save} onInvite={(target, delivery) => invite({ email: target.email || "", role: target.role, display_name: target.display_name, mode: delivery, resend: true })} />)}</section>
  </main>;
}
