import { errorResponse, privateJson, RequestError } from "../../../../lib/staff-auth";
import { authIdentity, publicMember, requireAdmin, staffColumns, type StaffRow } from "../../../../lib/staff-management";
import { supabase } from "../../../../lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireAdmin();
    const query = new URL(req.url).searchParams;
    if ([...query.keys()].some(key => key !== "include_inactive") || (query.has("include_inactive") && !["true", "false"].includes(query.get("include_inactive") || ""))) throw new RequestError(400, "Invalid staff filter");
    const filter = query.get("include_inactive") === "true" ? "" : "active=eq.true&";
    const response = await supabase(`staff_members?${filter}select=${staffColumns}&order=created_at.asc&limit=500`);
    if (!response.ok) throw new RequestError(503, "Unable to load staff members");
    const rows: StaffRow[] = await response.json();
    const members = [];
    // Bound concurrent Auth requests while preserving complete account status.
    for (let offset = 0; offset < rows.length; offset += 10) {
      const batch = await Promise.all(rows.slice(offset, offset + 10).map(async row => publicMember(row, await authIdentity(row.user_id))));
      members.push(...batch);
    }
    return privateJson({ members });
  } catch (error) { return errorResponse(error); }
}
