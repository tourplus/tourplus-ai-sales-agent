import { cookies } from "next/headers";
import { consumeLimit, requestKey } from "../../../../lib/public-chat";
import { clearStaffCookies, errorResponse, privateJson, publicStaff, RequestError, requireSameOrigin, setStaffCookies, staffForToken, STAFF_REFRESH_COOKIE } from "../../../../lib/staff-auth";
import { supabaseAuth } from "../../../../lib/supabase";

export async function POST(req: Request) {
  try {
    requireSameOrigin(req);
    if (!(await consumeLimit(requestKey(req, "staff-refresh"), 60, 600))) throw new RequestError(429, "Too many attempts. Please try again later.");
    const refresh = (await cookies()).get(STAFF_REFRESH_COOKIE)?.value;
    if (!refresh || refresh.length > 4096) throw new RequestError(401, "Please sign in");
    const auth = await supabaseAuth("token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: refresh }) });
    if (!auth.ok) throw new RequestError(auth.status >= 500 ? 503 : 401, "Please sign in again");
    const session = await auth.json();
    let staff;
    try { staff = await staffForToken(session.access_token); }
    catch (error) {
      await supabaseAuth("logout?scope=local", { method: "POST" }, session.access_token).catch(() => undefined);
      throw error;
    }
    return setStaffCookies(privateJson({ ok: true, user: publicStaff(staff) }), session);
  } catch (error) {
    const response = errorResponse(error);
    return error instanceof RequestError && [401, 403].includes(error.status) ? clearStaffCookies(response) : response;
  }
}
