import { randomBytes, randomUUID } from 'node:crypto';

// Run only in a trusted server/build environment. Never prints credentials,
// customer data, auth tokens, cookies, fixture addresses, or response bodies.
const base = (process.env.SECURITY_VERIFY_URL || process.env.SECURITY_VERIFY_BASE_URL || 'https://tourplus-ai-sales-agent.vercel.app').replace(/\/$/, '');
const db = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const password = process.env.SECURITY_VERIFY_PASSWORD || randomBytes(32).toString('base64url');
const runId = (process.env.SECURITY_VERIFY_RUN_ID || randomUUID()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24).toLowerCase();
const marker = `V1.3 security verification ${runId}`;
const users = [];
const leadIds = new Set();
const rateKeys = new Set();
const checks = [];
let currentCheck = 'configuration';
let failure;
let permanentAdmin = 'not_requested';
let recoveryRedirectReady = null;
let initialLeadIds = [];
let initialMessageIds = [];

function assert(condition, message = 'Verification assertion failed') {
  if (!condition) throw new Error(message);
}

async function request(url, init = {}) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(75000), ...init });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { body = undefined; }
    return { response, status: response.status, body, html: raw };
  } catch { throw new Error('Network request failed'); }
}

async function service(path, method = 'GET', body) {
  const result = await request(`${db}/${path}`, {
    method,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(result.response.ok, `Fixture operation failed (HTTP ${result.status})`);
  return result.body;
}

async function rest(path, token = anonKey, method = 'GET', body) {
  return request(`${db}/rest/v1/${path}`, {
    method,
    headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

class Browser {
  cookies = new Map();
  async call(path, method = 'GET', body, origin = base) {
    const result = await request(`${base}${path}`, {
      method,
      headers: {
        Origin: origin, 'Content-Type': 'application/json',
        Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const cookie of result.response.headers.getSetCookie()) {
      const first = cookie.split(';', 1)[0];
      const separator = first.indexOf('=');
      const name = first.slice(0, separator);
      const value = first.slice(separator + 1);
      if (/max-age=0/i.test(cookie) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return result;
  }
  copy() { const copy = new Browser(); copy.cookies = new Map(this.cookies); return copy; }
}

async function check(name, action) {
  currentCheck = name;
  await action();
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function createUser(label, metadata = {}) {
  const email = `v13-${runId}-${label}@example.invalid`;
  const payload = await service('auth/v1/admin/users', 'POST', { email, password, email_confirm: true, user_metadata: metadata });
  const user = payload.user || payload;
  assert(typeof user.id === 'string', 'Fixture user was not created');
  users.push(user.id);
  return { id: user.id, email, browser: new Browser() };
}

async function directLogin(user) {
  const result = await request(`${db}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: user.email, password }),
  });
  assert(result.response.ok && result.body?.access_token, 'Supabase password login failed');
  return result.body.access_token;
}

function extractLead(result) {
  const lead = result.body?.lead || result.body;
  if (lead?.id) leadIds.add(lead.id);
  assert(result.response.ok && typeof lead?.id === 'string', 'CRM fixture creation failed');
  return lead;
}

function denied(result) { return result.status === 401 || result.status === 403; }

try {
  assert(db && serviceKey && anonKey && password.length >= 16, 'Required server verification configuration is missing');
  assert(new URL(base).protocol === 'https:' || new URL(base).hostname === 'localhost', 'Invalid verification URL');

  const admin = await createUser('admin');
  const sales = await createUser('sales');
  const outsider = await createUser('outsider', { role: 'admin', is_admin: true });
  await service('rest/v1/staff_members', 'POST', [
    { user_id: admin.id, role: 'admin', active: true },
    { user_id: sales.id, role: 'sales', active: true },
  ]);
  initialLeadIds = (await service('rest/v1/leads?select=id')).map(row => row.id);
  initialMessageIds = (await service('rest/v1/messages?select=id')).map(row => row.id);
  const stranger = new Browser();
  let adminLead;
  let salesLead;
  let adminToken;
  let salesToken;

  await check('production_health', async () => {
    const result = await stranger.call('/api/health');
    assert(result.status === 200 && result.body?.status === 'ok' && result.body?.version === '1.3-security', 'Production health failed');
    assert((await stranger.call('/')).status === 200, 'Public demo page failed');
    assert((await stranger.call('/staff/login')).status === 200, 'Staff login page failed');
  });

  await check('anonymous_crm_denied', async () => {
    assert((await stranger.call('/api/leads')).status === 401, 'Anonymous lead list was accessible');
    assert((await stranger.call(`/api/leads/${randomUUID()}`)).status === 401, 'Anonymous lead detail was accessible');
    assert((await stranger.call('/api/leads', 'POST', { customer_name: marker })).status === 401, 'Anonymous create was accepted');
    assert((await stranger.call(`/api/leads/${randomUUID()}`, 'PATCH', { notes: marker })).status === 401, 'Anonymous update was accepted');
    const dashboard = await stranger.call('/dashboard');
    assert([303, 307, 308].includes(dashboard.status) && dashboard.response.headers.get('location')?.includes('/staff/login'), 'Anonymous dashboard was accessible');
    const invalid = await stranger.call('/api/staff/login', 'POST', { email: admin.email, password: `${password}invalid` });
    assert(invalid.status === 401, 'Incorrect password was accepted');
  });

  await check('real_admin_and_sales_password_login', async () => {
    for (const account of [admin, sales]) {
      const result = await account.browser.call('/api/staff/login', 'POST', { email: account.email, password });
      assert(result.status === 200 && account.browser.cookies.has('tp_staff_session') && account.browser.cookies.has('tp_staff_refresh'), 'Real staff login failed');
      const cookieHeaders = result.response.headers.getSetCookie().join(';');
      assert(/httponly/i.test(cookieHeaders) && /secure/i.test(cookieHeaders) && /samesite=/i.test(cookieHeaders), 'Staff cookie security attributes missing');
    }
    adminToken = await directLogin(admin);
    salesToken = await directLogin(sales);
    const dashboard = await admin.browser.call('/dashboard');
    assert(dashboard.status === 200 && dashboard.html.includes('Lead Dashboard'), 'Admin dashboard HTML failed');
    assert((await admin.browser.call('/api/staff/session')).status === 200, 'Staff session inspection failed');
  });

  await check('user_metadata_cannot_grant_staff_access', async () => {
    const outsiderToken = await directLogin(outsider);
    const result = await outsider.browser.call('/api/staff/login', 'POST', { email: outsider.email, password });
    assert(result.status === 403, 'Non-staff user gained staff access');
    const rows = await rest('leads?select=id', outsiderToken);
    assert(rows.response.ok && Array.isArray(rows.body) && rows.body.length === 0, 'Non-staff user bypassed RLS');
  });

  await check('admin_crm_create_read_update', async () => {
    adminLead = extractLead(await admin.browser.call('/api/leads', 'POST', { customer_name: `${marker} admin`, source: 'security_verification', service: 'airport_transfer', status: 'NEW' }));
    const detail = await admin.browser.call(`/api/leads/${adminLead.id}`);
    assert(detail.status === 200 && detail.body?.lead?.id === adminLead.id, 'Admin detail failed');
    const page = await admin.browser.call(`/dashboard/${adminLead.id}`);
    assert(page.status === 200 && page.html.includes('Lead'), 'Authenticated lead detail page failed');
    const updated = await admin.browser.call(`/api/leads/${adminLead.id}`, 'PATCH', { notes: marker, status: 'FOLLOW_UP', human_takeover: true });
    assert(updated.status === 200, 'Admin update failed');
    const reread = await admin.browser.call(`/api/leads/${adminLead.id}`);
    assert(reread.body?.lead?.notes === marker && reread.body?.lead?.status === 'FOLLOW_UP' && reread.body?.lead?.human_takeover === true, 'CRM changes were not persisted');
    assert((await admin.browser.call('/api/leads', 'POST', { customer_name: marker }, 'https://invalid.example')).status === 403, 'Cross-origin CRM write was accepted');
  });

  await check('sales_ownership_and_cross_lead_denial', async () => {
    salesLead = extractLead(await sales.browser.call('/api/leads', 'POST', { customer_name: `${marker} sales`, source: 'security_verification', status: 'NEW' }));
    assert(salesLead.assigned_staff_id === sales.id, 'Sales lead ownership was not set');
    assert((await sales.browser.call(`/api/leads/${salesLead.id}`)).status === 200, 'Sales could not read own lead');
    assert((await sales.browser.call(`/api/leads/${adminLead.id}`)).status === 404, 'Sales could read another lead');
    assert((await sales.browser.call(`/api/leads/${adminLead.id}`, 'PATCH', { notes: marker })).status === 404, 'Sales could update another lead');
    assert((await sales.browser.call(`/api/leads/${salesLead.id}`, 'PATCH', { assigned_staff_id: admin.id })).status === 403, 'Sales could reassign a lead');
    assert((await sales.browser.call(`/api/leads/${salesLead.id}`, 'PATCH', { notes: marker, status: 'QUALIFYING' })).status === 200, 'Sales own lead update failed');
    const list = await sales.browser.call('/api/leads');
    assert(list.status === 200 && Array.isArray(list.body) && list.body.some(row => row.id === salesLead.id) && list.body.every(row => row.assigned_staff_id === sales.id), 'Sales list leaked other leads');
  });

  await check('database_rls_and_membership_protection', async () => {
    assert(denied(await rest('leads?select=id')), 'Anonymous direct database read was accepted');
    assert(denied(await rest('messages?select=id')), 'Anonymous message read was accepted');
    assert(denied(await rest('chat_sessions?select=lead_id', salesToken)), 'Chat ownership secrets were accessible');
    const filter = `id=in.(${adminLead.id},${salesLead.id})&select=id`;
    const own = await rest(`leads?${filter}`, salesToken);
    assert(own.response.ok && own.body.length === 1 && own.body[0].id === salesLead.id, 'Sales direct RLS failed');
    const all = await rest(`leads?${filter}`, adminToken);
    assert(all.response.ok && all.body.length === 2, 'Admin direct RLS failed');
    assert(denied(await rest(`staff_members?user_id=eq.${sales.id}`, salesToken, 'PATCH', { role: 'admin' })), 'Staff membership escalation was accepted');
    const moved = await rest(`leads?id=eq.${salesLead.id}`, salesToken, 'PATCH', { assigned_staff_id: admin.id });
    assert(denied(moved), 'Direct Sales reassignment was accepted');
    await service('rest/v1/messages', 'POST', [
      { lead_id: adminLead.id, role: 'staff', content: marker },
      { lead_id: salesLead.id, role: 'staff', content: marker },
    ]);
    const messages = await rest(`messages?lead_id=in.(${adminLead.id},${salesLead.id})&select=lead_id`, salesToken);
    assert(messages.response.ok && messages.body.length === 1 && messages.body[0].lead_id === salesLead.id, 'Message RLS leaked another lead');
  });

  await check('admin_assignment_and_input_validation', async () => {
    const members = await admin.browser.call('/api/staff/members');
    assert(members.status === 200 && members.body?.members?.some(member => member.user_id === sales.id), 'Admin staff selector failed');
    assert((await sales.browser.call('/api/staff/members')).status === 403, 'Sales could enumerate staff');
    assert((await admin.browser.call(`/api/leads/${adminLead.id}`, 'PATCH', { assigned_staff_id: sales.id })).status === 200, 'Admin assignment failed');
    assert((await sales.browser.call(`/api/leads/${adminLead.id}`)).status === 200, 'Assigned Sales could not access lead');
    assert((await admin.browser.call(`/api/leads/${adminLead.id}`, 'PATCH', { assigned_staff_id: null })).status === 200, 'Admin unassignment failed');
    assert((await sales.browser.call(`/api/leads/${adminLead.id}`)).status === 404, 'Unassigned Sales retained access');
    assert((await admin.browser.call(`/api/leads/${adminLead.id}`, 'PATCH', { role: 'admin' })).status === 400, 'Unknown CRM fields accepted');
    assert((await admin.browser.call(`/api/leads/${adminLead.id}`, 'PATCH', { travel_date: '2026-02-30' })).status === 400, 'Invalid date accepted');
  });

  await check('inactive_staff_revoked_without_token_refresh', async () => {
    await service(`rest/v1/staff_members?user_id=eq.${sales.id}`, 'PATCH', { active: false });
    try {
      assert((await sales.browser.call('/api/leads')).status === 403, 'Inactive staff API access was accepted');
      const rows = await rest('leads?select=id', salesToken);
      assert(rows.response.ok && rows.body.length === 0, 'Inactive staff direct RLS access was accepted');
    } finally { await service(`rest/v1/staff_members?user_id=eq.${sales.id}`, 'PATCH', { active: true }); }
  });

  await check('public_chat_requires_conversation_ownership', async () => {
    const before = await service(`rest/v1/messages?lead_id=eq.${adminLead.id}&select=id`);
    const deniedChat = await stranger.call('/api/chat', 'POST', { leadId: adminLead.id, message: marker });
    assert(deniedChat.status === 403, 'Public chat accepted a foreign lead ID');
    const after = await service(`rest/v1/messages?lead_id=eq.${adminLead.id}&select=id`);
    assert(before.length === after.length, 'Rejected chat wrote a message');
    assert((await stranger.call('/api/chat', 'POST', { message: marker }, 'https://invalid.example')).status === 403, 'Cross-origin public chat was accepted');
  });

  await check('real_ai_chat_cookie_and_takeover_continuity', async () => {
    const visitor = new Browser();
    const first = await visitor.call('/api/chat', 'POST', { message: `${marker}. Hello, how do I book an airport transfer? Please do not quote a price.` });
    if (first.body?.leadId) leadIds.add(first.body.leadId);
    assert(first.status === 200 && typeof first.body?.leadId === 'string' && typeof first.body?.reply === 'string' && first.body.reply.length > 10, 'Real public AI chat failed');
    assert(first.body.reply !== 'Our reservation team will assist you shortly.', 'AI generation used only the fallback reply');
    assert(visitor.cookies.has('tp_chat_session'), 'Public chat ownership cookie missing');
    const cookieHeaders = first.response.headers.getSetCookie().join(';');
    assert(/httponly/i.test(cookieHeaders) && /secure/i.test(cookieHeaders) && /samesite=strict/i.test(cookieHeaders), 'Public chat cookie protection missing');
    assert((await visitor.call('/api/chat', 'POST', { leadId: adminLead.id, message: marker })).status === 403, 'Visitor accessed another lead');
    assert((await admin.browser.call(`/api/leads/${first.body.leadId}`, 'PATCH', { status: 'FOLLOW_UP', human_takeover: true, notes: marker })).status === 200, 'Chat human takeover update failed');
    const next = await visitor.call('/api/chat', 'POST', { leadId: first.body.leadId, message: `${marker}. Please have a staff member help me.` });
    assert(next.status === 200 && next.body?.leadId === first.body.leadId && next.body?.reply === 'Our reservation team will assist you shortly.', 'Chat continuity or human takeover failed');
    const detail = await admin.browser.call(`/api/leads/${first.body.leadId}`);
    assert(detail.body?.lead?.human_takeover === true && detail.body?.lead?.status === 'FOLLOW_UP' && detail.body?.lead?.notes === marker, 'Public chat overwrote protected CRM fields');
  });

  await check('durable_rate_limit_and_private_rpc', async () => {
    const key = `verify:${runId}`;
    rateKeys.add(key);
    const body = { p_key: key, p_limit: 1, p_window_seconds: 60 };
    assert((await service('rest/v1/rpc/consume_chat_limit', 'POST', body)) === true, 'Initial rate limit request failed');
    assert((await service('rest/v1/rpc/consume_chat_limit', 'POST', body)) === false, 'Repeated rate limit request was accepted');
    assert(denied(await rest('rpc/consume_chat_limit', salesToken, 'POST', body)), 'Private rate limit RPC was accessible');
  });

  await check('session_refresh_rotation_and_logout_replay', async () => {
    const stale = sales.browser.copy();
    const refresh = await sales.browser.call('/api/staff/refresh', 'POST', {});
    assert(refresh.status === 200 && sales.browser.cookies.has('tp_staff_session') && sales.browser.cookies.has('tp_staff_refresh'), 'Session refresh failed');
    assert((await sales.browser.call('/api/leads')).status === 200, 'Refreshed session failed');
    const replay = sales.browser.copy();
    const revokedAccessToken = replay.cookies.get('tp_staff_session');
    assert((await sales.browser.call('/api/staff/logout', 'POST', {})).status === 200, 'Logout failed');
    assert((await sales.browser.call('/api/leads')).status === 401, 'Logged out browser retained access');
    assert((await replay.call('/api/leads')).status === 401, 'Logged out access token replay was accepted');
    const databaseReplay = await rest('leads?select=id', revokedAccessToken);
    assert(denied(databaseReplay) || (databaseReplay.response.ok && databaseReplay.body?.length === 0), 'Logged out token replay bypassed direct RLS');
    assert((await stale.call('/api/staff/refresh', 'POST', {})).status === 401, 'Logged out refresh token replay was accepted');
  });

  await check('logout_revokes_session_when_access_cookie_missing', async () => {
    const login = await sales.browser.call('/api/staff/login', 'POST', { email: sales.email, password });
    assert(login.status === 200, 'Relogin for expired-cookie check failed');
    sales.browser.cookies.delete('tp_staff_session');
    const replay = sales.browser.copy();
    assert((await sales.browser.call('/api/staff/logout', 'POST', {})).status === 200, 'Refresh-only logout failed');
    assert((await replay.call('/api/staff/refresh', 'POST', {})).status === 401, 'Refresh-only logout left a usable session');
  });

  await check('existing_demo_records_preserved', async () => {
    if (initialLeadIds.length) {
      const rows = await service(`rest/v1/leads?id=in.(${initialLeadIds.join(',')})&select=id`);
      assert(rows.length === initialLeadIds.length, 'Existing demo leads were changed or removed');
    }
    if (initialMessageIds.length) {
      const rows = await service(`rest/v1/messages?id=in.(${initialMessageIds.join(',')})&select=id`);
      assert(rows.length === initialMessageIds.length, 'Existing demo messages were changed or removed');
    }
  });

  const permanentEmail = process.env.SECURITY_ADMIN_EMAIL?.trim().toLowerCase();
  if (permanentEmail) {
    await check('permanent_admin_provisioning', async () => {
      assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(permanentEmail), 'Permanent Admin email is invalid');
      let existing;
      for (let page = 1; page <= 100; page++) {
        const result = await service(`auth/v1/admin/users?page=${page}&per_page=100`);
        const list = result.users || [];
        existing = list.find(user => user.email?.toLowerCase() === permanentEmail);
        if (existing || list.length < 100) break;
        assert(page < 100, 'Permanent Admin lookup pagination limit reached');
      }
      if (existing) {
        const membership = await service(`rest/v1/staff_members?user_id=eq.${existing.id}&select=role,active`);
        assert(membership[0]?.role === 'admin' && membership[0]?.active, 'Existing permanent account needs Admin membership review');
        permanentAdmin = 'already_active_password_unchanged';
      } else {
        const payload = await service('auth/v1/admin/users', 'POST', { email: permanentEmail, password: randomBytes(48).toString('base64url'), email_confirm: true });
        const user = payload.user || payload;
        assert(user.id, 'Permanent Admin creation failed');
        try {
          await service('rest/v1/staff_members', 'POST', { user_id: user.id, role: 'admin', active: true });
        } catch {
          await service(`auth/v1/admin/users/${user.id}`, 'DELETE');
          throw new Error('Permanent Admin membership creation failed');
        }
        permanentAdmin = 'created_password_setup_required';
      }
    });
    // generate_link returns a link without sending email. Keep all returned
    // recovery credentials in memory and report only whether its redirect works.
    try {
      const target = `${base}/staff/reset`;
      const generated = await service('auth/v1/admin/generate_link', 'POST', {
        type: 'recovery', email: permanentEmail, redirect_to: target,
      });
      const actionLink = generated.action_link || generated.properties?.action_link;
      const destination = new URL(new URL(actionLink).searchParams.get('redirect_to') || generated.redirect_to || 'about:blank');
      const expected = new URL(target);
      recoveryRedirectReady = destination.origin === expected.origin && destination.pathname === expected.pathname;
    } catch { recoveryRedirectReady = false; }
    if (recoveryRedirectReady) { checks.push('permanent_admin_recovery_redirect'); console.log('PASS permanent_admin_recovery_redirect'); }
    else console.log('BLOCKED permanent_admin_recovery_redirect_configuration');
  }
} catch (error) {
  failure = { check: currentCheck, reason: error instanceof Error ? error.message : 'Verification failed' };
  console.error(`FAIL ${currentCheck}: ${failure.reason}`);
} finally {
  currentCheck = 'fixture_cleanup';
  try {
    // Discover only this run's chat fixture if an AI failure hid its lead ID.
    if (serviceKey && db) {
      const hidden = await service(`rest/v1/messages?content=like.${encodeURIComponent(`*${marker}*`)}&select=lead_id`);
      for (const message of hidden || []) if (message.lead_id) leadIds.add(message.lead_id);
      for (const id of leadIds) {
        await service(`rest/v1/messages?lead_id=eq.${id}`, 'DELETE');
        await service(`rest/v1/chat_sessions?lead_id=eq.${id}`, 'DELETE');
        await service(`rest/v1/leads?id=eq.${id}`, 'DELETE');
      }
      for (const key of rateKeys) await service(`rest/v1/chat_rate_limits?key=eq.${encodeURIComponent(key)}`, 'DELETE');
      for (const id of users) await service(`auth/v1/admin/users/${id}`, 'DELETE');
      if (leadIds.size) assert((await service(`rest/v1/leads?id=in.(${[...leadIds].join(',')})&select=id`)).length === 0, 'Fixture lead cleanup was incomplete');
      if (users.length) assert((await service(`rest/v1/staff_members?user_id=in.(${users.join(',')})&select=user_id`)).length === 0, 'Fixture staff cleanup was incomplete');
      checks.push('fixture_cleanup');
      console.log('PASS fixture_cleanup');
    }
  } catch {
    failure ||= { check: 'fixture_cleanup', reason: 'Fixture cleanup needs review' };
    console.error('FAIL fixture_cleanup: Fixture cleanup needs review');
  }
}

console.log(`V13_VERIFICATION_RESULT ${JSON.stringify({ ok: !failure, checks, ...(failure ? { failure } : {}), permanentAdmin, recoveryRedirectReady })}`);
if (failure) process.exitCode = 1;
