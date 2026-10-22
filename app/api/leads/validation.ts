import "server-only";
import { isUuid, RequestError, type Staff } from "../../../lib/staff-auth";
import { supabase } from "../../../lib/supabase";

const statuses = ["NEW", "QUALIFYING", "QUOTED", "FOLLOW_UP", "CONFIRMED", "LOST"];
const services = ["airport_transfer", "coaster", "other"];
const stringLimits: Record<string, number> = {
  customer_name: 200, phone: 50, source: 32, pickup: 1000, destination: 1000,
  itinerary: 10000, assigned_staff: 200, notes: 10000,
};
const createFields = [...Object.keys(stringLimits), "service", "travel_date", "pax", "status", "assigned_staff_id", "next_follow_up_at", "human_takeover", "quoted_amount"];
const updateFields = createFields.filter(field => field !== "source");

export async function validateLead(body: Record<string, unknown>, staff: Staff, creating: boolean) {
  const allowed = creating ? createFields : updateFields;
  if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.includes(key))) throw new RequestError(400, "Invalid lead fields");
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key in stringLimits) {
      if (value !== null && (typeof value !== "string" || value.length > stringLimits[key] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) throw new RequestError(400, `Invalid ${key}`);
      data[key] = typeof value === "string" ? value.trim() : null;
    } else if (key === "status" || key === "service") {
      if (typeof value !== "string" || !(key === "status" ? statuses : services).includes(value)) throw new RequestError(400, `Invalid ${key}`);
      data[key] = value;
    } else if (key === "assigned_staff_id") {
      if (value !== null && !isUuid(value)) throw new RequestError(400, "Invalid staff ID");
      data[key] = value;
    } else if (key === "pax") {
      if (value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000)) throw new RequestError(400, "Pax must be between 1 and 1000");
      data[key] = value;
    } else if (key === "quoted_amount") {
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 9999999999.99 || Math.abs(Math.round(value * 100) - value * 100) > 0.00001)) throw new RequestError(400, "Invalid quoted amount");
      data[key] = value;
    } else if (key === "human_takeover") {
      if (typeof value !== "boolean") throw new RequestError(400, "Invalid takeover value");
      data[key] = value;
    } else if (key === "travel_date") {
      if (value !== null && (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new RequestError(400, "Invalid travel date");
      data[key] = value;
    } else if (key === "next_follow_up_at") {
      if (value !== null && (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) || !Number.isFinite(Date.parse(value)))) throw new RequestError(400, "Invalid follow-up date");
      data[key] = typeof value === "string" ? new Date(value).toISOString() : null;
    }
  }
  if (staff.role === "sales") {
    if ((!creating && ("assigned_staff_id" in body || "assigned_staff" in body)) || (creating && "assigned_staff_id" in body && body.assigned_staff_id !== staff.id) || (creating && "assigned_staff" in body && body.assigned_staff !== staff.email)) throw new RequestError(403, "Only an Admin can change lead ownership");
    if (creating) { data.assigned_staff_id = staff.id; data.assigned_staff = staff.email; }
  } else if (typeof data.assigned_staff_id === "string") {
    const owner = await supabase(`staff_members?user_id=eq.${data.assigned_staff_id}&active=eq.true&select=user_id&limit=1`);
    if (!owner.ok) throw new RequestError(503, "Unable to verify the assigned staff member");
    if (!(await owner.json()).length) throw new RequestError(400, "Select an active staff member");
    if (!("assigned_staff" in body)) data.assigned_staff = data.assigned_staff_id;
  } else if ("assigned_staff_id" in data && data.assigned_staff_id === null) data.assigned_staff = null;
  if (creating) {
    data.source ??= "crm";
    data.service ??= "other";
    data.status ??= "NEW";
  }
  data.updated_at = new Date().toISOString();
  return data;
}

export const leadSelection = "id,customer_name,phone,source,social_handle,service,travel_date,pax,pickup,destination,itinerary,quoted_amount,status,ai_summary,human_takeover,assigned_staff,assigned_staff_id,notes,next_follow_up_at,created_at,updated_at";

export function databaseError(status: number) {
  if (status === 401) throw new RequestError(401, "Please sign in again");
  if (status === 403) throw new RequestError(403, "Access denied");
  if (status === 400 || status === 409) throw new RequestError(400, "The lead data could not be saved");
  throw new RequestError(503, "Lead service temporarily unavailable");
}
