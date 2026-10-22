"use client";

import { useEffect, useRef, useState } from "react";
import { StaffApiError, staffError, staffJson } from "../../lib/staff-fetch";
import { activityAction, activityDate, activityFieldName, activityFields, activitySource, activityValue, type LeadActivityRecord } from "../../lib/lead-activity-format";

type ActivityPage = { activities: LeadActivityRecord[]; nextCursor: string | null };
type Props = { leadId: string; refreshKey?: string | number };

export default function LeadActivity({ leadId, refreshKey }: Props) {
  const [activities, setActivities] = useState<LeadActivityRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const olderRequest = useRef<AbortController | null>(null);
  const olderInFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    olderRequest.current?.abort(); olderInFlight.current = false;
    setActivities([]); setNextCursor(null); setError(""); setLoading(true); setLoadingOlder(false);
    const url = "/api/leads/" + encodeURIComponent(leadId) + "/activities?limit=20";
    staffJson<ActivityPage>(url, { signal: controller.signal }).then(page => {
      if (!controller.signal.aborted) { setActivities(page.activities); setNextCursor(page.nextCursor); }
    }).catch(reason => {
      if (!controller.signal.aborted) setError(staffError(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); olderRequest.current?.abort(); };
  }, [leadId, refreshKey, retryKey]);

  async function loadOlder() {
    if (!nextCursor || olderInFlight.current) return;
    const controller = new AbortController();
    olderRequest.current = controller; olderInFlight.current = true;
    setLoadingOlder(true); setError("");
    try {
      const query = new URLSearchParams({ limit: "20", cursor: nextCursor });
      const page = await staffJson<ActivityPage>("/api/leads/" + encodeURIComponent(leadId) + "/activities?" + query, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setActivities(current => {
        const known = new Set(current.map(item => item.id));
        return [...current, ...page.activities.filter(item => !known.has(item.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (reason) {
      if (!controller.signal.aborted) {
        if (reason instanceof StaffApiError && [403, 404].includes(reason.status)) { setActivities([]); setNextCursor(null); }
        setError(staffError(reason));
      }
    } finally {
      if (!controller.signal.aborted) { olderInFlight.current = false; setLoadingOlder(false); }
    }
  }

  return <section className="crmcard lead-activity" aria-label="Lead activity history">
    <h2>Activity history</h2>
    <p className="activity-caption">Assignment, status, notes, takeover and follow-up changes. All times are Malaysia time.</p>
    {loading ? <p role="status">Loading activity…</p> : <>
      {error && <div className="activity-error" role="alert"><p>{error}</p><button type="button" disabled={loadingOlder} onClick={() => activities.length && nextCursor ? void loadOlder() : setRetryKey(key => key + 1)}>Try again</button></div>}
      {!error && activities.length === 0 && <p className="empty">No activity recorded yet. Future lead changes will appear here.</p>}
      {activities.length > 0 && <ol className="activity-timeline">{activities.map(activity => {
        const fields = activityFields(activity.changes);
        return <li className="activity-entry" key={activity.id}>
          <div className="activity-heading"><strong>{activityAction(activity.action)}</strong><time dateTime={activity.created_at}>{activityDate(activity.created_at)}</time></div>
          <p className="activity-actor">{activity.actor_label || activitySource(activity.source)} <span>· {activitySource(activity.source)}</span></p>
          {fields.length > 0 && <dl className="activity-changes">{fields.map(([field, change]) => <div className="activity-change" key={field}><dt>{activityFieldName(field)}</dt><dd><span className="activity-before"><span className="activity-value-label">Before: </span>{activityValue(field, change.before)}</span><span className="activity-after"><span className="activity-value-label">After: </span>{activityValue(field, change.after)}</span></dd></div>)}</dl>}
          {fields.length === 0 && <p>{activity.action === "created" ? "Lead record created." : activity.action === "follow_up_completed" ? "Follow-up marked complete." : "Lead details changed."}</p>}
        </li>;
      })}</ol>}
      {nextCursor && <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? "Loading older activity…" : "Load older activity"}</button>}
    </>}
  </section>;
}
