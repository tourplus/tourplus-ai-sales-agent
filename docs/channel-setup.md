# V1.5 channel setup and acceptance

The implementation is disabled by default. Building and running the offline test suite requires **no Meta, Supabase or OpenAI production keys**. These instructions do not authorize switching on production or changing the existing V1.4 database.

## Run the keyless tests

```text
npm ci
npm test
npm run test:channels
npm run build
```

The tests use pinned PGlite PostgreSQL in memory, actual application migrations, disposable local Auth identities, signed platform-shaped fixtures, an injected deterministic AI generator, and a real HTTP mock listening on 127.0.0.1. An outbound guard rejects every external origin. Nothing connects to the production Supabase project or to Meta. A native execution sandbox must permit loopback networking for the HTTP tests. The Node flags in package.json bound WebAssembly compilation memory.

The PostgreSQL bootstrap substitutes only the local Auth schema/session identities. Actual tables, RLS, grants, triggers and channel functions are applied from repository SQL. The original pgcrypto extension statement is omitted locally because gen_random_uuid is built into PostgreSQL. PGlite serializes one database connection; native multi-session load/deadlock testing is still an activation check.

## What is implemented

- Separate signed WhatsApp/Facebook/Instagram webhooks and subscription verification.
- Durable atomic intake and provider-event deduplication, with tombstones surviving lead removal.
- Channel/business-account/customer-scoped conversations. Closed enquiries keep their history and new trips create new leads.
- Staff-authorized reply queue, AI drafts/approval and optional automatic replies, with private leases and current ownership/active-role checks.
- Outbox recovery, bounded provider rate retries, monotonic delivery/read receipts, and no automatic resend after an uncertain outcome.
- Admin connection readiness page and a lead conversation/reply panel. Readiness explicitly does not claim provider verification.
- Server-only credentials, explicit send-enable gates, recipient pilot allowlist and channel-specific UTF-8 application caps.
- Media metadata capture and a visible instruction to review attachments in the provider inbox. Downloading, transcribing or sending media is not enabled by this text-message release.

The existing website chat security remains separate. Do not remove its cookie/origin checks to accommodate Meta callbacks.

## Configuration contract

Copy .env.example only into a local ignored .env.local or use the host's secret store. Never place secrets in NEXT_PUBLIC variables, client components, source, screenshots or logs.

CHANNELS_MODE is disabled, sandbox or live. Missing configuration stays disabled. Sandbox requires a loopback CHANNELS_SANDBOX_URL and is prohibited in a production runtime. It cannot send to Meta. Live mode uses only the fixed Meta Graph hosts, including when testing Meta-provided test assets. It additionally requires CHANNELS_LIVE_SEND_ENABLED=true and account.liveSendEnabled=true before sends are allowed.

CHANNEL_ACCOUNTS_JSON is an array of nonsecret account definitions. Example **dummy** definition:

```json
[
  {
    "channel": "whatsapp",
    "accountId": "900000000000001",
    "label": "TOURPLUS test number",
    "enabled": false,
    "apiVersion": "v25.0",
    "appSecretEnv": "META_APP_SECRET",
    "verifyTokenEnv": "META_WEBHOOK_VERIFY_TOKEN",
    "tokenEnv": "META_WHATSAPP_ACCESS_TOKEN",
    "aiMode": "off",
    "liveSendEnabled": false,
    "allowedRecipients": ["800000000000001"],
    "templates": [
      { "name": "reservation_followup", "language": "en", "parameterCount": 0 }
    ]
  }
]
```

All IDs/version above are fixture values, not an active account or a recommendation of the latest Graph version. Set the actual supported version from the Meta app. Account and recipient IDs must be strings, preserving their exact digits. For WhatsApp accountId is the phone-number ID, not the visible phone number or WABA ID. Facebook uses the Page ID; Instagram uses the business account ID. Instagram Login defaults to graph.instagram.com; set instagramLogin=false only for a deliberately configured Facebook Login flow. Confirm that flow's exact permissions and identity routing with Meta test assets.

Secret references must use the META_ namespace and cannot reference unrelated Supabase/OpenAI credentials. Empty recipient lists block sends; '*' is an explicit broadening and should not be used for an initial pilot. Multiple business accounts use separately scoped definitions and may use separate META_ secret names.

Facebook definitions also require the nonsecret `appId` of the app issuing the Page token. It distinguishes application echoes from replies sent through the native Page inbox. Native replies join an existing current enquiry, pause AI and record history without inventing a CRM staff identity. They do not create new leads by themselves.

aiMode is off, draft or auto; start off. Configure only WhatsApp templates that Meta has actually approved, with exact language and parameter count. Template metadata in local configuration is not evidence of Meta approval. Application text caps are 1000 UTF-8 bytes for Instagram and 2000 for Facebook/WhatsApp; these conservative caps preserve multilingual boundaries.

## Database and worker activation — later, isolated staging first

1. Create a separate staging database with staging-only Auth/service credentials. Apply schema.sql, v1.2.sql, v1.3a.sql, security.sql, v1.4.sql, then v1.5.sql. Existing tables/data are preserved; new exposed tables have RLS and explicit role grants.
2. Deploy to a stable staging HTTPS URL with sending disabled. Use Meta test numbers/accounts and designated test recipients. Configure the required app permissions, callback subscriptions and privacy/data-deletion settings in Meta; complete any required review/verification.
3. Callback URLs are /api/webhooks/whatsapp, /api/webhooks/facebook and /api/webhooks/instagram. Verify-token GET and raw-body HMAC POST are separate checks. A successful challenge or sample event is not proof of real message delivery.
4. Configure a random server-only CHANNEL_WORKER_SECRET with at least 32 characters. The optional `20261028074544_channel_worker_schedule.sql` migration creates a Supabase Cron minute sweep **inactive**, using pg_net and a dedicated Vault secret named `tourplus_channel_worker_secret`. Supply the same worker-only credential to Vercel and Vault outside migration/source files. Verify its actual HTTP response and private schema grants before activating the job. A successful cron enqueue alone does not prove the worker ran. The worker uses bearer authorization and no query parameters; never use a service-role key as the worker credential. Each run processes one AI job and up to two sends, with 90-second leases. Overlapping workers use database leases. A production-only `Next.after` wakeup improves intake latency; the minute sweep handles retry/recovery when that wakeup fails.
5. Enable one test account and named pilot recipients. Enable both send gates only after staging validation. First prove capture and staff replies; then draft AI; then limited automatic AI with approved business knowledge.
6. Verify the matrix below using ordinary designated test-user accounts, including users outside app roles where needed for production permissions. Only after this gate should production keys/number activation be considered.

Disabling CHANNELS_MODE or either send gate blocks external dispatch. Worker authorization is independent of staff login. Removing credentials alone is not a deployment or migration procedure; retain an explicit rollback to disabled mode.

## Acceptance matrix

| Test | Offline coverage | Required later with Meta test assets |
|---|---|---|
| Signed WA/FB/IG receive -> enquiry -> reply | Actual signature/parser/SQL/worker/loopback HTTP | Real message from ordinary app/device and reply received |
| Duplicate and concurrent callbacks | Database uniqueness and atomic batch | Platform redelivery and multi-session stress |
| Restart recovery | Database dump/reload and lease expiration | Hosting termination and scheduler recovery |
| Staff roles/ownership/deactivation | Actual PostgreSQL RLS/RPC plus HTTP route denial | Staging Auth login and role changes |
| AI / takeover / drafts | Deterministic generator, stale rejection, SQL invariants | Model quality in English, Malay, Chinese and real takeover |
| Sent/delivered/read/failure ordering | Signed shapes and durable receipts | Actual per-channel callback formats/subscriptions |
| 24-hour window and templates | SQL/client/server guards and allowlists | Meta approval and real accepted/rejected sends |
| Unknown send outcome | 5xx/socket interruption -> no blind replay | Provider inbox/receipt reconciliation procedure |
| Media | Safe metadata + visible staff handling | Review in provider inbox; no promise of CRM previews |
| Regression | Existing V1.3/V1.4 unit tests and isolated migration/policy checks | Production regression only after authorized rollout |

Once a provider request has already been dispatched, takeover cannot recall it. The system cancels pending AI work and rechecks permissions/takeover immediately before dispatch; the pilot must also test this unavoidable network boundary.

## Operating limitations and scope

- Connection health is configuration-only; tokens, app review, subscriptions and actual delivery are not remotely probed or certified.
- The worker intentionally leaves unknown outcomes blocked from automatic replay. Reconcile through actual provider evidence and a controlled service operation; no staff-facing force-resend/bypass is exposed.
- Unsupported media is captured visibly for staff, not silently treated as AI-readable text.
- Facebook/Instagram instant forms, comments, historical inbox import and cross-channel contact merging are separate future connectors. Initial scope is direct inbound chat and text/template replies.
- No production deployment, production schema migration, live subscription, live message or permanent user credential change is part of keyless verification.

## Platform references

- WhatsApp policy/window/templates: https://whatsappbusiness.com/policy/
- Meta Messenger Send API: https://www.postman.com/meta/messenger-platform-api/folder/vilwbh4/send-api
- Instagram Login: https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login
- Meta webhook signature/challenge reference: https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/ (archived SDK; no SDK installed)
- PGlite local PostgreSQL: https://pglite.dev/docs/
