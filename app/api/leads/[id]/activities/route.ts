import { errorResponse, isUuid, privateJson, RequestError, requireStaff } from "../../../../../lib/staff-auth";
import { supabaseForUser } from "../../../../../lib/supabase";
import { databaseError } from "../../validation";

type Context = { params: Promise<{ id: string }> };
type ActivityCursor = { created_at: string; id: string };
type ActivityRow = ActivityCursor & { lead_id: string; actor_id: string | null; actor_label: string; source: string; action: string; changes: Record<string, unknown> };
export const dynamic = "force-dynamic";

function readCursor(value: string | null): ActivityCursor | null {
  if (value === null) return null;
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new RequestError(400, "Invalid activity cursor");
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const stamp = decoded?.created_at;
    if (!isUuid(decoded?.id) || typeof stamp !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(stamp) || !Number.isFinite(Date.parse(stamp))) throw new Error("Invalid cursor");
    const datePart = stamp.slice(0, 10);
    if (new Date(datePart).toISOString().slice(0, 10) !== datePart) throw new Error("Invalid cursor date");
    return { created_at: stamp, id: decoded.id };
  } catch { throw new RequestError(400, "Invalid activity cursor"); }
}

export async function GET(req: Request, { params }: Context) {
  try {
    const staff = await requireStaff();
    const { id } = await params;
    if (!isUuid(id)) throw new RequestError(400, "Invalid lead ID");
    const search = new URL(req.url).searchParams;
    const rawLimit = search.get("limit") ?? "20";
    if (!/^\d{1,2}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50) throw new RequestError(400, "Activity limit must be between 1 and 50");
    const limit = Number(rawLimit);
    const cursor = readCursor(search.get("cursor"));

    // Check the parent with the same user JWT before querying its history.
    const leadQuery = new URLSearchParams({ id: `eq.${id}`, select: "id", limit: "1" });
    if (staff.role === "sales") leadQuery.set("assigned_staff_id", `eq.${staff.id}`);
    const leadResponse = await supabaseForUser(staff.accessToken, `leads?${leadQuery}`);
    if (!leadResponse.ok) databaseError(leadResponse.status);
    if (!(await leadResponse.json()).length) throw new RequestError(404, "Lead not found");

    const query = new URLSearchParams({
      lead_id: `eq.${id}`,
      select: "id,lead_id,actor_id,actor_label,source,action,changes,created_at",
      order: "created_at.desc,id.desc",
      limit: String(limit + 1),
    });
    if (cursor) query.set("or", `(created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id}))`);
    const response = await supabaseForUser(staff.accessToken, `lead_activities?${query}`);
    if (!response.ok) databaseError(response.status);
    const rows: ActivityRow[] = await response.json();
    const activities = rows.slice(0, limit);
    const last = activities[activities.length - 1];
    const nextCursor = rows.length > limit && last
      ? Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString("base64url")
      : null;
    return privateJson({ activities, nextCursor });
  } catch (error) { return errorResponse(error); }
}
