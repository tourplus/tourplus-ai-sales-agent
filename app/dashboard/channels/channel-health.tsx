"use client";
import { useEffect, useState } from "react";
import CrmNav from "../../components/crm-nav";
import { staffError, staffJson } from "../../../lib/staff-fetch";

type Health = { mode: "disabled" | "sandbox" | "live"; verification: "configuration_only"; accounts: { channel: string; accountId: string; label: string; configured: boolean; canSend: boolean; aiMode: string; missing: string[]; templates: { name: string; language: string; parameterCount: number }[] }[] };
export default function ChannelHealth() {
  const [health, setHealth] = useState<Health | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  async function load() {
    setLoading(true); setError(""); setHealth(null);
    try { setHealth(await staffJson<Health>("/api/channels")); }
    catch (reason) { setError(staffError(reason)); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    const controller = new AbortController();
    staffJson<Health>("/api/channels", { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setHealth(result); }).catch(reason => { if (!controller.signal.aborted) setError(staffError(reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  return <main><section className="hero compact"><b>TOURPLUS · ADMIN</b><h1>Channel connections</h1><p>WhatsApp, Facebook and Instagram inbox readiness.</p></section><CrmNav role="admin" />
    <p className="channel-notice">This page checks saved configuration only. It does not verify provider access, webhook subscriptions, template approval, or message delivery.</p>
    <button type="button" disabled={loading} onClick={() => void load()}>Refresh configuration</button>
    {error && <p role="alert">{error}</p>}{loading ? <p role="status">Checking configuration…</p> : health && <>
      <p>Messaging mode: <strong>{health.mode === "disabled" ? "Disabled" : health.mode === "sandbox" ? "Local sandbox" : "Live pilot"}</strong></p>
      {health.mode === "disabled" && <p className="channel-notice">Not connected. Outbound messaging is disabled. Complete sandbox tests and verify each provider before enabling live sends.</p>}
      {!health.accounts.length ? <section className="crmcard"><h2>Not connected</h2><p>No channel accounts are configured. Your existing CRM and demo remain available.</p><p>An administrator must configure the business accounts, webhook verification, server credentials and approved pilot recipients before sending can be enabled.</p></section> : <div className="channel-health-grid">{health.accounts.map(account => <section key={`${account.channel}:${account.accountId}`} className="crmcard channel-health-card"><h2>{account.label}</h2><p className="channel-statusline"><span className="channel-badge">{account.channel}</span><strong>{account.configured ? "Configured" : "Not connected"}</strong></p><p>Sending: {account.canSend ? health.mode === "sandbox" ? "Local sandbox only" : "Enabled for pilot recipients" : "Disabled"}</p><p>AI: {account.aiMode === "auto" ? "Automatic" : account.aiMode === "draft" ? "Drafts for staff approval" : "Off"}</p>{account.missing.length > 0 && <><h3>Setup required</h3><ul>{account.missing.map(item => <li key={item}>{item}</li>)}</ul></>}{account.channel === "whatsapp" && <p>{account.templates.length} configured approved template{account.templates.length === 1 ? "" : "s"}. Provider approval must be checked separately.</p>}<p className="channel-notice">Configuration is not evidence of a verified connection or successful delivery.</p></section>)}</div>}
    </>}
  </main>;
}
