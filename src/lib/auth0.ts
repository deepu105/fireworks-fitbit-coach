import "server-only";
import { Auth0Client } from "@auth0/nextjs-auth0/server";
import { NextResponse } from "next/server";
import { getAuth0Config } from "./config";

let client: Auth0Client | undefined;

export function getAuth0() {
  const { tenantOrigin, appOrigin } = getAuth0Config();
  client ??= new Auth0Client({
    domain: tenantOrigin,
    appBaseUrl: appOrigin,
    authorizationParameters: {
      audience: `${tenantOrigin}/me/`,
      scope: "openid profile email offline_access read:me:connected_accounts create:me:connected_accounts delete:me:connected_accounts",
    },
    enableAccessTokenEndpoint: false,
    // The application uses a same-origin POST with a fixed Fitbit connection.
    enableConnectAccountEndpoint: false,
    onCallback: async (error) => NextResponse.redirect(new URL(error ? "/?auth_error=1" : "/", appOrigin)),
  });
  return client;
}
