"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { refreshStaffSession } from "../../../lib/staff-fetch";
export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const router = useRouter();
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams(window.location.search);
    if (query.get("refresh") !== "1") {
      setCheckingSession(false);
      if (query.get("expired") === "1") setNotice("Your session has expired. Please sign in again.");
      if (query.get("reset") === "1") setNotice("Password updated. Sign in with your new password.");
      return;
    }
    refreshStaffSession().then(refreshed => {
      if (!active) return;
      if (refreshed) { router.replace("/dashboard"); router.refresh(); }
      else setCheckingSession(false);
    });
    return () => { active = false; };
  }, [router]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setLoading(true); setError(""); setNotice("");
    try {
      const response = await fetch(recovery ? "/api/staff/recovery" : "/api/staff/login", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(recovery ? { email } : { email, password }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(typeof body?.error === "string" ? body.error : recovery ? "Unable to request a reset. Please try again." : "Sign in failed."); return;
      }
      setPassword("");
      if (recovery) setNotice("If this email belongs to an authorized staff account, a password setup or reset link will be sent. Check your inbox and spam folder.");
      else { router.replace("/dashboard"); router.refresh(); }
    } catch { setError("Connection failed. Please try again."); }
    finally { setLoading(false); }
  }
  return <main><section className="hero compact"><b>TOURPLUS · STAFF ONLY</b><h1>{recovery ? "Set or reset password" : "Sales CRM Login"}</h1><p>{recovery ? "Request a secure email link for your authorized staff account." : "Sign in with your authorized Supabase staff account."}</p></section>
    <form onSubmit={submit} className="crmcard" style={{ maxWidth: 440, margin: "32px auto" }}><label>Email<input type="email" autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} disabled={loading || checkingSession} required /></label>{!recovery && <label>Password<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={loading || checkingSession} required /></label>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}<button type="submit" disabled={loading || checkingSession}>{checkingSession ? "Checking session…" : loading ? recovery ? "Requesting link…" : "Signing in…" : recovery ? "Send password link" : "Sign in"}</button>{" "}<button type="button" disabled={loading || checkingSession} onClick={() => { setRecovery(!recovery); setPassword(""); setError(""); setNotice(""); }}>{recovery ? "Back to sign in" : "Set or reset password"}</button></form>
  </main>;
}
