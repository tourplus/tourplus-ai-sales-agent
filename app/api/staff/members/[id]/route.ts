import { consumeLimit, requestKey } from "../../../../../lib/public-chat";
import { errorResponse, isUuid, privateJson, readJsonObject, RequestError, requireSameOrigin } from "../../../../../lib/staff-auth";
import { authIdentity, publicMember, requireAdmin, staffMutationError, staffRow, validated, type StaffRow } from "../../../../../lib/staff-management";
import { staffChange } from "../../../../../lib/staff-management-validation";
import { supabaseForUser } from "../../../../../lib/supabase";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(req);
    const actor = await requireAdmin();
    const { id } = await params;
    if (!isUuid(id)) throw new RequestError(400, "Invalid staff ID");
    const body = await readJsonObject(req, 2048);
    const input = validated(() => staffChange(body));
    if (actor.id === id && (input.active === false || input.role === "sales")) throw new RequestError(403, "You cannot deactivate or demote your own account");
    if (!(await consumeLimit(requestKey(req, "staff-management"), 60, 600))) throw new RequestError(429, "Too many changes. Please try again later.");
    const current = await staffRow(id);
    if (!current) throw new RequestError(404, "Staff member not found");
    const response = await supabaseForUser(actor.accessToken, "rpc/manage_staff_member", { method: "POST", body: JSON.stringify({
      // Merge access fields under the RPC's transaction lock. A name-only edit
      // must never restore a concurrently revoked role or reactivate an account.
      p_target_user_id: id, p_role: input.role ?? null, p_active: input.active ?? null,
      p_display_name: "display_name" in input ? input.display_name : current.display_name,
    }) });
    if (!response.ok) await staffMutationError(response);
    const result = await response.json();
    const member: StaffRow = Array.isArray(result) ? result[0] : result;
    if (!member || member.user_id !== id) throw new RequestError(503, "Unable to verify staff update");
    return privateJson({ member: publicMember(member, await authIdentity(id)) });
  } catch (error) { return errorResponse(error); }
}
