import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createMockHealthServer, scopes } from '../mock-google-health/server.mjs';
import { fetchFitbitReport } from '../src/lib/fitbit/report';

const callback = 'https://tenant.example.test/login/callback';
const servers = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections();await new Promise((resolve) => server.close(resolve)); } });
async function setup() {
  let time = Date.parse('2026-10-29T09:30:00Z');
  const { server, stats } = createMockHealthServer({ clientId: 'test-client', clientSecret: 'test-secret', callback, accessTokenSeconds: 60, now: () => time });
  servers.push(server);await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tokenRequest = (body) => fetch(`${origin}/token`, { method: 'POST', body: new URLSearchParams({ client_id: 'test-client', client_secret: 'test-secret', ...body }) });
  async function authorize({ user = 'alice', scenario = 'normal', granted = scopes, challenge } = {}) {
    const params = new URLSearchParams({ client_id: 'test-client', redirect_uri: callback, response_type: 'code', scope: scopes.join(' '), state: 'test-state', ...(challenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}) });
    const page = await fetch(`${origin}/authorize?${params}`);expect(page.status).toBe(200);
    const ticket = (await page.text()).match(/name="ticket" value="([^"]+)"/)[1];
    const body = new URLSearchParams({ ticket, decision: 'allow', user, scenario });
    for (const scope of granted) body.append('scope', scope);
    const consent = await fetch(`${origin}/authorize/decision`, { method: 'POST', body, redirect: 'manual' });
    const redirect = new URL(consent.headers.get('location'));expect(redirect.searchParams.get('state')).toBe('test-state');
    return redirect.searchParams.get('code');
  }
  async function tokens(options) { const code = await authorize(options);const response = await tokenRequest({ grant_type: 'authorization_code', redirect_uri: callback, code });expect(response.status).toBe(200);return response.json(); }
  return { origin, stats, tokenRequest, authorize, tokens, advance: () => { time += 61000; } };
}

describe('mock provider through real local HTTP', () => {
  it('rejects arbitrary bearer tokens and unregistered OAuth redirects', async () => {
    const { origin } = await setup();
    expect((await fetch(`${origin}/v4/users/me/identity`, { headers: { Authorization: 'Bearer arbitrary-token' } })).status).toBe(401);
    const query = new URLSearchParams({ client_id: 'test-client', response_type: 'code', redirect_uri: 'https://attacker.example/callback', scope: scopes.join(' ') });
    expect((await fetch(`${origin}/authorize?${query}`)).status).toBe(400);
  });
  it('binds single-use authorization codes to PKCE, checks expiry, and rotates refresh tokens', async () => {
    const context = await setup();
    const verifier = 'fixture-verifier';
    const code = await context.authorize({ challenge: createHash('sha256').update(verifier).digest('base64url') });
    const payload = { grant_type: 'authorization_code', redirect_uri: callback, code, code_verifier: verifier };
    const response = await context.tokenRequest(payload);expect(response.status).toBe(200);
    const first = await response.json();
    expect((await context.tokenRequest(payload)).status).toBe(400);
    context.advance();
    expect((await fetch(`${context.origin}/v4/users/me/identity`, { headers: { Authorization: `Bearer ${first.access_token}` } })).status).toBe(401);
    const refreshed = await context.tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token });expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).access_token).not.toBe(first.access_token);
    expect((await context.tokenRequest({ grant_type: 'refresh_token', refresh_token: first.refresh_token })).status).toBe(400);
    expect(context.stats.refreshExchanges).toBe(1);
  });
  it('runs the real report normalizer with issued tokens, paginated v4 responses, and distinct account data', async () => {
    const context = await setup();
    for (const [user, steps] of [['alice', 4300], ['bob', 2300]]) {
      const tokens = await context.tokens({ user });
      const report = await fetchFitbitReport({ token: tokens.access_token, apiOrigin: context.origin, signal: AbortSignal.timeout(5000), now: new Date('2026-10-29T09:30:00Z'), timeZone: 'Europe/Amsterdam' });
      expect(report.latest.steps).toBe(steps);expect(report.latest.sleepMinutes).toBe(365);
      expect(report.days).toHaveLength(8);expect(report.warnings.join(' ')).toContain('test readings');
      expect(JSON.stringify(report)).not.toContain(`mock-health-${user}`);
    }
    expect(context.stats.healthReads).toBe(14);
  });
  it('enforces partial permissions and returns explicit unlinked-account errors', async () => {
    const context = await setup();
    const partial = await context.tokens({ granted: [scopes[0]] });
    expect((await fetch(`${context.origin}/v4/users/me/dataTypes/sleep/dataPoints:reconcile`, { headers: { Authorization: `Bearer ${partial.access_token}` } })).status).toBe(403);
    const unlinked = await context.tokens({ scenario: 'unlinked' });
    const response = await fetch(`${context.origin}/v4/users/me/identity`, { headers: { Authorization: `Bearer ${unlinked.access_token}` } });
    expect(response.status).toBe(400);expect(await response.text()).toContain('ACCOUNT_NOT_LINKED');
  });
});
