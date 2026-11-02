# Daily Wellbeing: Fitbit + Auth0 Token Vault + Fireworks

Sign in with Auth0, connect your Google Health account through Token Vault, and use Fireworks to generate wellbeing suggestions from your Fitbit readings. Review the data before choosing to share it with the model.

We use Google Health API v4, the API in the [current Google setup guide](https://developers.google.com/health/setup). We configure a custom `google-health` OAuth2 connection for the Google Cloud credentials used by this sample.

The report includes steps, sleep, moderate and vigorous active minutes, and resting heart rate for the latest completed date, compared with the preceding seven dates. We generate suggestions on request, with no scheduled delivery or health-data database.

## Prerequisites

- Node.js 22.12 or newer and npm. Use Node.js 24 LTS for a new setup.
- An Auth0 tenant with Token Vault, Connected Accounts, and the My Account API.
- A personal Google account linked to a health profile in the Google Health mobile app. Google [does not support linking this profile to a Workspace account](https://support.google.com/googlehealth/answer/14237024).
- A Google Cloud project with Google Health API enabled and a Web application OAuth client.
- A Fireworks key, account credit, and access to a model supporting streaming, forced function calls, and disabled thinking.

We use Next.js 16, Auth0 Next.js SDK 4.33, AI SDK 7, and its Fireworks provider. We render model Markdown with [react-markdown](https://github.com/remarkjs/react-markdown), with raw HTML and remote images disabled. Dependencies are pinned in the lockfile.

## Get the source

```bash
git clone https://github.com/deepu105/fireworks-fitbit-coach.git
cd fireworks-fitbit-coach
npm ci
```

## Set up Auth0 with the CLI

Use this section as an alternative to the Auth0 dashboard steps in sections 2 and 3. Complete the Google setup in section 1 first, or leave the Google credentials empty for mock-only testing. The commands create a new application. Inspect existing applications and connections before repeating them.

Install the [Auth0 CLI](https://github.com/auth0/auth0-cli#installation), then authorize the tenant with the complete set of setup scopes:

```bash
brew install auth0/auth0-cli/auth0 # macOS; see the CLI link for other platforms

auth0 login --scopes 'read:clients,create:clients,update:clients,read:connections,create:connections,update:connections,read:client_grants,create:client_grants,update:client_grants,read:resource_servers,create:resource_servers,update:resource_servers'
```

Select the intended tenant during login. If you reauthorize the CLI later, include the complete setup scope list again. Requesting a different scope list can remove earlier optional scopes from the CLI session.

### Prepare private configuration files

Run the following commands from the sample directory:

```bash
umask 077
export AUTH0_TENANT_DOMAIN='YOUR_TENANT.eu.auth0.com'
export AUTH0_SETUP_DIR="$(mktemp -d /tmp/fireworks-auth0-setup.XXXXXX)"

cat > .env.setup.local <<'ENV'
AUTH0_DOMAIN=YOUR_TENANT.eu.auth0.com
APP_BASE_URL=http://localhost:3000
REPORT_TIME_ZONE=Europe/Amsterdam
GOOGLE_HEALTH_CLIENT_ID=
GOOGLE_HEALTH_CLIENT_SECRET=
ENV
```

Edit `.env.setup.local` with the same tenant hostname and your Google Web OAuth credentials. Leave both Google values empty for mock-only setup. Use your HTTPS application origin in `APP_BASE_URL` when testing on another device. Google still redirects to Auth0's `/login/callback`, and Auth0 redirects to the application's `/auth/callback`.

List the current tenant resources without revealing application secrets:

```bash
auth0 apps list --tenant "$AUTH0_TENANT_DOMAIN" --json
auth0 api get connections --tenant "$AUTH0_TENANT_DOMAIN" \
  --query 'fields=id,name,strategy,authentication,connected_accounts' \
  --query 'per_page=100'
auth0 api get resource-servers --tenant "$AUTH0_TENANT_DOMAIN" \
  --query 'per_page=100' --query 'page=0' \
  > "$AUTH0_SETUP_DIR/resource-servers.json"

node scripts/prepare-auth0-setup.mjs "$AUTH0_SETUP_DIR"
```

If you have more than 100 APIs, collect all pages into a JSON array before running the script. It must see the existing `https://YOUR_TENANT.eu.auth0.com/me/` API to prepare an update. The helper makes no network requests. It preserves existing API scopes, adds the three Connected Accounts scopes, and writes setup files with owner-only permissions. Connection payloads and app-creation responses contain credentials; keep the output directory private.

### Configure the My Account API

If the helper finds an existing My Account API, update that API:

```bash
export MY_ACCOUNT_API_ID="$(cat "$AUTH0_SETUP_DIR/my-account-id.txt")"
auth0 api patch "resource-servers/$MY_ACCOUNT_API_ID" \
  --tenant "$AUTH0_TENANT_DOMAIN" \
  < "$AUTH0_SETUP_DIR/my-account-update.json" \
  > "$AUTH0_SETUP_DIR/my-account-result.json"
```

For a tenant without the API, use the create payload instead:

```bash
auth0 api post resource-servers --tenant "$AUTH0_TENANT_DOMAIN" \
  < "$AUTH0_SETUP_DIR/my-account-create.json" \
  > "$AUTH0_SETUP_DIR/my-account-result.json"
node --input-type=module -e 'import fs from "node:fs"; const r=JSON.parse(fs.readFileSync(process.argv[1])); if(!r.id) throw Error("Check API creation before retrying"); console.log(r.id)' \
  "$AUTH0_SETUP_DIR/my-account-result.json"
```

The payload enables offline access and consent skipping for first-party apps, with user access requiring a client grant. Auth0 feature availability still depends on your tenant. If your tenant requires My Account API activation in the dashboard, activate it there, fetch the API list again, and prepare the update payload. Do not create a second API with another identifier.

### Create the application and user grant

The prepared app includes the three grant types, a non-rotating expiring refresh token, and the My Account MRRT policy. Create it once:

```bash
auth0 api post clients --tenant "$AUTH0_TENANT_DOMAIN" \
  < "$AUTH0_SETUP_DIR/application.json" \
  > "$AUTH0_SETUP_DIR/client.json"
node scripts/prepare-auth0-setup.mjs "$AUTH0_SETUP_DIR"

export SAMPLE_CLIENT_ID="$(node --input-type=module -e 'import fs from "node:fs"; const r=JSON.parse(fs.readFileSync(process.argv[1])); if(!r.client_id) throw Error("No app ID; inspect tenant before retrying"); console.log(r.client_id)' "$AUTH0_SETUP_DIR/client.json")"

auth0 api post client-grants --tenant "$AUTH0_TENANT_DOMAIN" \
  < "$AUTH0_SETUP_DIR/client-grant.json" \
  > "$AUTH0_SETUP_DIR/client-grant-result.json"
```

The grant has `subject_type: "user"` and the `read`, `create`, and `delete` Connected Accounts scopes. The MRRT policy uses the same audience and scopes. An empty CLI response does not prove success. Verify the app or grant exists before retrying a create command. A tenant application limit can also block creation.

### Enable a login connection

Choose an existing database or social login connection ID from the earlier connection list. Enable it for this application:

```bash
export LOGIN_CONNECTION_ID='con_YOUR_LOGIN_CONNECTION'
auth0 api patch "connections/$LOGIN_CONNECTION_ID/clients" \
  --tenant "$AUTH0_TENANT_DOMAIN" \
  < "$AUTH0_SETUP_DIR/connection-binding.json" \
  > "$AUTH0_SETUP_DIR/login-binding-result.json"
```

Use the connection's `/clients` endpoint with the `[{"client_id":"...","status":true}]` payload. This enables the new application without replacing other application bindings.

### Create and enable the health connection

If your tenant has no `google-health` connection, create it from the prepared Google credentials and profile script:

```bash
auth0 api post connections --tenant "$AUTH0_TENANT_DOMAIN" \
  < "$AUTH0_SETUP_DIR/google-health-connection.json" \
  > "$AUTH0_SETUP_DIR/google-health-result.json"

export HEALTH_CONNECTION_ID="$(node --input-type=module -e 'import fs from "node:fs"; const r=JSON.parse(fs.readFileSync(process.argv[1])); if(!r.id) throw Error("Check connection creation before retrying"); console.log(r.id)' "$AUTH0_SETUP_DIR/google-health-result.json")"

auth0 api patch "connections/$HEALTH_CONNECTION_ID/clients" \
  --tenant "$AUTH0_TENANT_DOMAIN" \
  < "$AUTH0_SETUP_DIR/connection-binding.json" \
  > "$AUTH0_SETUP_DIR/health-binding-result.json"
```

For an existing correctly configured `google-health` connection, set `HEALTH_CONNECTION_ID` to its ID and run the binding command. For mock-only setup, skip real connection creation and follow [the mock provider guide](mock-google-health/README.md) after configuring the app.

Verify the non-secret configuration:

```bash
auth0 apps show "$SAMPLE_CLIENT_ID" --tenant "$AUTH0_TENANT_DOMAIN" --json
auth0 api get client-grants --tenant "$AUTH0_TENANT_DOMAIN" \
  --query "client_id=$SAMPLE_CLIENT_ID"
auth0 api get "connections/$LOGIN_CONNECTION_ID/clients" \
  --tenant "$AUTH0_TENANT_DOMAIN"
auth0 api get connections --tenant "$AUTH0_TENANT_DOMAIN" \
  --query 'fields=id,name,strategy,authentication,connected_accounts' \
  --query 'per_page=100'
```

The health connection should show `connected_accounts.active: true`. Its login purpose can remain disabled. Check its `/clients` endpoint for the application binding as well.

### Copy app credentials to the local environment

For a new checkout without an existing `.env`, copy the generated file:

```bash
cp "$AUTH0_SETUP_DIR/app.env" .env
chmod 600 .env
```

The generated file includes the Auth0 client secret and a random session secret. Add your Fireworks key in your editor. If `.env` already exists, merge these settings and preserve your Fireworks key. Do not print `client.json`, `app.env`, or connection payloads in shared logs. Continue with section 4 to start the app.

For another-device testing, add its HTTPS origin to the app's callback, logout, web-origin, and allowed-origin lists, preserving any localhost entries you need. Set `APP_BASE_URL` to that origin and restart `npm run dev`. The sample permits this origin for Next.js development resources, so live reload works through the tunnel.

## 1. Configure Google Health

Follow [Google Health setup](https://developers.google.com/health/setup).

1. Open the Google Health mobile app on your phone. Sign in with the personal Google account and finish creating or linking its health profile.
2. Enable Google Health API in your Google Cloud project. Configure the OAuth consent screen and create a **Web application** OAuth client.
3. Set its authorized redirect URI to `https://YOUR_AUTH0_DOMAIN/login/callback`. Replace the setup guide's example `https://www.google.com` redirect with this Auth0 callback.
4. If the consent screen is External / Testing, add the personal Google account under **Audience > Test users**.
5. Add these three scopes under **Data Access**:

| Scope | Measurements |
| --- | --- |
| `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly` | Steps and active minutes |
| `https://www.googleapis.com/auth/googlehealth.sleep.readonly` | Sleep sessions |
| `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly` | Resting heart rate |

Keep the Google OAuth client ID and secret for the Auth0 connection. Testing-mode Google refresh tokens expire after seven days; reconnect when necessary.

Google provides no prefilled health-data sandbox. Sync a tracker, enable mobile tracking, or add a sleep log in the mobile app. The report excludes today's incomplete date, so add a log for yesterday if you need to test a new account. A successful Google sign-in alone does not create a health profile.

## 2. Configure the Auth0 application

Create an Auth0 **Regular Web Application**:

| Setting | Value |
| --- | --- |
| Allowed Callback URLs | `http://localhost:3000/auth/callback` |
| Allowed Logout URLs | `http://localhost:3000` |
| Allowed Web Origins | `http://localhost:3000` |

Enable a database or social connection for login. Users connect Google Health after signing in, and may use a different Google account for health data.

Under **Advanced Settings > Grant Types**, enable **Authorization Code**, **Refresh Token**, and **Token Vault**. For the setup we tested, disable **Allow Refresh Token Rotation** and use expiring refresh tokens. The CLI payload sets a 30-day lifetime and seven-day idle lifetime. See [Configure Token Vault](https://auth0.com/docs/secure/call-apis-on-users-behalf/token-vault/configure-token-vault#configure-refresh-token-exchange) for the grant configuration.

Follow the [third-party API quickstart](https://auth0.com/ai/docs/get-started/call-third-party-apis-on-users-behalf) to configure the My Account API:

1. Activate **Auth0 My Account API** under **Applications > APIs** if necessary.
2. Authorize the app for **user access** with `read:me:connected_accounts`, `create:me:connected_accounts`, and `delete:me:connected_accounts`.
3. Enable **Allow Skipping User Consent** for this first-party application.
4. Add a **Multi-Resource Refresh Token** policy for the My Account audience and those three scopes.

Use `https://YOUR_AUTH0_DOMAIN/me/` as the audience. The app requests these scopes plus `openid profile email offline_access`.

## 3. Create the Google Health Token Vault connection

Create a **Custom OAuth2** connection in Auth0, using these settings:

| Setting | Value |
| --- | --- |
| Name | `google-health` |
| Client ID / Secret | Your Google Cloud Web application credentials |
| Authorization URL | `https://accounts.google.com/o/oauth2/v2/auth?access_type=offline&prompt=consent` |
| Token URL | `https://oauth2.googleapis.com/token` |
| Scope | The three full Google Health scope URLs above, separated by spaces |
| Fetch User Profile Script | Contents of [scripts/google-health-profile.js](scripts/google-health-profile.js) |
| Purpose | **Connected Accounts for Token Vault** enabled; authentication can stay disabled |

Enable the connection for your web application. For Management API setup, set `connected_accounts: {"active": true}` at the top level of the connection object. An `options.connected_accounts` field alone does not activate this purpose.

The profile script calls `GET https://health.googleapis.com/v4/users/me/identity`. It uses `healthUserId` as the connected-account identifier and rejects accounts without a linked health profile. We check linkage again when retrieving a report.

`access_type=offline` requests Google's refresh token. `prompt=consent` shows the permission screen when the user connects or reviews access. Auth0 stores the upstream credentials in Token Vault.

## 4. Configure the app and Fireworks

```bash
npm ci # or bun install
test -f .env || cp .env.example .env
openssl rand -hex 32
```

Paste the generated secret and your app credentials into `.env`:

```dotenv
AUTH0_DOMAIN=your-tenant.eu.auth0.com
AUTH0_CLIENT_ID=your-client-id
AUTH0_CLIENT_SECRET=your-client-secret
AUTH0_SECRET=your-generated-64-character-hex-secret
APP_BASE_URL=http://localhost:3000
AUTH0_FITBIT_CONNECTION=google-health
REPORT_TIME_ZONE=Europe/Amsterdam
FIREWORKS_API_KEY=your-fireworks-key
FIREWORKS_MODEL=accounts/fireworks/models/kimi-k3
MOCK_GOOGLE_HEALTH=false
```

Create an inference key in the [Fireworks console](https://app.fireworks.ai/settings/users/api-keys). The developer supplies this backend key; end users authorize access to their Google Health accounts. Google OAuth client credentials belong in Auth0, outside the app's environment file.

We verified `accounts/fireworks/models/kimi-k3` with a live streaming request and a forced summary tool on November 2, 2026. We disable thinking so its reasoning does not consume the 1,536-token response budget. Select another compatible model if needed.

Keep environment files out of source control. Restart the server after changing settings.

```bash
npm run dev # or bun run dev
```

Open [http://localhost:3000](http://localhost:3000), sign in, and select **Connect Fitbit**. Consent uses Google Health. You may grant some of the read permissions; the report shows available measurements and explains missing access. Use **Review permissions** to add scopes.

Review the report, select the sharing checkbox, and choose **Generate suggestions**. We refresh the data before inference and show the summary sent to Fireworks. Select the checkbox again for another request.

**Disconnect** removes the connected account from Auth0 and clears the visible report and suggestions. Manage provider authorizations and previously processed data through the provider settings.

## Data and calculation rules

- `REPORT_TIME_ZONE` chooses the cutoff date for this deployment. The default is UTC. Set it for your intended report calendar; we do not fetch a Google profile timezone.
- Google assigns steps and activity to the civil dates recorded with the source data, including travel and daylight saving changes. We preserve those dates rather than rebucketing into the cutoff timezone.
- We call only `/v4/users/me/` paths with the token from the current server session. Browser and model inputs cannot choose an account ID or API URL.
- We check identity, request daily rollups for steps and active minutes, and reconcile sleep and daily resting heart rate. That is five initial API requests with full permissions, plus any additional pages. No report uses a truncated paginated total.
- Active minutes sum `MODERATE` and `VIGOROUS` entries. We exclude light activity and do not apply the weighting used for Active Zone Minutes. Some devices provide only Active Zone Minutes, so active minutes may be missing.
- We sum non-overlapping sleep sessions by their recorded local end date, including naps. If civil end time is absent, we use the recorded end UTC offset. Missing or invalid totals remain unknown.
- We preserve missing measurements as `null` and explicit zeros as zero. Personal averages cover available readings in the preceding seven dates and include the reading count.
- We send normalized dates, measurements, comparison counts, and constructed warnings to Fireworks. We exclude names, emails, provider identifiers, raw logs, sleep stages, and credentials.
- We retain the report and suggestions in browser memory for the visit. Responses use `Cache-Control: no-store, private`.

## Testing

```bash
npm run check
npm run test:browser
node scripts/test-fireworks.mjs
```

`test-fireworks.mjs` makes live model requests with fixture measurements and uses your Fireworks credit. It verifies a forced tool call and a complete streamed answer without reading a health account.

Backend tests cover authentication, origin and sharing checks, Google Health parsing, partial scopes, pagination, account linkage, two-user token isolation, Auth0 SDK requests with mocked HTTP, and model streaming. Browser tests use encrypted test sessions and intercepted provider responses. They do not validate a live account connection.

For a separate OAuth fixture service that exercises real Auth0 and Token Vault, see [mock Google Health setup](mock-google-health/README.md). Production requests require real Auth0 sessions; mock mode never bypasses authentication.

See [verification notes](docs/verification.md) for completed checks and remaining live-account checks.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Google `redirect_uri_mismatch` | Register Auth0's `/login/callback` on the Google Cloud Web OAuth client |
| Google blocks the test account | Add its personal Google account to OAuth test users; Workspace accounts cannot own a health profile |
| `ACCOUNT_NOT_LINKED` | Finish creating/linking the profile in the Google Health mobile app before reconnecting |
| Auth0 callback error | Check the custom connection's profile script, Google API activation, and Google callback URI |
| My Account API denies access | Authorize the app for user access and configure Connected Accounts scopes and its MRRT policy |
| My Account returns `unmet_authentication_requirements` | Sign in again and satisfy the configured My Account API authentication policy |
| Token Vault exchange fails | Enable its grant, request `offline_access`, check the app and session configuration, and sign in again |
| Connection returns no refresh token | Check `access_type=offline` and reconnect with `prompt=consent`; testing-mode Google refresh tokens last seven days |
| Missing sleep or heart rate | Check permissions and synced device data; a new account starts without readings |
| No data for the report date | Sync your device or add a sleep log for the displayed date; today's data is excluded |
| Google Health returns `429` | Wait before refreshing; each report can require five requests plus pagination |
| Fireworks request fails | Check key, model access, credit, streaming, tool calling, and disabled-thinking support |
| POST returns `403` | Use the exact origin in `APP_BASE_URL` |

Before deployment for other users, add per-user API and inference quotas, use HTTPS, complete Google's applicable app review, and review how the providers process health data.

## Files

| File | Purpose |
| --- | --- |
| `src/lib/auth0.ts` | Login and My Account permissions |
| `src/lib/server-api.ts` | Session-bound connection actions |
| `src/lib/fitbit/service.ts` | Account checks and Token Vault retrieval |
| `src/lib/fitbit/report.ts` | Google Health v4 reads and normalization |
| `src/lib/api.ts` | Protected routes, sharing validation, and model tool |
| `scripts/google-health-profile.js` | Auth0 custom connection profile script |
| `mock-google-health/server.mjs` | Separate development OAuth2 and health fixture service |

The health API routes use the `/api/fitbit/` prefix.

## License

MIT. See [LICENSE](LICENSE).
