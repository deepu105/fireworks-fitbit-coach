import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { FITBIT_SCOPES } from "../src/lib/fitbit/scopes";
import { encryptedSession, testScopes, testSecret } from "./session";

const tenant = "https://vault.example.test";
const app = "http://localhost:3000";

function setup() {
  const exchanges: URLSearchParams[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, init });
    if (url === `${tenant}/.well-known/openid-configuration`) return Response.json({ issuer: `${tenant}/`, authorization_endpoint: `${tenant}/authorize`, token_endpoint: `${tenant}/oauth/token`, jwks_uri: `${tenant}/.well-known/jwks.json`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
    if (url === `${tenant}/oauth/token`) {
      const params = new URLSearchParams(String(init?.body));
      exchanges.push(params);
      const owner = params.get("subject_token")?.split("-")[0];
      return Response.json({ access_token: `${owner}-fitbit-access`, token_type: "Bearer", expires_in: 3600, scope: FITBIT_SCOPES.join(" ") });
    }
    if (url === `${tenant}/me/v1/connected-accounts/connect`) return Response.json({ connect_uri: `${tenant}/connect`, connect_params: { ticket: "fixture-ticket" }, auth_session: "fixture-auth-session", expires_in: 300 });
    if (url === `${tenant}/me/v1/connected-accounts/accounts`) return Response.json({ accounts: [{ id: "account-fixture", connection: "google-health", access_type: "offline", scopes: FITBIT_SCOPES }] });
    if (url === `${tenant}/me/v1/connected-accounts/accounts/account-fixture` && init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected mocked Auth0 request: ${url}`);
  });
  const client = new Auth0Client({
    domain: tenant, clientId: "fixture-client", clientSecret: "fixture-secret", secret: testSecret, appBaseUrl: app,
    authorizationParameters: { audience: `${tenant}/me/`, scope: testScopes }, customFetch: transport,
    enableAccessTokenEndpoint: false,
  });
  return { client, exchanges, requests };
}
async function request(subject: string) {
  return new NextRequest(`${app}/api/fitbit/report`, { headers: { Cookie: `__session=${await encryptedSession(subject, tenant)}` } });
}

describe("actual Auth0 SDK with mocked Token Vault and My Account HTTP", () => {
  it("exchanges each user's own refresh token for Fitbit and persists only encrypted cookies", async () => {
    const { client, exchanges } = setup();
    for (const subject of ["alice", "bob"]) {
      const response = new NextResponse();
      const result = await client.getAccessTokenForConnection({ connection: "google-health" }, await request(subject), response);
      expect(result.token).toBe(`${subject}-fitbit-access`);
      const cookies = response.headers.get("set-cookie");
      expect(cookies).toContain("__FC");
      expect(cookies).not.toContain(`${subject}-fitbit-access`);
    }
    expect(exchanges.map((params) => params.get("subject_token"))).toEqual(["alice-auth0-refresh", "bob-auth0-refresh"]);
    for (const params of exchanges) {
      expect(params.get("grant_type")).toBe("urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token");
      expect(params.get("subject_token_type")).toBe("urn:ietf:params:oauth:token-type:refresh_token");
      expect(params.get("connection")).toBe("google-health");
    }
  });

  it("initiates a Fitbit connection with PKCE and the required read scopes", async () => {
    const { client, requests } = setup();
    const response = await client.connectAccount({ connection: "google-health", scopes: FITBIT_SCOPES, returnTo: "/" }, await request("alice"));
    expect(response.headers.get("location")).toBe(`${tenant}/connect?ticket=fixture-ticket`);
    expect(response.headers.get("set-cookie")).toContain("__txn_");
    const call = requests.find((call) => call.url.endsWith("/connected-accounts/connect"))!;
    expect(await new Response(call.init?.body).json()).toMatchObject({ connection: "google-health", scopes: FITBIT_SCOPES, redirect_uri: `${app}/auth/callback`, code_challenge_method: "S256" });
  });

  it("lists and disconnects Fitbit through the user's My Account API", async () => {
    const { client, requests } = setup();
    const accounts = await client.getConnectedAccounts(await request("alice"), new NextResponse());
    expect(accounts[0]).toMatchObject({ connection: "google-health", scopes: FITBIT_SCOPES });
    await client.disconnectAccount({ connection: "google-health" }, await request("alice"), new NextResponse());
    expect(requests).toContainEqual(expect.objectContaining({ url: `${tenant}/me/v1/connected-accounts/accounts/account-fixture`, init: expect.objectContaining({ method: "DELETE" }) }));
    for (const call of requests.filter((call) => call.url.includes("/me/"))) {
      expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer alice-auth0-access");
    }
  });
});
