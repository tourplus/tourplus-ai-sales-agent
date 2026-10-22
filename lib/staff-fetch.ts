"use client";

export type StaffSession = { id: string; email: string; role: "admin" | "sales" };
export type StaffMember = { user_id: string; role: "admin" | "sales"; email?: string };
export class StaffApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = "StaffApiError"; }
}
let refreshing: Promise<boolean> | null = null;
export async function refreshStaffSession(): Promise<boolean> {
  if (!refreshing) refreshing = fetch("/api/staff/refresh", {
    method: "POST", credentials: "same-origin", cache: "no-store",
  }).then(response => response.ok).catch(() => false).finally(() => { refreshing = null; });
  return refreshing;
}
export async function staffFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const request = () => fetch(path, { ...options, credentials: "same-origin", cache: "no-store" });
  let response = await request();
  if (response.status === 401) {
    if (await refreshStaffSession()) response = await request();
    if (response.status === 401) {
      window.location.replace("/staff/login?expired=1");
      throw new StaffApiError("Your session has expired. Please sign in again.", 401);
    }
  }
  if (!response.ok) {
    const fallback = response.status === 403 ? "You do not have permission to perform this action." : "The request could not be completed. Please try again.";
    const body = await response.json().catch(() => null);
    throw new StaffApiError(typeof body?.error === "string" ? body.error : fallback, response.status);
  }
  return response;
}
export async function staffJson<T>(path: string, options?: RequestInit): Promise<T> {
  return (await staffFetch(path, options)).json() as Promise<T>;
}
export function staffError(error: unknown): string {
  return error instanceof Error ? error.message : "Connection failed. Please try again.";
}
