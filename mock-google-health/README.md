# Mock Google Health provider

Use this fixture service after verifying the real Google connection, or while developing without a tracker. It implements OAuth2 and the Google Health v4 endpoints this sample reads.

You still sign in through real Auth0, save a Connected Account, and retrieve the upstream token through Token Vault. The mock provider generates the health readings. Fireworks uses your real backend key when you select **Generate suggestions**.

The provider supports two fixture accounts, explicit consent, partial read permissions, expiring single-use authorization codes, optional S256 PKCE, issued bearer tokens, and rotating refresh tokens. Arbitrary bearer tokens cannot read the fixtures. Keep this service limited to development; the app and provider reject mock mode in production.

## 1. Start the provider

From the sample root:

```bash
umask 077
cp mock-google-health/.env.example .env.mock.local
openssl rand -hex 32
```

Edit `.env.mock.local`. Paste the generated value as the fixture-service secret, and set the exact Auth0 callback:

```dotenv
MOCK_HEALTH_CLIENT_ID=mock-google-health-client
MOCK_HEALTH_CLIENT_SECRET=your-generated-fixture-secret
MOCK_HEALTH_CALLBACK=https://YOUR_AUTH0_DOMAIN/login/callback
MOCK_HEALTH_TOKEN_SECONDS=60
```

This secret belongs to the fixture OAuth client. Use a separate value from your Auth0 client secret, session secret, and Fireworks key.

```bash
node mock-google-health/server.mjs
```

The server listens at `http://127.0.0.1:4013`. It keeps tokens in memory. After restarting it, reconnect the fixture account in the app. The default access token lifetime is 60 seconds, which exercises Token Vault refresh during testing. Refresh tokens expire after one day and rotate after use.

## 2. Expose the provider to Auth0

Auth0 must reach the provider's authorization, token, and identity endpoints over HTTPS. Use a development tunnel, for example:

```bash
ngrok http http://127.0.0.1:4013 --inspect=false
```

Keep this tunnel separate from any tunnel exposing the Next.js app on port 3000. If your ngrok agent permits only one agent session, configure both endpoints in that agent. Keep request inspection disabled so the tunnel does not retain OAuth tokens or health responses.

Copy the mock provider's HTTPS origin. Generate the private connection payload:

```bash
export MOCK_PROVIDER_ORIGIN='https://YOUR_MOCK_PROVIDER_TUNNEL'
node scripts/prepare-mock-connection.mjs \
  "$MOCK_PROVIDER_ORIGIN" /tmp/mock-google-health-connection.json
```

The generator writes a custom OAuth2 connection named `mock-google-health`. It sets `connected_accounts.active` at the top level, disables its login purpose, and adjusts the profile script to call the fixture identity endpoint. It does not change Auth0.

## 3. Create and bind the Auth0 connection

Complete the [main README's CLI setup](../README.md#set-up-auth0-with-the-cli) first. These commands reuse its `AUTH0_TENANT_DOMAIN`, `AUTH0_SETUP_DIR`, and `SAMPLE_CLIENT_ID` variables and private binding file. If using the dashboard setup instead, create the same binding JSON with your application ID.

Check for an existing connection before creating another:

```bash
auth0 api get connections --tenant "$AUTH0_TENANT_DOMAIN" \
  --query 'fields=id,name,strategy,authentication,connected_accounts' \
  --query 'per_page=100'
```

For a new mock connection:

```bash
umask 077
auth0 api post connections --tenant "$AUTH0_TENANT_DOMAIN" \
  < /tmp/mock-google-health-connection.json \
  > "$AUTH0_SETUP_DIR/mock-connection-result.json"

export MOCK_CONNECTION_ID="$(node --input-type=module -e 'import fs from "node:fs"; const r=JSON.parse(fs.readFileSync(process.argv[1])); if(!r.id) throw Error("Check tenant before retrying creation"); console.log(r.id)' "$AUTH0_SETUP_DIR/mock-connection-result.json")"

auth0 api patch "connections/$MOCK_CONNECTION_ID/clients" \
  --tenant "$AUTH0_TENANT_DOMAIN" \
  < "$AUTH0_SETUP_DIR/connection-binding.json" \
  > "$AUTH0_SETUP_DIR/mock-binding-result.json"

auth0 api get "connections/$MOCK_CONNECTION_ID/clients" \
  --tenant "$AUTH0_TENANT_DOMAIN"
```

An existing connection can keep its ID and application binding. If its provider tunnel changes, regenerate the connection payload, prepare an update containing its `options`, `authentication`, and `connected_accounts` fields, and PATCH that connection. Do not POST a duplicate. Reconnect fixture accounts after restarting the provider.

## 4. Switch the app to fixture data

In the app's `.env`, set:

```dotenv
MOCK_GOOGLE_HEALTH=true
```

Keep `AUTH0_FITBIT_CONNECTION=google-health`. Mock mode selects `mock-google-health` and the loopback health API without changing the real connection configuration. It leaves Auth0 login and Token Vault enabled.

Restart `npm run dev`, then use your existing app URL. For phone testing, keep the app's HTTPS tunnel and `APP_BASE_URL` configuration from the main README. The health provider and app use separate public origins; server-side fixture reads use loopback.

1. Sign in with Auth0. The app displays a **Test data** banner.
2. Select **Connect Fitbit**. On **Mock Google Health**, choose **Alice**, **Normal readings**, and all three read scopes.
3. Select **Allow fixture access**. Auth0 saves the connected account and returns to the app.
4. Check the cards: 4,300 steps, 6h 5m sleep, 20 active minutes, and 63 bpm resting heart rate. Alice's preceding seven dates average 7,000 steps, 7h 25m sleep, 30 active minutes, and 60 bpm.
5. Select the sharing checkbox and **Generate suggestions**. This calls real Fireworks with the fixture summary. Confirm the complete answer refers to the displayed readings and the checkbox clears afterward.
6. Wait at least 60 seconds and select **Refresh data**. Check that Token Vault refreshes the expired upstream token.

Provider counters contain no credentials:

```bash
curl -fsS http://127.0.0.1:4013/healthz
```

A completed connection increments `consentDecisions` and `codeExchanges`. Reports increment `healthReads`. After expiry, another successful report should increment `refreshExchanges`.

## Scenarios

Use **Review permissions** to return to the mock consent screen. Select a fixture scenario, or deselect read scopes to test partial permission handling. Reauthorizing the same fixture account updates its authorization. To switch between Alice and Bob, select **Disconnect** first, then connect the other account. The app rejects multiple connected health accounts.

| Choice | Expected result |
| --- | --- |
| Alice, normal | 4,300 report-day steps; 7,000 prior average |
| Bob, normal | 2,300 report-day steps; 5,000 prior average |
| Missing sleep | Sleep remains unknown; other measurements load |
| No data | Authorization remains saved; app explains the absence of recent readings |
| Account not linked | Profile validation rejects the connection |
| Rate limited | Report explains that health data could not be retrieved |
| Deselect sleep permission | App skips sleep requests and offers permission review |
| Deny | No new authorization; app shows a connection failure |

Sleep and heart-rate responses use two pages to exercise pagination. Automated HTTP tests cover both fixture identities, token binding, authorization-code expiry and reuse, token refresh rotation, partial scopes, and the normalizer. Two fixture accounts alone do not prove live isolation between two Auth0 users; that needs two separate Auth0 sessions.

## Return to real Google Health

Set `MOCK_GOOGLE_HEALTH=false`, then restart the development server. The app returns to `google-health` and `https://health.googleapis.com`. Its real and mock connected accounts remain separate. Switching mode does not disconnect either account or delete provider authorizations.
