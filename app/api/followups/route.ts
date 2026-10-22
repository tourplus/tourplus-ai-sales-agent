import { errorResponse, privateJson, RequestError, requireStaff } from "../../../lib/staff-auth";
import { supabaseForUser } from "../../../lib/supabase";
import { followUpFilter, followUpViews, type FollowUpView } from "../../../lib/follow-ups";
import { databaseError } from "../leads/validation";

export const dynamic = "force-dynamic";
const selection = "id,customer_name,phone,source,service,status,assigned_staff,assigned_staff_id,next_follow_up_at,last_follow_up_at,updated_at";
const count = (response: Response) => {
  const total = Number(response.headers.get("content-range")?.split("/").at(-1));
  if (!Number.isFinite(total)) throw new RequestError(503, "Unable to count follow-ups");
  return total;
};

export async function GET(req: Request) {
  try {
    const staff = await requireStaff(), url = new URL(req.url);
    if ([...url.searchParams.keys()].some(key => !["view", "mine", "page"].includes(key))) throw new RequestError(400, "Invalid queue filter");
    const view = (url.searchParams.get("view") || "all") as FollowUpView;
    const pageText = url.searchParams.get("page") || "1", mine = url.searchParams.get("mine") || "false";
    if (!followUpViews.includes(view) || !/^\d{1,4}$/.test(pageText) || +pageText < 1 || +pageText > 1000 || !["true", "false"].includes(mine)) throw new RequestError(400, "Invalid queue filter");
    const owner = staff.role === "sales" || mine === "true" ? `&assigned_staff_id=eq.${staff.id}` : "";
    const base = `leads?status=not.in.(CONFIRMED,LOST)${owner}`, now = new Date();
    const request = (path: string) => supabaseForUser(staff.accessToken, path, { headers: { Prefer: "count=exact" } });
    const [rows, ...counts] = await Promise.all([
      request(`${base}&select=${selection}${followUpFilter(view, now)}&order=next_follow_up_at.asc.nullslast,created_at.asc,id.asc&limit=50&offset=${(+pageText - 1) * 50}`),
      ...followUpViews.filter(item => item !== "all").map(item => request(`${base}&select=id&limit=0${followUpFilter(item, now)}`))
    ]);
    for (const response of [rows, ...counts]) if (!response.ok) databaseError(response.status);
    const totals = Object.fromEntries(followUpViews.filter(item => item !== "all").map((item, index) => [item, count(counts[index])]));
    totals.all = Object.values(totals).reduce((sum, value) => sum + value, 0);
    return privateJson({ leads: await rows.json(), counts: totals, total: count(rows), page: +pageText, pageSize: 50, serverTime: now.toISOString(), timezone: "Asia/Kuala_Lumpur" });
  } catch (error) { return errorResponse(error); }
}
