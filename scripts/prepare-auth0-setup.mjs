// Prepare Management API payloads and local app settings. No network requests.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.loadEnvFile('.env.setup.local');
const directory = process.argv[2];
if (!directory || !isAbsolute(directory)) throw new Error('Supply an absolute private output directory.');
const domain = process.env.AUTH0_DOMAIN?.trim();
if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) throw new Error('Set AUTH0_DOMAIN to the tenant hostname, without a URL scheme.');
const origin = new URL(process.env.APP_BASE_URL || 'http://localhost:3000');
if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname)))) {
  throw new Error('APP_BASE_URL must be an HTTPS origin or HTTP localhost origin.');
}
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
function write(name, data) {
  const path = join(directory, name);
  writeFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}
function read(name) { return JSON.parse(readFileSync(join(directory, name), 'utf8')); }
const scopes = ['read:me:connected_accounts', 'create:me:connected_accounts', 'delete:me:connected_accounts'];
const audience = `https://${domain}/me/`;
const listed = read('resource-servers.json');
const resources = Array.isArray(listed) ? listed : listed.resource_servers;
if (!Array.isArray(resources)) throw new Error('Expected the resource server list in resource-servers.json. Check the CLI response.');
const matches = resources.filter((resource) => resource.identifier === audience);
if (matches.length > 1) throw new Error('Multiple My Account APIs found. Review the tenant before continuing.');
const existing = matches[0];
const combinedScopes = [...(existing?.scopes || [])];
for (const value of scopes) if (!combinedScopes.some((scope) => scope.value === value)) combinedScopes.push({ value, description: value });
const apiSettings = {
  scopes: combinedScopes, allow_offline_access: true, skip_consent_for_verifiable_first_party_clients: true,
  subject_type_authorization: {
    ...(existing?.subject_type_authorization || {}),
    client: { ...(existing?.subject_type_authorization?.client || {}), policy: 'deny_all' },
    user: { ...(existing?.subject_type_authorization?.user || {}), policy: 'require_client_grant' },
  },
};
if (existing) {
  write('my-account-update.json', apiSettings);
  write('my-account-id.txt', existing.id + '\n');
} else {
  write('my-account-create.json', { name: 'My Account', identifier: audience, signing_alg: 'RS256', token_lifetime: 86400, token_lifetime_for_web: 7200, ...apiSettings });
}
write('application.json', {
  name: 'Fireworks Fitbit Daily Wellbeing', app_type: 'regular_web', is_first_party: true, oidc_conformant: true,
  token_endpoint_auth_method: 'client_secret_post', callbacks: [`${origin.origin}/auth/callback`],
  allowed_logout_urls: [origin.origin], web_origins: [origin.origin], allowed_origins: [origin.origin],
  grant_types: ['authorization_code', 'refresh_token', 'urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token'],
  refresh_token: { rotation_type: 'non-rotating', expiration_type: 'expiring', infinite_token_lifetime: false,
    infinite_idle_token_lifetime: false, leeway: 0, token_lifetime: 2592000, idle_token_lifetime: 604800,
    policies: [{ audience, scope: scopes }] },
});
const googleId = process.env.GOOGLE_HEALTH_CLIENT_ID, googleSecret = process.env.GOOGLE_HEALTH_CLIENT_SECRET;
if (Boolean(googleId) !== Boolean(googleSecret)) throw new Error('Set both Google OAuth credentials, or leave both empty for mock-only setup.');
if (googleId && googleSecret) {
  write('google-health-connection.json', {
    name: 'google-health', strategy: 'oauth2', authentication: { active: false }, connected_accounts: { active: true },
    options: { client_id: googleId, client_secret: googleSecret,
      authorizationURL: 'https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent',
      tokenURL: 'https://oauth2.googleapis.com/token',
      scope: ['activity_and_fitness', 'sleep', 'health_metrics_and_measurements'].map((name) => `https://www.googleapis.com/auth/googlehealth.${name}.readonly`).join(' '),
      scripts: { fetchUserProfile: readFileSync(new URL('./google-health-profile.js', import.meta.url), 'utf8') },
    },
  });
}
if (existsSync(join(directory, 'client.json'))) {
  const client = read('client.json');
  if (!client.client_id || !client.client_secret) throw new Error('Expected a successful app-creation response in client.json. Do not retry creation before checking the tenant.');
  write('client-grant.json', { client_id: client.client_id, audience, scope: scopes, subject_type: 'user' });
  write('connection-binding.json', [{ client_id: client.client_id, status: true }]);
  const env = { AUTH0_DOMAIN: domain, AUTH0_CLIENT_ID: client.client_id, AUTH0_CLIENT_SECRET: client.client_secret,
    AUTH0_SECRET: randomBytes(32).toString('hex'), APP_BASE_URL: origin.origin, AUTH0_FITBIT_CONNECTION: 'google-health',
    REPORT_TIME_ZONE: process.env.REPORT_TIME_ZONE || 'UTC', FIREWORKS_API_KEY: '', FIREWORKS_MODEL: 'accounts/fireworks/models/kimi-k3', MOCK_GOOGLE_HEALTH: 'false' };
  write('app.env', Object.entries(env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n');
}
console.log(`Prepared private setup files in ${directory}. My Account API: ${existing ? 'update existing' : 'create if not already activated'}. No Auth0 changes made.`);
