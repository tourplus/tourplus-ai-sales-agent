import { errorResponse, privateJson, readJsonObject, requireSameOrigin, requireStaff } from "../../../lib/staff-auth";
import { supabaseForUser } from "../../../lib/supabase";
import { databaseError, leadSelection, validateLead } from "./validation";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const staff = await requireStaff();
    const owner = staff.role === "sales" ? `&assigned_staff_id=eq.${staff.id}` : "";
    const response = await supabaseForUser(staff.accessToken, `leads?select=${leadSelection}&order=created_at.desc&limit=500${owner}`);
    if (!response.ok) databaseError(response.status);
    return privateJson(await response.json());
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: Request) {
  try {
    requireSameOrigin(req);
    const staff = await requireStaff();
    const data = await validateLead(await readJsonObject(req), staff, true);
    const response = await supabaseForUser(staff.accessToken, `leads?select=${leadSelection}`, { method: "POST", body: JSON.stringify(data) });
    if (!response.ok) databaseError(response.status);
    return privateJson((await response.json())[0], 201);
  } catch (error) { return errorResponse(error); }
}
