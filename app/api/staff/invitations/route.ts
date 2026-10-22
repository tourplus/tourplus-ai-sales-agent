import { consumeLimit, hashToken, requestKey } from "../../../../lib/public-chat";
import { errorResponse, isUuid, privateJson, readJsonObject, RequestError, requireSameOrigin } from "../../../../lib/staff-auth";
import { authAdmin, identityByEmail, publicMember, requireAdmin, staffColumns, staffRow, validated, type AuthIdentity, type StaffRow } from "../../../../lib/staff-management";
import { staffInvitation } from "../../../../lib/staff-management-validation";
import { supabase, supabaseConfig } from "../../../../lib/supabase";

export async function POST(req: Request) {
  try {
    requireSameOrigin(req);
    const actor = await requireAdmin();
    const body = await readJsonObject(req, 4096);
    const input = validated(() => staffInvitation(body));
    if (!(await consumeLimit(requestKey(req, "staff-invitation"), 10, 600)) || !(await consumeLimit("staff-invite-email:" + hashToken(input.email), 3, 600))) throw new RequestError(429, "Too many invitations. Please try again later.");
    let identity = await identityByEmail(input.email);
    let member: StaffRow | null = null;
    if (identity) {
      member = await staffRow(identity.id);
      if (!member) throw new RequestError(409, "This email already has a non-staff account. Its account and password have not been changed.");
      if (identity.email_confirmed_at) throw new RequestError(409, "This staff account is already confirmed. Use the sign-in page to reset its password.");
      if (!member.active) throw new RequestError(409, "Reactivate this staff member before resending an invitation");
      if (!member.invited_at || !input.resend) throw new RequestError(409, "A pending staff account already exists. Choose Resend invitation explicitly.");
      if (member.role !== input.role || ("display_name" in body && member.display_name !== input.display_name)) throw new RequestError(409, "Resending cannot change staff details. Save the role or name first.");
    } else {
      if (input.resend) throw new RequestError(404, "No pending invitation exists for this email");
      // Creating a passwordless, unconfirmed account fails safely if a concurrent
      // signup wins. We never upsert or replace an existing Auth account.
      const created = await authAdmin("admin/users", { method: "POST", body: JSON.stringify({ email: input.email, email_confirm: false }) });
      if (!created.ok) throw new RequestError(created.status === 422 ? 409 : 503, "Unable to create this invitation. An existing account may already use this email.");
      const user = await created.json();
      if (!isUuid(user?.id) || user?.email?.toLowerCase() !== input.email || user.email_confirmed_at) throw new RequestError(503, "Unable to verify the new invitation account");
      identity = { id: user.id, email: user.email, email_confirmed_at: null };
      const provisioned = await supabase(`staff_members?select=${staffColumns}`, { method: "POST", body: JSON.stringify({
        user_id: identity.id, role: input.role, active: true, display_name: input.display_name,
        invited_at: new Date().toISOString(), invited_by: actor.id,
      }) });
      if (!provisioned.ok) {
        // Revert only the exact new account created by this request. Existing
        // accounts and memberships are never deleted or changed by invitation.
        await authAdmin(`admin/users/${identity.id}`, { method: "DELETE" }).catch(() => undefined);
        throw new RequestError(503, "Unable to save the invitation. Please try again.");
      }
      member = (await provisioned.json())[0];
      if (!member) throw new RequestError(503, "Unable to verify the staff invitation");
    }
    const redirect = new URL("/staff/reset", req.url).toString();
    const delivery = input.mode === "email"
      ? await authAdmin(`invite?redirect_to=${encodeURIComponent(redirect)}`, { method: "POST", body: JSON.stringify({ email: input.email }) })
      : await authAdmin(`admin/generate_link?redirect_to=${encodeURIComponent(redirect)}`, { method: "POST", body: JSON.stringify({ type: "invite", email: input.email, redirect_to: redirect }) });
    if (!delivery.ok) return privateJson({
      error: input.mode === "email" ? "Staff access is pending, but the email provider did not accept the invitation. Generate a secure invitation link instead." : "Staff access is pending, but an invitation link could not be generated. Please try again.",
      member: publicMember(member, identity as AuthIdentity), delivery: "failed",
    }, 502);
    if (input.mode === "email") return privateJson({ ok: true, member: publicMember(member, identity as AuthIdentity), delivery: "submitted", message: "Invitation accepted by the email provider. Inbox delivery is not confirmed." }, 201);
    const generated = await delivery.json();
    const link = generated.action_link || generated.properties?.action_link;
    let safeLink = false;
    try {
      const parsed = new URL(link);
      safeLink = parsed.origin === new URL(supabaseConfig().url).origin && parsed.pathname === "/auth/v1/verify" && parsed.searchParams.get("type") === "invite" && parsed.searchParams.get("redirect_to") === redirect;
    } catch { /* Return only a provider-issued link with the expected destination. */ }
    if (!safeLink) throw new RequestError(503, "The invitation destination could not be verified. Contact an administrator.");
    // The bearer link is returned only for the explicitly selected manual mode,
    // under no-store headers. It must never appear in logs or stored audit data.
    return privateJson({ ok: true, member: publicMember(member, identity as AuthIdentity), delivery: "link", invitation_link: link, message: "Share this private link only with the intended staff member. No email was sent." }, 201);
  } catch (error) { return errorResponse(error); }
}
