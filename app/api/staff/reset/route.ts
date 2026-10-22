import { consumeLimit, requestKey } from "../../../../lib/public-chat";
import { clearStaffCookies, errorResponse, privateJson, readJsonObject, RequestError, requireSameOrigin, staffForToken } from "../../../../lib/staff-auth";
import { supabaseAuth } from "../../../../lib/supabase";

export async function POST(req: Request) {
  let passwordUpdated = false;
  try {
    requireSameOrigin(req);
    const body = await readJsonObject(req, 12288);
    if (Object.keys(body).some(key => !["access_token", "password"].includes(key)) || typeof body.access_token !== "string" || !body.access_token.length || body.access_token.length > 8192 || typeof body.password !== "string" || body.password.length < 12 || body.password.length > 1024) throw new RequestError(400, "Use a valid reset link and a password of at least 12 characters");
    if (!(await consumeLimit(requestKey(req, "staff-reset"), 5, 600))) throw new RequestError(429, "Too many attempts. Please try again later.");
    const staff = await staffForToken(body.access_token);
    const update = await supabaseAuth("user", { method: "PUT", body: JSON.stringify({ password: body.password }) }, staff.accessToken);
    if (!update.ok) throw new RequestError(update.status >= 500 ? 503 : 400, "Password could not be changed. Request a fresh reset link and try again.");
    passwordUpdated = true;
    const revoke = await supabaseAuth("logout?scope=global", { method: "POST" }, staff.accessToken);
    if (!revoke.ok && ![401, 403, 404].includes(revoke.status)) throw new RequestError(503, "Your password was updated, but session revocation could not be confirmed. Please sign in and sign out again.");
    return clearStaffCookies(privateJson({ ok: true }));
  } catch (error) {
    const response = errorResponse(error);
    return passwordUpdated ? clearStaffCookies(response) : response;
  }
}
