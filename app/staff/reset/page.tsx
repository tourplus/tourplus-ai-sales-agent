"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
export default function ResetPassword() {
  const [accessToken, setAccessToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const initialized = useRef(false);
  const router = useRouter();
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const token = fragment.get("access_token");
    if (fragment.get("type") === "recovery" && token) setAccessToken(token);
    else setError("This password link is invalid or expired. Request a new link from the sign-in page.");
    setReady(true);
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (password.length < 12) { setError("Use at least 12 characters for your password."); return; }
    if (password !== confirmation) { setError("The passwords do not match."); return; }
    setSaving(true);
    try {
      const response = await fetch("/api/staff/reset", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: accessToken, password }) });
      if (!response.ok) { const body = await response.json().catch(() => null); setError(typeof body?.error === "string" ? body.error : "Password could not be updated. Request a new link and try again."); return; }
      setAccessToken(""); setPassword(""); setConfirmation(""); router.replace("/staff/login?reset=1"); router.refresh();
    } catch { setError("Connection failed. Please try again."); }
    finally { setSaving(false); }
  }
  return <main><section className="hero compact"><b>TOURPLUS · STAFF ONLY</b><h1>Set your password</h1><p>Choose a password with at least 12 characters.</p></section><form onSubmit={submit} className="crmcard" style={{ maxWidth: 440, margin: "32px auto" }}>{error && <p role="alert">{error}</p>}{ready && accessToken ? <><label>New password<input type="password" autoComplete="new-password" minLength={12} value={password} onChange={event => setPassword(event.target.value)} disabled={saving} required /></label><label>Confirm password<input type="password" autoComplete="new-password" minLength={12} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={saving} required /></label><button type="submit" disabled={saving}>{saving ? "Saving password…" : "Save password"}</button></> : !ready && <p role="status">Checking password link…</p>}<p><a href="/staff/login">Back to sign in</a></p></form></main>;
}
