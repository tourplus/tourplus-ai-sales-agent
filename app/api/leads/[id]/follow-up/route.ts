import { errorResponse, isUuid, privateJson, readJsonObject, RequestError, requireSameOrigin, requireStaff } from "../../../../../lib/staff-auth";
import { supabaseForUser } from "../../../../../lib/supabase";
import { followUpTimestamp } from "../../../../../lib/follow-ups";
import { databaseError, leadSelection } from "../../validation";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(req);
    const staff = await requireStaff(), { id } = await params;
    if (!isUuid(id)) throw new RequestError(400, "Invalid lead ID");
    const body = await readJsonObject(req, 2048);
    if (Object.keys(body).some(key => !["action", "next_follow_up_at", "expected_updated_at"].includes(key)) || typeof body.action !== "string" || !["schedule", "complete", "cancel"].includes(body.action) || typeof body.expected_updated_at !== "string") throw new RequestError(400, "Invalid follow-up action");
    try { followUpTimestamp(body.expected_updated_at); } catch { throw new RequestError(400, "Reload this lead before updating its follow-up"); }
    const owner = staff.role === "sales" ? `&assigned_staff_id=eq.${staff.id}` : "";
    const read = await supabaseForUser(staff.accessToken, `leads?id=eq.${id}${owner}&select=id,status,next_follow_up_at,updated_at&limit=1`);
    if (!read.ok) databaseError(read.status);
    const lead = (await read.json())[0];
    if (!lead) throw new RequestError(404, "Lead not found");
    if (lead.updated_at !== body.expected_updated_at) throw new RequestError(409, "This lead changed. Reload it and try again.");
    const data: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.action === "schedule") {
      if (["CONFIRMED", "LOST"].includes(lead.status)) throw new RequestError(400, "Reopen the lead before scheduling a follow-up");
      try { data.next_follow_up_at = followUpTimestamp(body.next_follow_up_at); } catch { throw new RequestError(400, "Choose a valid follow-up date and time"); }
      if (!data.next_follow_up_at) throw new RequestError(400, "Choose a follow-up date and time");
    } else {
      if ("next_follow_up_at" in body) throw new RequestError(400, "Invalid follow-up fields");
      if (!lead.next_follow_up_at) throw new RequestError(409, "This lead has no pending follow-up");
      data.next_follow_up_at = null;
      if (body.action === "complete") data.last_follow_up_at = new Date().toISOString();
    }
    const response = await supabaseForUser(staff.accessToken, `leads?id=eq.${id}${owner}&updated_at=eq.${encodeURIComponent(body.expected_updated_at)}&select=${leadSelection}`, { method: "PATCH", body: JSON.stringify(data) });
    if (!response.ok) databaseError(response.status);
    const saved = (await response.json())[0];
    if (!saved) throw new RequestError(409, "This lead changed. Reload it and try again.");
    return privateJson({ lead: saved });
  } catch (error) { return errorResponse(error); }
}
