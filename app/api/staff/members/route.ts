import { errorResponse, privateJson, RequestError, requireStaff } from "../../../../lib/staff-auth";
import { supabase, supabaseConfig } from "../../../../lib/supabase";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const staff = await requireStaff();
    if (staff.role !== "admin") throw new RequestError(403, "Admin access required");
    const response = await supabase("staff_members?active=eq.true&select=user_id,role&order=created_at.asc&limit=100");
    if (!response.ok) throw new RequestError(503, "Unable to load staff members");
    const members: { user_id: string; role: string; email?: string }[] = await response.json();
    const { url } = supabaseConfig();
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) throw new RequestError(503, "Staff access is temporarily unavailable");
    // Resolve only the already authorized staff IDs, never expose auth user records.
    await Promise.all(members.map(async member => {
      const auth = await fetch(`${url}/auth/v1/admin/users/${member.user_id}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
      });
      if (auth.ok) {
        const user = await auth.json();
        if (typeof user?.email === "string") member.email = user.email;
      }
    }));
    return privateJson({ members });
  } catch (error) { return errorResponse(error); }
}
