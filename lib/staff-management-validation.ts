export type StaffRole = "admin" | "sales";
export type StaffInvitation = { email: string; role: StaffRole; display_name: string | null; mode: "email" | "link"; resend: boolean };
export type StaffChange = { role?: StaffRole; active?: boolean; display_name?: string | null };

export class StaffValidationError extends Error {}

function role(value: unknown): StaffRole {
  if (value !== "admin" && value !== "sales") throw new StaffValidationError("Select Admin or Sales");
  return value;
}

function displayName(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new StaffValidationError("Display name must be at most 200 characters");
  return value.trim() || null;
}

export function staffInvitation(body: Record<string, unknown>): StaffInvitation {
  if (Object.keys(body).some(key => !["email", "role", "display_name", "mode", "resend"].includes(key))) throw new StaffValidationError("Invalid invitation fields");
  if (typeof body.email !== "string" || body.email.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(body.email.trim())) throw new StaffValidationError("Enter a valid staff email");
  if (body.mode !== "email" && body.mode !== "link") throw new StaffValidationError("Choose email delivery or a shareable invitation link");
  if (body.resend !== undefined && typeof body.resend !== "boolean") throw new StaffValidationError("Invalid resend option");
  return { email: body.email.trim().toLowerCase(), role: role(body.role), display_name: body.display_name === undefined ? null : displayName(body.display_name), mode: body.mode, resend: body.resend === true };
}

export function staffChange(body: Record<string, unknown>): StaffChange {
  const keys = Object.keys(body);
  if (!keys.length || keys.some(key => !["role", "active", "display_name"].includes(key))) throw new StaffValidationError("Invalid staff changes");
  const change: StaffChange = {};
  if ("role" in body) change.role = role(body.role);
  if ("active" in body) {
    if (typeof body.active !== "boolean") throw new StaffValidationError("Active must be true or false");
    change.active = body.active;
  }
  if ("display_name" in body) change.display_name = displayName(body.display_name);
  return change;
}
