import { consumeLimit, requestKey } from "../../../../lib/public-chat";
import { errorResponse, privateJson, readJsonObject, RequestError, requireSameOrigin } from "../../../../lib/staff-auth";
import { supabaseAuth } from "../../../../lib/supabase";

export async function POST(req: Request) {
  try {
    requireSameOrigin(req);
    const body = await readJsonObject(req, 1024);
    if (Object.keys(body).some(key => key !== "email") || typeof body.email !== "string" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) throw new RequestError(400, "Enter a valid staff email");
    if (!(await consumeLimit(requestKey(req, "staff-recovery"), 3, 600))) throw new RequestError(429, "Too many attempts. Please try again later.");
    const redirect = new URL("/staff/reset", req.url).toString();
    const response = await supabaseAuth(`recover?redirect_to=${encodeURIComponent(redirect)}`, { method: "POST", body: JSON.stringify({ email: body.email.trim().toLowerCase() }) });
    // Never reveal whether this email has an account or a staff role.
    if (response.status >= 500) throw new RequestError(503, "Password recovery is temporarily unavailable");
    return privateJson({ ok: true, message: "If this email has an account, a password reset link will arrive shortly." });
  } catch (error) { return errorResponse(error); }
}
