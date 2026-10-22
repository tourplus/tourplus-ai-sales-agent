import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Execute only in a trusted server/build environment with server-only Vercel
// environment variables. This script never prints links, addresses, customer
// records, passwords, cookies, tokens, response bodies, or secret values.
// Every mutation targets disposable example.invalid users or this run's leads.
// No permanent account is provisioned, reset, invited, or otherwise changed.

export function malaysiaDayEnd(now) {
  const local = new Date(new Date(now).getTime() + 8 * 3600000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - 8 * 3600000;
}

export function followupBucket(value, now) {
  if (!value) return 'unscheduled';
  const time = Date.parse(value), instant = new Date(now).getTime();
  if (!Number.isFinite(time) || !Number.isFinite(instant)) throw new VerificationFailure('invalid_queue_timestamp');
  return time < instant ? 'overdue' : time < malaysiaDayEnd(now) ? 'today' : 'upcoming';
}

export function fixtureEmail(runId, label) {
  if (!/^[a-f0-9]{24}$/.test(runId) || !/^[a-z]+$/.test(label)) throw new VerificationFailure('invalid_fixture_identity');
  return `v14-${runId}-${label}@example.invalid`;
}

export function validateTarget(base, db) {
  try {
    const target = new URL(base), database = new URL(db);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
    const project = target.hostname === 'tourplus-ai-sales-agent.vercel.app'
      || /^tourplus-ai-sales-agent(?:-[a-z0-9-]+)?-tourplusdev\.vercel\.app$/.test(target.hostname);
    if ((!local && (!project || target.protocol !== 'https:')) || (local && !['http:', 'https:'].includes(target.protocol))
      || target.username || target.password || target.pathname !== '/' || target.search || target.hash
      || database.origin !== 'https://oetnbcxbfvlancnmespu.supabase.co' || database.pathname !== '/' || database.search || database.hash) throw new Error();
  } catch { throw new VerificationFailure('invalid_verification_target'); }
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const rowDigest = value => createHash('sha256').update(canonical(value)).digest('hex');
class VerificationFailure extends Error { constructor(code) { super('Verification failed'); this.code = code; } }
const assert = (condition, code = 'assertion_failed') => { if (!condition) throw new VerificationFailure(code); };
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const denied = result => [401, 403].includes(result.status);
const immutableDenied = result => denied(result) || (!result.response.ok && result.body?.code === '55000');
const sameIds = (actual, expected) => actual.length === expected.length && actual.every(id => expected.includes(id));

export async function verifyV14(env = process.env) {
  const base = (env.SECURITY_VERIFY_URL || env.SECURITY_VERIFY_BASE_URL || 'https://tourplus-ai-sales-agent.vercel.app').replace(/\/$/, '');
  const db = (env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY, anonKey = env.SUPABASE_ANON_KEY;
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const runId = randomUUID().replaceAll('-', '').slice(0, 24);
  const marker = `V1.4 verification ${runId}`;
  const users = new Map(), leadIds = new Set(), invitationEmails = new Set(), originalSnapshots = new Map();
  const checks = [], originalData = {};
  let currentCheck = 'configuration', failure, configured = false, originalAuth = new Map();

  async function request(url, init = {}) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(75000), ...init });
      const raw = await response.text();
      let body;
      try { body = JSON.parse(raw); } catch { /* HTML or an empty response. */ }
      return { response, status: response.status, body, html: raw };
    } catch { throw new VerificationFailure('network_request_failed'); }
  }

  async function serviceResult(path, method = 'GET', body, headers = {}) {
    return request(`${db}/${path}`, {
      method, headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function service(path, method = 'GET', body, headers) {
    const result = await serviceResult(path, method, body, headers);
    assert(result.response.ok, `fixture_http_${result.status}`);
    return result.body;
  }
  async function rest(path, token = anonKey, method = 'GET', body) {
    return request(`${db}/rest/v1/${path}`, {
      method, headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  class Browser {
    cookies = new Map();
    async call(path, method = 'GET', body, origin = base) {
      const result = await request(`${base}${path}`, {
        method, headers: {
          Origin: origin, 'Content-Type': 'application/json',
          Cookie: [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          ...(bypass ? { 'x-vercel-protection-bypass': bypass } : {}),
        }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const cookie of result.response.headers.getSetCookie()) {
        const first = cookie.split(';', 1)[0], separator = first.indexOf('=');
        const name = first.slice(0, separator), value = first.slice(separator + 1);
        if (/max-age=0/i.test(cookie) || !value) this.cookies.delete(name);
        else this.cookies.set(name, value);
      }
      return result;
    }
  }

  async function check(name, action) {
    currentCheck = name; await action(); checks.push(name); console.log(`PASS ${name}`);
  }
  async function listAuth() {
    const result = [];
    for (let page = 1; page <= 100; page++) {
      const data = await service(`auth/v1/admin/users?page=${page}&per_page=1000`);
      assert(Array.isArray(data.users), 'auth_inventory_unavailable'); result.push(...data.users);
      if (data.users.length < 1000) return result;
    }
    throw new VerificationFailure('auth_inventory_limit');
  }
  async function allRows(table, primaryKey = 'id') {
    const result = [];
    for (let offset = 0; offset < 100000; offset += 500) {
      const rows = await service(`rest/v1/${table}?select=*&order=${primaryKey}.asc&limit=500&offset=${offset}`);
      assert(Array.isArray(rows), 'integrity_inventory_unavailable'); result.push(...rows);
      if (rows.length < 500) return result;
    }
    throw new VerificationFailure('integrity_inventory_limit');
  }
  async function snapshotOriginals() {
    for (const [table, key] of [['leads', 'id'], ['messages', 'id'], ['staff_members', 'user_id'], ['lead_activities', 'id']]) {
      const rows = await allRows(table, key);
      if (table === 'staff_members') assert(rows.some(row => row.role === 'admin' && row.active === true), 'existing_active_admin_prerequisite_missing');
      originalSnapshots.set(table, { key, rows: new Map(rows.map(row => [row[key], rowDigest(row)])) });
    }
    originalAuth = new Map((await listAuth()).map(user => [user.id, rowDigest({ id: user.id, email: user.email, email_confirmed_at: user.email_confirmed_at })]));
  }
  async function verifyOriginals() {
    for (const [table, snapshot] of originalSnapshots) {
      const current = new Map((await allRows(table, snapshot.key)).map(row => [row[snapshot.key], rowDigest(row)]));
      for (const [id, digest] of snapshot.rows) assert(current.get(id) === digest, 'original_record_integrity_changed');
      originalData[table] = { original: snapshot.rows.size, unchanged: snapshot.rows.size };
    }
    const current = new Map((await listAuth()).map(user => [user.id, rowDigest({ id: user.id, email: user.email, email_confirmed_at: user.email_confirmed_at })]));
    for (const [id, digest] of originalAuth) assert(current.get(id) === digest, 'original_account_integrity_changed');
    originalData.authUsers = { original: originalAuth.size, unchanged: originalAuth.size };
  }
  async function createUser(label, staffRole) {
    const email = fixtureEmail(runId, label), password = randomBytes(32).toString('base64url');
    const payload = await service('auth/v1/admin/users', 'POST', { email, password, email_confirm: true });
    const created = payload.user || payload;
    assert(isUuid(created?.id) && created.email?.toLowerCase() === email && !originalAuth.has(created.id), 'fixture_identity_invalid');
    const user = { id: created.id, email, password, browser: new Browser(), label: `V14 fixture ${label}` };
    users.set(user.id, user);
    if (staffRole) await service('rest/v1/staff_members', 'POST', { user_id: user.id, role: staffRole, active: true, display_name: user.label });
    return user;
  }
  async function login(user) {
    const result = await user.browser.call('/api/staff/login', 'POST', { email: user.email, password: user.password });
    assert(result.status === 200 && result.body?.user?.id === user.id && user.browser.cookies.has('tp_staff_session'), 'real_password_login_failed');
    assert(!result.body.access_token && !result.body.refresh_token, 'auth_response_exposes_tokens');
    const cookies = result.response.headers.getSetCookie().join(';');
    assert(/httponly/i.test(cookies) && /samesite=/i.test(cookies) && (/secure/i.test(cookies) || new URL(base).protocol === 'http:'), 'staff_cookie_flags_missing');
    return user.browser.cookies.get('tp_staff_session');
  }
  async function createLead(user, label, fields = {}) {
    const result = await user.browser.call('/api/leads', 'POST', { customer_name: `${marker} ${label}`, source: 'v14_verification', service: 'other', status: 'NEW', ...fields });
    const lead = result.body?.lead || result.body;
    if (isUuid(lead?.id) && !originalSnapshots.get('leads')?.rows.has(lead.id)) leadIds.add(lead.id);
    assert(result.status === 201 && leadIds.has(lead?.id), 'fixture_lead_creation_failed');
    return lead;
  }
  async function lead(user, id) {
    assert(leadIds.has(id), 'non_fixture_lead_target');
    const result = await user.browser.call(`/api/leads/${id}`);
    assert(result.status === 200 && result.body?.lead?.id === id, 'fixture_lead_read_failed');
    return result.body.lead;
  }
  async function patch(user, id, changes) {
    assert(leadIds.has(id), 'non_fixture_lead_target');
    const result = await user.browser.call(`/api/leads/${id}`, 'PATCH', changes);
    assert(result.status === 200, 'fixture_lead_update_failed'); return lead(user, id);
  }
  async function manage(admin, target, changes) {
    assert(users.has(target.id), 'non_fixture_staff_target');
    return admin.browser.call(`/api/staff/members/${target.id}`, 'PATCH', changes);
  }
  async function followup(user, record, action, next) {
    assert(leadIds.has(record.id), 'non_fixture_followup_target');
    const result = await user.browser.call(`/api/leads/${record.id}/follow-up`, 'POST', {
      action, expected_updated_at: record.updated_at, ...(next === undefined ? {} : { next_follow_up_at: next }),
    });
    assert(result.status === 200 && result.body?.lead?.id === record.id, 'followup_action_failed'); return result.body.lead;
  }
  async function activities(user, id) {
    assert(leadIds.has(id), 'non_fixture_activity_target');
    const result = await user.browser.call(`/api/leads/${id}/activities?limit=50`);
    assert(result.status === 200 && Array.isArray(result.body?.activities), 'activity_history_failed'); return result.body.activities;
  }

  try {
    validateTarget(base, db);
    assert(serviceKey && anonKey && serviceKey !== anonKey, 'server_verification_keys_missing');
    configured = true;
    await snapshotOriginals();
    const stranger = new Browser();
    let admin, salesA, salesB, outsider, invited, adminToken, salesAToken, salesBToken, working, hidden, invitedLead;

    await check('production_health_and_anonymous_denial', async () => {
      const health = await stranger.call('/api/health');
      assert(health.status === 200 && health.body?.status === 'ok' && health.body?.version === '1.4-crm', 'production_v14_health_failed');
      for (const path of ['/', '/staff/login', '/staff/reset']) assert((await stranger.call(path)).status === 200, 'public_page_unhealthy');
      for (const path of ['/api/staff/members', '/api/followups', `/api/leads/${randomUUID()}/activities`]) assert((await stranger.call(path)).status === 401, 'anonymous_v14_api_accessible');
    });

    await check('disposable_staff_bootstrap_and_real_login', async () => {
      admin = await createUser('admin', 'admin'); salesA = await createUser('salesa', 'sales'); salesB = await createUser('salesb', 'sales'); outsider = await createUser('outsider');
      adminToken = await login(admin); salesAToken = await login(salesA); salesBToken = await login(salesB);
      assert((await admin.browser.call('/dashboard')).status === 200, 'admin_dashboard_unhealthy');
      assert((await admin.browser.call('/dashboard/team')).status === 200, 'staff_management_page_unhealthy');
    });

    await check('admin_only_staff_management_and_self_protection', async () => {
      const members = await admin.browser.call('/api/staff/members?include_inactive=true');
      assert(members.status === 200 && members.body?.members?.some(member => member.user_id === salesA.id), 'admin_staff_inventory_failed');
      assert((await salesA.browser.call('/api/staff/members?include_inactive=true')).status === 403, 'sales_staff_inventory_exposed');
      assert((await manage(salesA, salesB, { role: 'admin' })).status === 403, 'sales_can_manage_staff');
      assert((await salesA.browser.call('/api/staff/invitations', 'POST', { email: fixtureEmail(runId, 'forbidden'), role: 'admin', mode: 'link' })).status === 403, 'sales_can_invite_staff');
      for (const changes of [{ role: 'sales' }, { active: false }]) assert((await manage(admin, admin, changes)).status === 403, 'admin_self_access_removal_allowed');
      const direct = await rest('rpc/manage_staff_member', adminToken, 'POST', { p_target_user_id: admin.id, p_role: 'sales', p_active: true, p_display_name: admin.label });
      assert(denied(direct), 'direct_admin_self_demotion_allowed');
      assert((await admin.browser.call('/api/staff/session')).body?.user?.role === 'admin', 'admin_self_protection_not_persisted');
    });

    await check('staff_role_activation_deactivation_live_sessions', async () => {
      const canary = await createLead(salesB, 'membership-canary');
      const before = await rest(`leads?id=eq.${canary.id}&select=id`, salesBToken);
      assert(before.response.ok && before.body.length === 1, 'active_staff_rls_canary_missing');
      assert((await manage(admin, salesB, { role: 'admin' })).status === 200, 'staff_promotion_failed');
      assert((await salesB.browser.call('/api/staff/members')).status === 200, 'promotion_did_not_affect_live_session');
      assert((await manage(admin, salesB, { role: 'sales' })).status === 200, 'staff_demotion_failed');
      assert((await salesB.browser.call('/api/staff/members')).status === 403, 'demotion_left_admin_access');
      assert((await manage(admin, salesB, { active: false })).status === 200, 'staff_deactivation_failed');
      assert(denied(await salesB.browser.call('/api/leads')), 'inactive_staff_retained_api_access');
      const inactive = await rest(`leads?id=eq.${canary.id}&select=id`, salesBToken);
      assert(denied(inactive) || (inactive.response.ok && inactive.body?.length === 0), 'inactive_staff_retained_rls_access');
      const inactiveHistory = await rest(`lead_activities?lead_id=eq.${canary.id}&select=id`, salesBToken);
      assert(denied(inactiveHistory) || (inactiveHistory.response.ok && inactiveHistory.body?.length === 0), 'inactive_staff_retained_history_rls_access');
      const activeList = await admin.browser.call('/api/staff/members');
      const fullList = await admin.browser.call('/api/staff/members?include_inactive=true');
      assert(!activeList.body?.members?.some(member => member.user_id === salesB.id) && fullList.body?.members?.some(member => member.user_id === salesB.id && member.active === false), 'inactive_staff_filter_failed');
      assert((await manage(admin, salesB, { active: true, display_name: salesB.label })).status === 200, 'staff_reactivation_failed');
      assert((await salesB.browser.call('/api/leads')).status === 200, 'reactivation_did_not_restore_live_access');
      const reactivated = await rest(`leads?id=eq.${canary.id}&select=id`, salesBToken);
      assert(reactivated.response.ok && reactivated.body.length === 1, 'reactivation_did_not_restore_rls_access');
    });

    await check('manual_invitation_resend_setup_redemption_and_real_login', async () => {
      const email = fixtureEmail(runId, 'invited'); invitationEmails.add(email);
      const input = { email, role: 'sales', display_name: 'V14 invited staff', mode: 'link' };
      const first = await admin.browser.call('/api/staff/invitations', 'POST', input);
      if (isUuid(first.body?.member?.user_id) && !originalAuth.has(first.body.member.user_id)) users.set(first.body.member.user_id, { id: first.body.member.user_id, email });
      assert(first.status === 201 && first.body?.delivery === 'link' && first.body?.member?.status === 'pending', 'manual_invitation_failed');
      assert((await admin.browser.call('/api/staff/invitations', 'POST', input)).status === 409, 'implicit_pending_invitation_overwrite_allowed');
      const resent = await admin.browser.call('/api/staff/invitations', 'POST', { ...input, resend: true });
      assert(resent.status === 201 && resent.body?.member?.user_id === first.body.member.user_id, 'explicit_invitation_resend_failed');
      const action = new URL(resent.body.invitation_link);
      assert(action.origin === db && action.pathname === '/auth/v1/verify' && action.searchParams.get('type') === 'invite' && action.searchParams.get('redirect_to') === `${base}/staff/reset`, 'invitation_link_destination_invalid');
      const redeemed = await request(action.toString());
      assert([302, 303, 307].includes(redeemed.status), 'invitation_redemption_failed');
      const location = new URL(redeemed.response.headers.get('location') || 'about:blank');
      const fragment = new URLSearchParams(location.hash.slice(1));
      const token = fragment.get('access_token');
      assert(location.origin === base && location.pathname === '/staff/reset' && fragment.get('type') === 'invite' && typeof token === 'string' && token.length > 20, 'invitation_setup_session_missing');
      invited = { id: first.body.member.user_id, email, password: randomBytes(32).toString('base64url'), browser: new Browser(), label: 'V14 invited staff' };
      users.set(invited.id, invited);
      assert((await invited.browser.call('/api/staff/reset', 'POST', { access_token: token, password: 'short' })).status === 400, 'short_setup_password_accepted');
      const setup = await invited.browser.call('/api/staff/reset', 'POST', { access_token: token, password: invited.password });
      assert(setup.status === 200 && setup.body?.ok === true, 'invitation_password_setup_failed');
      await login(invited);
      const confirmed = await admin.browser.call('/api/staff/members?include_inactive=true');
      assert(confirmed.body?.members?.some(member => member.user_id === invited.id && member.status === 'confirmed' && member.active && member.role === 'sales'), 'invited_staff_confirmation_missing');
      invitationEmails.add(outsider.email);
      const originalPasswordUser = await admin.browser.call('/api/staff/invitations', 'POST', { email: outsider.email, role: 'admin', mode: 'link' });
      assert(originalPasswordUser.status === 409, 'existing_nonstaff_account_was_replaced');
      const unchanged = await request(`${db}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: outsider.email, password: outsider.password }) });
      assert(unchanged.status === 200 && typeof unchanged.body?.access_token === 'string', 'existing_fixture_password_was_changed');
      assert(denied(await rest('rpc/manage_staff_member', salesAToken, 'POST', { p_target_user_id: invited.id, p_role: 'admin', p_active: true })), 'sales_direct_staff_rpc_allowed');
    });

    const queueFixtures = [];
    await check('followup_queue_malaysia_buckets_and_sales_isolation', async () => {
      const clock = await salesA.browser.call('/api/followups');
      assert(clock.status === 200 && clock.body?.timezone === 'Asia/Kuala_Lumpur', 'queue_timezone_missing');
      const now = Date.parse(clock.body.serverTime), end = malaysiaDayEnd(now);
      const today = now + Math.max(1, Math.floor((end - now) * 0.75));
      for (const [label, due, status] of [
        ['overdue', new Date(now - 3600000).toISOString(), 'FOLLOW_UP'],
        ['today', new Date(today).toISOString(), 'QUALIFYING'],
        ['upcoming', new Date(end + 3600000).toISOString(), 'QUOTED'],
        ['unscheduled', null, 'NEW'],
        ['confirmed', new Date(now - 3600000).toISOString(), 'CONFIRMED'],
        ['lost', new Date(now - 3600000).toISOString(), 'LOST'],
      ]) queueFixtures.push(await createLead(salesA, label, { next_follow_up_at: due, status }));
      hidden = await createLead(admin, 'private-admin', { assigned_staff_id: admin.id, assigned_staff: admin.email });
      await createLead(salesB, 'private-salesb');
      for (const view of ['all', 'overdue', 'today', 'upcoming', 'unscheduled']) {
        const result = await salesA.browser.call(`/api/followups?view=${view}&mine=false&page=1`);
        assert(result.status === 200 && result.body?.pageSize === 50 && result.body?.page === 1 && result.body?.timezone === 'Asia/Kuala_Lumpur', 'queue_response_invalid');
        const open = queueFixtures.filter(record => !['CONFIRMED', 'LOST'].includes(record.status));
        const expected = open.filter(record => view === 'all' || followupBucket(record.next_follow_up_at, result.body.serverTime) === view).map(record => record.id);
        assert(sameIds(result.body.leads.map(record => record.id), expected) && result.body.total === expected.length, 'queue_bucket_or_ownership_mismatch');
        assert(result.body.counts.all === open.length && ['overdue', 'today', 'upcoming', 'unscheduled'].every(bucket => result.body.counts[bucket] === open.filter(record => followupBucket(record.next_follow_up_at, result.body.serverTime) === bucket).length), 'queue_counts_mismatch');
      }
      const mine = await admin.browser.call('/api/followups?mine=true');
      assert(mine.status === 200 && sameIds(mine.body.leads.map(record => record.id), [hidden.id]) && mine.body.leads.every(record => record.assigned_staff_id === admin.id), 'admin_mine_filter_failed');
      for (const query of ['?view=invalid', '?mine=invalid', '?page=0']) assert((await salesA.browser.call('/api/followups' + query)).status === 400, 'invalid_queue_filter_accepted');
    });

    await check('followup_schedule_reschedule_stale_complete_cancel', async () => {
      working = await createLead(salesA, 'working', { notes: 'Initial verification note', status: 'FOLLOW_UP' });
      const original = working, firstDue = new Date(Date.now() + 7200000).toISOString(), secondDue = new Date(Date.now() + 10800000).toISOString();
      working = await followup(salesA, working, 'schedule', firstDue);
      assert(Date.parse(working.next_follow_up_at) === Date.parse(firstDue), 'followup_schedule_not_persisted');
      const stale = await salesA.browser.call(`/api/leads/${working.id}/follow-up`, 'POST', { action: 'schedule', expected_updated_at: original.updated_at, next_follow_up_at: secondDue });
      assert(stale.status === 409, 'stale_followup_update_accepted');
      working = await followup(salesA, working, 'schedule', secondDue);
      assert(Date.parse(working.next_follow_up_at) === Date.parse(secondDue), 'followup_reschedule_not_persisted');
      working = await followup(salesA, working, 'complete');
      assert(working.next_follow_up_at === null && Number.isFinite(Date.parse(working.last_follow_up_at)), 'followup_completion_not_persisted');
      const completedAt = working.last_follow_up_at;
      assert((await salesA.browser.call(`/api/leads/${working.id}/follow-up`, 'POST', { action: 'complete', expected_updated_at: working.updated_at })).status === 409, 'duplicate_followup_completion_accepted');
      working = await followup(salesA, working, 'schedule', firstDue);
      working = await followup(salesA, working, 'cancel');
      assert(working.next_follow_up_at === null && working.last_follow_up_at === completedAt, 'followup_cancel_changed_completion_history');
      const closed = queueFixtures.find(record => record.status === 'CONFIRMED');
      assert((await salesA.browser.call(`/api/leads/${closed.id}/follow-up`, 'POST', { action: 'schedule', expected_updated_at: closed.updated_at, next_follow_up_at: firstDue })).status === 400, 'closed_lead_followup_scheduled');
      for (const due of ['2027-02-30T10:00:00+08:00', '2027-01-01T10:00']) assert((await salesA.browser.call(`/api/leads/${working.id}/follow-up`, 'POST', { action: 'schedule', expected_updated_at: working.updated_at, next_follow_up_at: due })).status === 400, 'invalid_followup_date_accepted');
      assert((await salesB.browser.call(`/api/leads/${working.id}/follow-up`, 'POST', { action: 'schedule', expected_updated_at: working.updated_at, next_follow_up_at: firstDue })).status === 404, 'sales_cross_lead_followup_allowed');
      assert((await salesA.browser.call(`/api/leads/${working.id}/follow-up`, 'POST', { action: 'schedule', expected_updated_at: working.updated_at, next_follow_up_at: firstDue }, 'https://invalid.example')).status === 403, 'cross_origin_followup_allowed');
    });

    await check('immutable_activity_actor_and_before_after_history', async () => {
      const before = await lead(salesA, working.id);
      working = await patch(salesA, working.id, { notes: 'Updated verification note', status: 'QUALIFYING', human_takeover: true });
      const history = await activities(salesA, working.id);
      const changed = history.find(item => item.changes?.notes?.after === 'Updated verification note');
      assert(changed?.actor_id === salesA.id && changed.actor_label === salesA.label && changed.source === 'staff' && changed.action === 'updated', 'activity_actor_or_source_spoofed');
      assert(changed.changes.notes.before === before.notes && changed.changes.status.before === before.status && changed.changes.status.after === 'QUALIFYING' && changed.changes.human_takeover.before === false && changed.changes.human_takeover.after === true, 'activity_before_after_incorrect');
      assert(history.some(item => item.action === 'created') && history.some(item => item.action === 'follow_up_completed' && item.changes?.next_follow_up_at?.after === null && item.changes?.last_follow_up_at?.after), 'followup_activity_history_missing');
      const allowed = ['assigned_staff_id', 'assigned_staff', 'status', 'notes', 'human_takeover', 'next_follow_up_at', 'last_follow_up_at'];
      assert(history.every(item => item.lead_id === working.id && Object.keys(item.changes).every(key => allowed.includes(key))), 'activity_includes_unapproved_data');
      assert((await salesB.browser.call(`/api/leads/${working.id}/activities`)).status === 404, 'cross_lead_activity_api_exposed');
      assert((await salesA.browser.call(`/api/leads/${working.id}/activities`, 'POST', { actor_id: admin.id })).status === 405, 'activity_write_api_exists');
      assert(denied(await rest('lead_activities', salesAToken, 'POST', { lead_id: working.id, actor_id: admin.id, actor_label: 'Spoof', source: 'staff', action: 'updated', changes: {} })), 'activity_forged_insert_allowed');
      assert(immutableDenied(await serviceResult('rest/v1/lead_activities', 'POST', { lead_id: working.id, actor_id: admin.id, actor_label: 'Spoof', source: 'staff', action: 'updated', changes: {} })), 'service_activity_forged_insert_allowed');
      const filter = `lead_activities?id=eq.${changed.id}`;
      for (const token of [salesAToken, adminToken]) {
        assert(immutableDenied(await rest(filter, token, 'PATCH', { actor_label: 'Spoof' })), 'activity_update_allowed');
        assert(immutableDenied(await rest(filter, token, 'DELETE')), 'activity_delete_allowed');
      }
      assert(immutableDenied(await serviceResult('rest/v1/' + filter, 'PATCH', { actor_label: 'Spoof' })), 'service_activity_update_allowed');
      assert(immutableDenied(await serviceResult('rest/v1/' + filter, 'DELETE')), 'service_activity_delete_allowed');
      const reread = (await activities(salesA, working.id)).find(item => item.id === changed.id);
      assert(rowDigest(reread) === rowDigest(changed), 'immutable_activity_changed');
      const first = await salesA.browser.call(`/api/leads/${working.id}/activities?limit=1`);
      assert(first.status === 200 && first.body.activities.length === 1 && typeof first.body.nextCursor === 'string', 'activity_pagination_first_page_failed');
      const next = await salesA.browser.call(`/api/leads/${working.id}/activities?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`);
      assert(next.status === 200 && next.body.activities.length === 1 && next.body.activities[0].id !== first.body.activities[0].id, 'activity_pagination_repeated_row');
      assert((await salesA.browser.call(`/api/leads/${working.id}/activities?limit=51`)).status === 400 && (await salesA.browser.call(`/api/leads/${working.id}/activities?cursor=invalid`)).status === 400, 'activity_pagination_validation_failed');
      invitedLead = await createLead(invited, 'invited-actor');
      assert((await activities(invited, invitedLead.id))[0]?.actor_label === invited.label, 'invited_staff_actor_label_missing');
    });

    await check('ownership_reassignment_denial_and_activity_rls', async () => {
      assert((await salesA.browser.call(`/api/leads/${working.id}`, 'PATCH', { assigned_staff_id: salesB.id })).status === 403, 'sales_ownership_change_allowed');
      assert((await salesB.browser.call(`/api/leads/${working.id}`)).status === 404, 'cross_lead_detail_exposed');
      const directBefore = await rest(`lead_activities?lead_id=eq.${working.id}&select=id`, salesBToken);
      assert(directBefore.response.ok && directBefore.body.length === 0, 'cross_lead_history_rls_exposed');
      working = await patch(admin, working.id, { assigned_staff_id: salesB.id, assigned_staff: salesB.email });
      assert((await salesA.browser.call(`/api/leads/${working.id}/activities`)).status === 404 && (await salesB.browser.call(`/api/leads/${working.id}/activities`)).status === 200, 'reassignment_history_visibility_failed');
      const assignment = (await activities(salesB, working.id)).find(item => item.changes?.assigned_staff_id?.after === salesB.id);
      assert(assignment?.actor_id === admin.id && assignment.source === 'staff' && assignment.changes.assigned_staff_id.before === salesA.id, 'assignment_audit_incorrect');
      const oldOwner = await rest(`lead_activities?lead_id=eq.${working.id}&select=id`, salesAToken);
      assert(oldOwner.response.ok && oldOwner.body.length === 0, 'former_owner_history_rls_exposed');
      assert(denied(await rest('lead_activities?select=id')), 'anonymous_activity_database_accessible');
      assert(denied(await rest(`leads?id=eq.${working.id}`, salesBToken, 'PATCH', { assigned_staff_id: salesA.id })), 'direct_ownership_reassignment_allowed');
      working = await patch(admin, working.id, { assigned_staff_id: salesA.id, assigned_staff: salesA.email });
      assert((await salesB.browser.call(`/api/leads/${working.id}`)).status === 404, 'former_owner_detail_still_accessible');
    });

    await check('system_and_ai_activity_source_isolation', async () => {
      for (const source of ['v14_verification', 'web_demo']) {
        const data = await service('rest/v1/leads', 'POST', { customer_name: `${marker} source-${source}`, source, service: 'other', status: 'NEW' });
        const record = data[0];
        assert(isUuid(record?.id) && !originalSnapshots.get('leads').rows.has(record.id), 'source_fixture_creation_failed'); leadIds.add(record.id);
        const history = await activities(admin, record.id);
        assert(history[0]?.actor_id === null && history[0]?.source === (source === 'web_demo' ? 'ai' : 'system'), 'service_actor_source_incorrect');
      }
      const impersonation = await createLead(salesA, 'staff-web-source', { source: 'web_demo' });
      const history = await activities(salesA, impersonation.id);
      assert(history[0]?.source === 'staff' && history[0]?.actor_id === salesA.id, 'staff_can_impersonate_ai_actor');
    });

    await check('v14_logout_revokes_new_surface_access', async () => {
      const replay = salesA.browser.cookies.get('tp_staff_session');
      assert((await salesA.browser.call('/api/staff/logout', 'POST', {})).status === 200, 'fixture_logout_failed');
      for (const path of ['/api/followups', `/api/leads/${working.id}/activities`]) assert((await salesA.browser.call(path)).status === 401, 'logout_left_v14_api_access');
      const result = await rest(`lead_activities?lead_id=eq.${working.id}&select=id`, replay);
      assert(denied(result) || (result.response.ok && result.body?.length === 0), 'logout_left_activity_rls_access');
    });
  } catch (error) {
    failure = { check: currentCheck, reason: error instanceof VerificationFailure ? error.code : 'unexpected_verification_error' };
    console.error(`FAIL ${failure.check}: ${failure.reason}`);
  } finally {
    if (configured) {
      currentCheck = 'fixture_cleanup';
      let cleanupFailed = false;
      // Recover IDs only for this run's exact disposable addresses / lead marker.
      // Baseline IDs are excluded even if another record happens to match a label.
      try {
        const hiddenRows = await service(`rest/v1/leads?customer_name=like.${encodeURIComponent(marker + '*')}&select=id`);
        for (const row of hiddenRows) if (isUuid(row.id) && !originalSnapshots.get('leads')?.rows.has(row.id)) leadIds.add(row.id);
      } catch { cleanupFailed = true; }
      try {
        for (const account of await listAuth()) {
          if (typeof account.email === 'string' && account.email.startsWith(`v14-${runId}-`) && account.email.endsWith('@example.invalid') && isUuid(account.id) && !originalAuth.has(account.id)) users.set(account.id, { id: account.id, email: account.email });
        }
      } catch { cleanupFailed = true; }
      for (const id of leadIds) {
        try {
          assert(isUuid(id) && !originalSnapshots.get('leads')?.rows.has(id), 'non_fixture_cleanup_target');
          await service(`rest/v1/messages?lead_id=eq.${id}`, 'DELETE');
          await service(`rest/v1/chat_sessions?lead_id=eq.${id}`, 'DELETE');
          // FK cascade is the only allowed way to remove fixture audit history.
          await service(`rest/v1/leads?id=eq.${id}`, 'DELETE');
          assert((await service(`rest/v1/lead_activities?lead_id=eq.${id}&select=id`)).length === 0, 'fixture_history_cleanup_incomplete');
        } catch { cleanupFailed = true; }
      }
      for (const account of users.values()) {
        try {
          assert(isUuid(account.id) && !originalAuth.has(account.id) && account.email?.startsWith(`v14-${runId}-`) && account.email.endsWith('@example.invalid'), 'non_fixture_account_cleanup_target');
          await service(`auth/v1/admin/users/${account.id}`, 'DELETE');
        } catch { cleanupFailed = true; }
      }
      for (const email of invitationEmails) {
        try { await service(`rest/v1/chat_rate_limits?key=eq.staff-invite-email:${createHash('sha256').update(email).digest('hex')}`, 'DELETE'); }
        catch { cleanupFailed = true; }
      }
      try {
        if (leadIds.size) assert((await service(`rest/v1/leads?id=in.(${[...leadIds].join(',')})&select=id`)).length === 0, 'fixture_lead_cleanup_incomplete');
        const remaining = await listAuth();
        assert(!remaining.some(account => users.has(account.id)), 'fixture_user_cleanup_incomplete');
        if (users.size) assert((await service(`rest/v1/staff_members?user_id=in.(${[...users.keys()].join(',')})&select=user_id`)).length === 0, 'fixture_membership_cleanup_incomplete');
      } catch { cleanupFailed = true; }
      if (cleanupFailed) { failure ||= { check: 'fixture_cleanup', reason: 'disposable_fixture_cleanup_needs_review' }; console.error('FAIL fixture_cleanup: disposable_fixture_cleanup_needs_review'); }
      else { checks.push('fixture_cleanup'); console.log('PASS fixture_cleanup'); }
      try {
        await verifyOriginals(); checks.push('original_data_integrity'); console.log('PASS original_data_integrity');
      } catch {
        failure ||= { check: 'original_data_integrity', reason: 'original_data_integrity_needs_review' }; console.error('FAIL original_data_integrity: original_data_integrity_needs_review');
      }
    }
  }

  const result = { ok: !failure, checks, originalData, ...(failure ? { failure } : {}) };
  console.log(`V14_VERIFICATION_RESULT ${JSON.stringify(result)}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyV14();
  if (!result.ok) process.exitCode = 1;
}
