export const FOLLOW_UP_TIMEZONE = "Asia/Kuala_Lumpur";
const malaysiaOffset = 8 * 60 * 60 * 1000;
export type FollowUpView = "all" | "overdue" | "today" | "upcoming" | "unscheduled";
export const followUpViews: FollowUpView[] = ["all", "overdue", "today", "upcoming", "unscheduled"];

export function malaysiaDayEnd(now = new Date()) {
  const local = new Date(now.getTime() + malaysiaOffset);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - malaysiaOffset);
}

export function followUpBucket(value: string | null | undefined, now = new Date()): Exclude<FollowUpView, "all"> {
  if (!value) return "unscheduled";
  const due = Date.parse(value);
  if (!Number.isFinite(due)) return "unscheduled";
  if (due < now.getTime()) return "overdue";
  return due < malaysiaDayEnd(now).getTime() ? "today" : "upcoming";
}

export function malaysiaDateInput(value: string | null | undefined) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time + malaysiaOffset).toISOString().slice(0, 16) : "";
}

export function malaysiaInputToUtc(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error("Choose a valid date and time");
  const time = Date.parse(`${value}:00+08:00`);
  if (!Number.isFinite(time) || malaysiaDateInput(new Date(time).toISOString()) !== value) throw new Error("Choose a valid date and time");
  return new Date(time).toISOString();
}

export function followUpTimestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("Use a date with an explicit timezone");
  const date = value.slice(0, 10), day = Date.parse(`${date}T00:00:00Z`), time = Date.parse(value);
  const parts = value.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/)!;
  if (+parts[1] > 23 || +parts[2] > 59 || +(parts[3] || 0) > 59 || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== date || !Number.isFinite(time)) throw new Error("Invalid follow-up date");
  return new Date(time).toISOString();
}

export function formatFollowUp(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not scheduled";
  return new Intl.DateTimeFormat("en-MY", { dateStyle: "medium", timeStyle: "short", timeZone: FOLLOW_UP_TIMEZONE }).format(new Date(value));
}

export function followUpFilter(view: FollowUpView, now = new Date()) {
  const instant = encodeURIComponent(now.toISOString()), end = encodeURIComponent(malaysiaDayEnd(now).toISOString());
  switch (view) {
    case "overdue": return `&next_follow_up_at=lt.${instant}`;
    case "today": return `&next_follow_up_at=gte.${instant}&next_follow_up_at=lt.${end}`;
    case "upcoming": return `&next_follow_up_at=gte.${end}`;
    case "unscheduled": return "&next_follow_up_at=is.null";
    default: return "";
  }
}
