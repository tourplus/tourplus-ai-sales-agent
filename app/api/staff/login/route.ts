import { consumeLimit, requestKey } from "../../../../lib/public-chat";
import { errorResponse, privateJson, publicStaff, readJsonObject, RequestError, requireSameOrigin, setStaffCookies, staffForToken } from "../../../../lib/staff-auth";
import { supabaseAuth } from "../../../../lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    requireSameOrigin(req);
    const body = await readJsonObject(req, 4096);
    if (Object.keys(body).some(key => !["email", "password"].includes(key)) || typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) || body.email.length > 254 || typeof body.password !== "string" || !body.password.length || body.password.length > 1024) {
      throw new RequestError(400, "Enter a valid email and password");
    }
    if (!(await consumeLimit(requestKey(req, "staff-login"), 10, 600))) throw new RequestError(429, "Too many attempts. Please try again later.");
    const auth = await supabaseAuth("token?grant_type=password", {
      method: "POST", body: JSON.stringify({ email: body.email.trim().toLowerCase(), password: body.password }),
    });
    if (auth.status === 429) throw new RequestError(429, "Too many attempts. Please try again later.");
    if (!auth.ok) throw new RequestError(auth.status >= 500 ? 503 : 401, "Unable to sign in with these credentials");
    const session = await auth.json();
    let staff;
    try { staff = await staffForToken(session.access_token); }
    catch (error) {
      await supabaseAuth("logout?scope=local", { method: "POST" }, session.access_token).catch(() => undefined);
      throw error;
    }
    return setStaffCookies(privateJson({ ok: true, user: publicStaff(staff) }), session);
  } catch (error) { return errorResponse(error); }
}
