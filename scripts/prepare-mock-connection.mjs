// Generate a protected JSON payload; this script does not change Auth0.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { scopes } from '../mock-google-health/server.mjs';
process.loadEnvFile('.env.mock.local');
const origin = new URL(process.argv[2]);
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Supply the mock provider HTTPS origin.');
const clientId = process.env.MOCK_HEALTH_CLIENT_ID, clientSecret = process.env.MOCK_HEALTH_CLIENT_SECRET;
if (!clientId || !clientSecret) throw new Error('Configure .env.mock.local first.');
const profile = readFileSync(new URL('./google-health-profile.js', import.meta.url), 'utf8').replace('https://health.googleapis.com/v4/users/me/identity', `${origin.origin}/v4/users/me/identity`);
const payload = { name: 'mock-google-health', strategy: 'oauth2', authentication: { active: false }, connected_accounts: { active: true }, options: {
  client_id: clientId, client_secret: clientSecret, authorizationURL: `${origin.origin}/authorize`, tokenURL: `${origin.origin}/token`, scope: scopes.join(' '), scripts: { fetchUserProfile: profile },
} };
const output = process.argv[3] ?? '/tmp/mock-google-health-connection.json';
writeFileSync(output, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
chmodSync(output, 0o600);
console.log(`Prepared ${output}. It contains mock OAuth credentials; keep it out of source control.`);
