// Development-only OAuth2 provider and Google Health v4 fixtures.
// Adapted from auth0-travel0/apps/mock-google. Requires issued bearer tokens.
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

export const scopes = ['activity_and_fitness', 'sleep', 'health_metrics_and_measurements'].map((name) => `https://www.googleapis.com/auth/googlehealth.${name}.readonly`);
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const dateString = (d) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
const civil = (date) => { const [year, month, day] = date.split('-').map(Number); return { year, month, day }; };
const shift = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export function createMockHealthServer({ clientId, clientSecret, callback, accessTokenSeconds = 60, now = () => Date.now() }) {
  if (!clientId || !clientSecret || !callback) throw new Error('Set mock client credentials and the exact Auth0 callback.');
  const pending = new Map(), codes = new Map(), access = new Map(), refresh = new Map();
  const stats = { consentDecisions: 0, codeExchanges: 0, refreshExchanges: 0, healthReads: 0 };
  function issue(user, scope, scenario) {
    const token = random(), rt = random();
    const entry = { user, scope, scenario, expires: now() + accessTokenSeconds * 1000 };
    access.set(token, entry); refresh.set(rt, { ...entry, expires: now() + 86400000 });
    return { access_token: token, token_type: 'Bearer', expires_in: accessTokenSeconds, refresh_token: rt, scope: scope.join(' ') };
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' });res.end(JSON.stringify(body)); };
    const redirect = (url) => { res.writeHead(303, { Location: url.toString() });res.end(); };
    try {
      const url = new URL(req.url, 'http://mock.invalid');
      if (url.pathname === '/healthz') return json(200, { service: 'mock-google-health', fixtureData: true, ...stats });
      let body = '';
      if (req.method === 'POST') {
        for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return json(413, { error: 'request_too_large' }); }
      }
      if (url.pathname === '/authorize' && req.method === 'GET') {
        const p = url.searchParams;
        const requested = (p.get('scope') ?? '').split(/\s+/).filter(Boolean);
        if (p.get('client_id') !== clientId || p.get('redirect_uri') !== callback || p.get('response_type') !== 'code') return json(400, { error: 'invalid_request' });
        if (!requested.length || requested.some((s) => !scopes.includes(s))) return json(400, { error: 'invalid_scope' });
        if (p.has('code_challenge') && p.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' });
        const ticket = random();
        pending.set(ticket, { state: p.get('state') ?? '', scope: [...new Set(requested)], challenge: p.get('code_challenge'), expires: now() + 300000 });
        // A form-action restriction also checks the app redirect after Auth0.
        // The server binds OAuth redirects to the exact registered callback.
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
        return res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Mock Google Health consent</title><style>body{font:16px system-ui;max-width:650px;margin:50px auto;padding:20px}label{display:block;margin:16px 0}button,select{font:inherit;padding:8px}code{font-size:12px;overflow-wrap:anywhere}</style><h1>Mock Google Health</h1><p>This test provider uses generated readings. It does not access a Google account.</p><form action="/authorize/decision" method="post"><input type="hidden" name="ticket" value="${ticket}"><label>Fixture account <select name="user"><option value="alice">Alice</option><option value="bob">Bob</option></select></label><label>Data scenario <select name="scenario"><option value="normal">Normal readings</option><option value="missing-sleep">Missing sleep</option><option value="no-data">No data</option><option value="unlinked">Account not linked</option><option value="rate-limit">Rate limited</option></select></label>${requested.map((s) => `<label><input type="checkbox" name="scope" value="${escape(s)}" checked> Read ${escape(s.split('googlehealth.')[1].replace('.readonly', '').replaceAll('_', ' '))}</label>`).join('')}<button name="decision" value="deny">Deny</button> <button name="decision" value="allow">Allow fixture access</button></form></html>`);
      }
      if (url.pathname === '/authorize/decision' && req.method === 'POST') {
        const form = new URLSearchParams(body), ticket = form.get('ticket');
        const entry = pending.get(ticket); pending.delete(ticket);
        if (!entry || entry.expires <= now()) return json(400, { error: 'invalid_request' });
        const target = new URL(callback); target.searchParams.set('state', entry.state);
        const granted = [...new Set(form.getAll('scope'))];
        if (form.get('decision') !== 'allow' || !granted.length) { target.searchParams.set('error', 'access_denied');return redirect(target); }
        if (granted.some((s) => !entry.scope.includes(s))) return json(400, { error: 'invalid_scope' });
        const user = form.get('user'), scenario = form.get('scenario');
        if (!['alice', 'bob'].includes(user) || !['normal', 'missing-sleep', 'no-data', 'unlinked', 'rate-limit'].includes(scenario)) return json(400, { error: 'invalid_request' });
        const code = random(); codes.set(code, { ...entry, scope: granted, user, scenario, expires: now() + 60000 });++stats.consentDecisions;
        target.searchParams.set('code', code);return redirect(target);
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = req.headers['content-type']?.includes('application/json') ? new URLSearchParams(JSON.parse(body)) : new URLSearchParams(body);
        let id = form.get('client_id'), secret = form.get('client_secret');
        if (req.headers.authorization?.startsWith('Basic ')) {
          const raw = Buffer.from(req.headers.authorization.slice(6), 'base64').toString();const colon = raw.indexOf(':');
          id ??= decodeURIComponent(raw.slice(0, colon));secret ??= decodeURIComponent(raw.slice(colon + 1));
        }
        if (!equal(id, clientId) || !equal(secret, clientSecret)) return json(401, { error: 'invalid_client' });
        if (form.get('grant_type') === 'authorization_code') {
          const code = form.get('code'), entry = codes.get(code);codes.delete(code);
          if (!entry || entry.expires <= now() || form.get('redirect_uri') !== callback || (entry.challenge && createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== entry.challenge)) return json(400, { error: 'invalid_grant' });
          ++stats.codeExchanges;return json(200, issue(entry.user, entry.scope, entry.scenario));
        }
        if (form.get('grant_type') === 'refresh_token') {
          const rt = form.get('refresh_token'), entry = refresh.get(rt);
          if (!entry || entry.expires <= now()) return json(400, { error: 'invalid_grant' });
          refresh.delete(rt);++stats.refreshExchanges;return json(200, issue(entry.user, entry.scope, entry.scenario));
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (!url.pathname.startsWith('/v4/users/me/')) return json(404, { error: 'not_found' });
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1], account = access.get(token);
      if (!account || account.expires <= now()) return json(401, { error: { status: 'UNAUTHENTICATED' } });
      ++stats.healthReads;
      if (account.scenario === 'unlinked') return json(400, { error: { status: 'FAILED_PRECONDITION', details: [{ reason: 'ACCOUNT_NOT_LINKED' }] } });
      if (url.pathname.endsWith('/identity')) return json(200, { name: 'users/me/identity', healthUserId: `mock-health-${account.user}` });
      const type = url.pathname.match(/\/dataTypes\/([^/]+)\/dataPoints:(dailyRollUp|reconcile)$/);
      if (!type) return json(404, { error: 'not_found' });
      const [ , dataType, operation] = type;
      const required = dataType === 'sleep' ? scopes[1] : dataType === 'daily-resting-heart-rate' ? scopes[2] : scopes[0];
      if (!account.scope.includes(required)) return json(403, { error: { status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } });
      if (account.scenario === 'rate-limit') return json(429, { error: { status: 'RESOURCE_EXHAUSTED' } });
      const values = account.user === 'alice' ? [6000, 7000, 6500, 8000, 7500, 7200, 6800, 4300] : [4000, 5000, 4500, 6000, 5500, 5200, 4800, 2300];
      let start, end;
      if (operation === 'dailyRollUp') { if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });const query = JSON.parse(body);start = dateString(query.range.start.date);end = dateString(query.range.end.date);if (query.windowSizeDays !== 1) return json(400, { error: 'invalid_argument' }); }
      else { const match = url.searchParams.get('filter')?.match(/>= "(\d{4}-\d{2}-\d{2})" AND .* < "(\d{4}-\d{2}-\d{2})"/);if (!match) return json(400, { error: 'invalid_argument' });[ , start, end] = match; }
      const count = (Date.parse(end) - Date.parse(start)) / 86400000;
      if (!Number.isInteger(count) || count < 1 || count > 14) return json(400, { error: 'invalid_argument' });
      const dates = Array.from({ length: count }, (_, i) => shift(start, i));
      if (account.scenario === 'no-data') return json(200, {});
      if (operation === 'dailyRollUp') {
        if (!['steps', 'active-minutes'].includes(dataType)) return json(400, { error: 'invalid_argument' });
        return json(200, { rollupDataPoints: dates.map((date, i) => ({ civilStartTime: { date: civil(date), time: {} }, civilEndTime: { date: civil(shift(date, 1)), time: {} },
          ...(dataType === 'steps' ? { steps: { countSum: String(values[i % 8]) } } : { activeMinutes: { activeMinutesRollupByActivityLevel: [{ activityLevel: 'MODERATE', activeMinutesSum: i === count - 1 ? '10' : '15' }, { activityLevel: 'VIGOROUS', activeMinutesSum: i === count - 1 ? '10' : '15' }] } }),
        })).reverse() });
      }
      const all = dataType === 'sleep' ? account.scenario === 'missing-sleep' ? [] : dates.map((date, i) => ({ sleep: { interval: { startTime: `${date}T00:00:00Z`, endTime: `${date}T08:00:00Z`, endUtcOffset: '3600s', civilEndTime: { date: civil(date), time: { hours: 9 } } }, summary: { minutesAsleep: i === count - 1 ? '365' : '445' } } })) : dates.map((date, i) => ({ dailyRestingHeartRate: { date: civil(date), beatsPerMinute: i === count - 1 ? '63' : '60' } }));
      // Two pages exercise the application's pagination during live mock E2E.
      const index = url.searchParams.get('pageToken') === 'page-2' ? 4 : 0;
      return json(200, { dataPoints: all.slice(index, index + 4), ...(index === 0 && all.length > 4 ? { nextPageToken: 'page-2' } : {}) });
    } catch { return json(400, { error: 'invalid_request' }); }
  });
  return { server, stats };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.NODE_ENV === 'production') throw new Error('The mock provider cannot run in production mode.');
  if (existsSync('.env.mock.local')) process.loadEnvFile('.env.mock.local');
  const { server } = createMockHealthServer({ clientId: process.env.MOCK_HEALTH_CLIENT_ID, clientSecret: process.env.MOCK_HEALTH_CLIENT_SECRET, callback: process.env.MOCK_HEALTH_CALLBACK, accessTokenSeconds: Number(process.env.MOCK_HEALTH_TOKEN_SECONDS ?? 60) });
  server.listen(4013, '127.0.0.1', () => console.log('Mock Google Health listening on http://127.0.0.1:4013 (fixture data only).'));
}
