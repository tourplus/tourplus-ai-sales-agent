import { cookies } from "next/headers";
import { clearStaffCookies, errorResponse, privateJson, RequestError, requireSameOrigin, setStaffCookies, STAFF_ACCESS_COOKIE, STAFF_REFRESH_COOKIE, type AuthSession } from "../../../../lib/staff-auth";
import { supabaseAuth } from "../../../../lib/supabase";

export async function POST(req: Request) {
  let recoveredSession: AuthSession | undefined;
  try {
    requireSameOrigin(req);
    const jar = await cookies();
    const token = jar.get(STAFF_ACCESS_COOKIE)?.value;
    const refresh = jar.get(STAFF_REFRESH_COOKIE)?.value;
    let needsRefresh = !token;
    if (token) {
      const auth = await supabaseAuth("logout?scope=local", { method: "POST" }, token);
      if (!auth.ok) {
        if (![401, 403, 404].includes(auth.status)) throw new RequestError(503, "Unable to sign out. Please try again.");
        needsRefresh = true;
      }
    }
    // An expired access cookie must not leave its long-lived refresh session alive.
    if (needsRefresh && refresh) {
      const renewed = await supabaseAuth("token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: refresh }) });
      if (renewed.ok) {
        recoveredSession = await renewed.json();
        if (!recoveredSession?.access_token) throw new RequestError(503, "Unable to sign out. Please try again.");
        const revoke = await supabaseAuth("logout?scope=local", { method: "POST" }, recoveredSession.access_token);
        if (!revoke.ok && ![401, 403, 404].includes(revoke.status)) throw new RequestError(503, "Unable to sign out. Please try again.");
      } else if (![400, 401, 403].includes(renewed.status)) {
        throw new RequestError(503, "Unable to sign out. Please try again.");
      }
    }
    return clearStaffCookies(privateJson({ ok: true }));
  } catch (error) {
    const response = errorResponse(error);
    // A rotation may succeed before revocation becomes unavailable. Preserve the
    // replacement pair so a subsequent sign-out can retry remote revocation.
    return recoveredSession ? setStaffCookies(response, recoveredSession) : response;
  }
}
