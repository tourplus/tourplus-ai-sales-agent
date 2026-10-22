# Tourplus AI Sales Agent

V1.3 Security — AI-assisted sales qualification with protected staff CRM.

## Access

Staff sign in at `/staff/login` with Supabase email/password authentication.
Admin can view, create, edit and assign every lead. Sales can view and edit only
leads whose `assigned_staff_id` matches their Supabase user UUID; newly created
Sales leads are automatically assigned to the creator. Existing demo enquiries
remain unassigned and are visible to Admin. `assigned_staff` is a display label.

Roles come from `public.staff_members`, never from user-editable metadata or an
email allowlist. Removing or deactivating a membership takes effect on the next
API/database request. All CRM endpoints validate the user and run queries with
the user's token so RLS remains effective even if an API filter is missed.

## Configuration

Copy `.env.example` to `.env.local` for local development. Configure the same
names in Vercel Production. `SUPABASE_ANON_KEY` accepts the recommended Supabase
publishable key. `SUPABASE_SERVICE_ROLE_KEY` and `OPENAI_API_KEY` must stay in
server-only secret variables. Never prefix a secret with `NEXT_PUBLIC_`.

Apply `supabase/schema.sql`, `supabase/v1.2.sql`, `supabase/v1.3a.sql`, then
`supabase/security.sql` in order. The security patch preserves existing data.
Create staff identities through Supabase Auth, then insert their UUID into
`staff_members` with `role = 'admin'` or `'sales'` using a privileged connection.
Public signup does not grant CRM access. There is no public role-management API.

For password recovery, set the Supabase Auth Site URL to the production domain
and allow `https://tourplus-ai-sales-agent.vercel.app/staff/reset` in Auth URL
Configuration. Configure a working SMTP sender in Supabase for staff password
setup/recovery emails. Users initiate password setup from the login page; no
passwords should be shared in chat, code, or logs.

## Public demo security

Chat uses a random, HttpOnly conversation cookie. Only its SHA-256 hash is stored
in the service-only `chat_sessions` table. A supplied lead UUID cannot confer
ownership. The server builds AI context from stored messages and whitelists
extracted fields; staff ownership, notes and takeover settings cannot be written
by AI. Optimistic updates preserve staff changes made during an AI request.
Anonymous database access to leads/messages is denied. Chat writes are mediated
by the server and use shared database rate limits (30 requests/IP/10 minutes,
20/conversation/10 minutes, 500 globally/day). Client IPs are stored only as HMACs.

## Validation and deployment

`npm ci`, `npm test`, and `npm run build` validate a local checkout.
`/api/health` returns a generic readiness result without credentials or data.
The production integration script runs only when explicitly invoked in a secure
server environment, with disposable users/leads cleaned up afterward. It must
never run from a browser or expose its service credential. Inspect its required
environment variables before running `node scripts/verify-production.mjs`.
