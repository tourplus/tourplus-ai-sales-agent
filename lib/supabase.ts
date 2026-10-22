import "server-only";

export function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Supabase is not configured");
  return { url: url.replace(/\/$/, ""), anon };
}

function databaseRequest(path: string, key: string, token: string, init: RequestInit = {}) {
  const { url } = supabaseConfig();
  const headers = new Headers(init.headers);
  headers.set("apikey", key);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  if (!headers.has("Prefer")) headers.set("Prefer", "return=representation");
  return fetch(`${url}/rest/v1/${path}`, {
    ...init, headers, cache: "no-store", redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(15000),
  });
}

// CRM operations use the user's token so RLS independently enforces access.
export function supabase(path: string, init: RequestInit = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("Supabase is not configured");
  return databaseRequest(path, key, key, init);
}

export function supabaseForUser(token: string, path: string, init: RequestInit = {}) {
  const { anon } = supabaseConfig();
  return databaseRequest(path, anon, token, init);
}

export function supabaseAuth(path: string, init: RequestInit = {}, token?: string) {
  const { url, anon } = supabaseConfig();
  const headers = new Headers(init.headers);
  headers.set("apikey", anon);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${url}/auth/v1/${path}`, {
    ...init, headers, cache: "no-store", redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(15000),
  });
}
