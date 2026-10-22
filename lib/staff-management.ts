import "server-only";
import { isUuid, RequestError, requireStaff } from "./staff-auth";
import { supabase, supabaseConfig } from "./supabase";
import { StaffValidationError } from "./staff-management-validation";

export type StaffRow = { user_id: string; role: "admin" | "sales"; active: boolean; display_name: string | null; invited_at: string | null; created_at: string };
export type AuthIdentity = { id: string; email?: string; email_confirmed_at?: string | null };
export const staffColumns = "user_id,role,active,display_name,invited_at,created_at";

export async function requireAdmin() {
  const actor = await requireStaff();
  if (actor.role !== "admin") throw new RequestError(403, "Admin access required");
  return actor;
}

export function validated<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (error instanceof StaffValidationError) throw new RequestError(400, error.message);
    throw error;
  }
}

export function authAdmin(path: string, init: RequestInit = {}) {
  const { url } = supabaseConfig();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new RequestError(503, "Staff management is temporarily unavailable");
  return fetch(`${url}/auth/v1/${path}`, {
    ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
  });
}

export async function authIdentity(id: string): Promise<AuthIdentity> {
  if (!isUuid(id)) throw new RequestError(400, "Invalid staff ID");
  const response = await authAdmin(`admin/users/${id}`);
  if (!response.ok) throw new RequestError(503, "Unable to load staff account status");
  const user = await response.json();
  if (user?.id !== id) throw new RequestError(503, "Unable to verify staff account");
  return { id, email: typeof user.email === "string" ? user.email : undefined, email_confirmed_at: user.email_confirmed_at || null };
}

export async function identityByEmail(email: string): Promise<AuthIdentity | null> {
  // Filter is only a candidate search. Match the complete normalized address so
  // another account with a similar address can never be provisioned or modified.
  for (let page = 1; page <= 10; page++) {
    const response = await authAdmin(`admin/users?filter=${encodeURIComponent(email)}&page=${page}&per_page=1000`);
    if (!response.ok) throw new RequestError(503, "Unable to verify the existing account");
    const data = await response.json();
    if (!Array.isArray(data.users)) throw new RequestError(503, "Unable to verify the existing account");
    const user = data.users.find((candidate: { email?: unknown }) => typeof candidate.email === "string" && candidate.email.toLowerCase() === email);
    if (user) {
      if (!isUuid(user.id)) throw new RequestError(503, "Unable to verify the existing account");
      return { id: user.id, email: user.email, email_confirmed_at: user.email_confirmed_at || null };
    }
    if (data.users.length < 1000) return null;
  }
  throw new RequestError(503, "Account lookup is too large. Please contact an administrator.");
}

export async function staffRow(id: string): Promise<StaffRow | null> {
  if (!isUuid(id)) throw new RequestError(400, "Invalid staff ID");
  const response = await supabase(`staff_members?user_id=eq.${id}&select=${staffColumns}&limit=1`);
  if (!response.ok) throw new RequestError(503, "Unable to load staff member");
  return (await response.json())[0] || null;
}

export function publicMember(member: StaffRow, identity: AuthIdentity) {
  return {
    user_id: member.user_id, email: identity.email, role: member.role, active: member.active,
    display_name: member.display_name, invited_at: member.invited_at, created_at: member.created_at,
    status: identity.email_confirmed_at ? "confirmed" as const : "pending" as const,
  };
}

export async function staffMutationError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null);
  if (body?.code === "42501" || response.status === 403) throw new RequestError(403, "Admin access is required. You cannot deactivate or demote your own account.");
  if (body?.code === "23514") throw new RequestError(409, "At least one active Admin must remain");
  if (body?.code === "P0002") throw new RequestError(404, "Staff member not found");
  if (body?.code === "22023") throw new RequestError(400, "Invalid staff changes");
  if (response.status === 401) throw new RequestError(401, "Please sign in again");
  throw new RequestError(503, "Unable to update staff member");
}
