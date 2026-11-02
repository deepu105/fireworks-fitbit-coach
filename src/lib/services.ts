import "server-only";
import { getAuth0 } from "./auth0";
import { createFitbitService } from "./fitbit/service";
import { healthApiOrigin } from "./fitbit/environment";
import { getFitbitConnection } from "./fitbit/scopes";

export function getFitbitService() {
  const auth0 = getAuth0();
  const connection = getFitbitConnection();
  return createFitbitService({
    connection, apiOrigin: healthApiOrigin(),
    getAccounts: () => auth0.getConnectedAccounts(),
    // The SDK performs Token Vault exchange using this request's session.
    getToken: async () => (await auth0.getAccessTokenForConnection({ connection })).token,
  });
}
