import { errorResponse, isUuid, privateJson, readJsonObject, RequestError, requireSameOrigin, requireStaff } from "../../../../lib/staff-auth";
import { supabaseForUser } from "../../../../lib/supabase";
import { databaseError, leadSelection, validateLead } from "../validation";

type Context = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: Context) {
  try {
    const staff = await requireStaff();
    const { id } = await params;
    if (!isUuid(id)) throw new RequestError(400, "Invalid lead ID");
    const owner = staff.role === "sales" ? `&assigned_staff_id=eq.${staff.id}` : "";
    const response = await supabaseForUser(staff.accessToken, `leads?id=eq.${id}&select=${leadSelection}${owner}&limit=1`);
    if (!response.ok) databaseError(response.status);
    const lead = (await response.json())[0];
    if (!lead) throw new RequestError(404, "Lead not found");
    const messages = await supabaseForUser(staff.accessToken, `messages?lead_id=eq.${id}&select=id,lead_id,role,content,created_at&order=created_at.asc&limit=1000`);
    if (!messages.ok) databaseError(messages.status);
    return privateJson({ lead, messages: await messages.json() });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(req: Request, { params }: Context) {
  try {
    requireSameOrigin(req);
    const staff = await requireStaff();
    const { id } = await params;
    if (!isUuid(id)) throw new RequestError(400, "Invalid lead ID");
    const data = await validateLead(await readJsonObject(req), staff, false);
    const owner = staff.role === "sales" ? `&assigned_staff_id=eq.${staff.id}` : "";
    const response = await supabaseForUser(staff.accessToken, `leads?id=eq.${id}&select=${leadSelection}${owner}`, { method: "PATCH", body: JSON.stringify(data) });
    if (!response.ok) databaseError(response.status);
    const lead = (await response.json())[0];
    if (!lead) throw new RequestError(404, "Lead not found");
    return privateJson(lead);
  } catch (error) { return errorResponse(error); }
}
