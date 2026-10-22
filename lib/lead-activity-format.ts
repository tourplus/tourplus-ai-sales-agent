export type ActivityValue = string | number | boolean | null | ActivityValue[] | { [key: string]: ActivityValue };
export type ActivityChange = { before: ActivityValue; after: ActivityValue };
export type LeadActivityRecord = {
  id: string; lead_id: string; actor_id: string | null; actor_label: string;
  source: "staff" | "ai" | "system"; action: "created" | "updated" | "follow_up_completed";
  changes: Record<string, ActivityChange>; created_at: string;
};

const malaysiaDate = new Intl.DateTimeFormat("en-MY", {
  timeZone: "Asia/Kuala_Lumpur", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
});

export function activityDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? `${malaysiaDate.format(date)} MYT` : "Time unavailable";
}

export function activitySource(source: string): string {
  return source === "staff" ? "Staff" : source === "ai" ? "AI chat" : "System";
}

export function activityAction(action: string): string {
  return action === "created" ? "Lead created" : action === "follow_up_completed" ? "Follow-up completed" : "Lead updated";
}

const fieldNames: Record<string, string> = {
  assigned_staff_id: "Assigned staff ID", assigned_staff: "Assigned staff", status: "Status", notes: "Notes",
  human_takeover: "Conversation handling", next_follow_up_at: "Next follow-up", last_follow_up_at: "Last follow-up",
};

export function activityFields(changes: Record<string, ActivityChange> | null | undefined): [string, ActivityChange][] {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  return Object.entries(changes).filter(([field, change]) => Object.prototype.hasOwnProperty.call(fieldNames, field) && change && typeof change === "object" && "before" in change && "after" in change)
    // The staff label is more readable than a second entry containing its UUID.
    .filter(([field]) => field !== "assigned_staff_id" || !("assigned_staff" in changes));
}

export function activityFieldName(field: string): string { return fieldNames[field] || "Lead detail"; }

export function activityValue(field: string, value: ActivityValue): string {
  if (value === null || value === undefined || value === "") return field === "assigned_staff" || field === "assigned_staff_id" ? "Unassigned" : "Not set";
  if (field === "human_takeover" && typeof value === "boolean") return value ? "Human takeover" : "AI handling";
  if ((field === "next_follow_up_at" || field === "last_follow_up_at") && typeof value === "string") return activityDate(value);
  if (field === "status" && typeof value === "string") return value.replaceAll("_", " ");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
