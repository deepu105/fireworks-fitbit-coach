import "server-only";
import { createApi } from "./api";
import { getAuth0 } from "./auth0";
import { getAuth0Config } from "./config";
import { getFireworksModel } from "./fireworks";
import { FITBIT_SCOPES, getFitbitConnection } from "./fitbit/scopes";
import { getFitbitService } from "./services";

export const api = createApi({
  getSession: () => getAuth0().getSession(),
  getAppOrigin: () => getAuth0Config().appOrigin,
  status: () => getFitbitService().status(),
  report: (signal) => getFitbitService().report(signal),
  connect: (request) => getAuth0().connectAccount({
    connection: getFitbitConnection(), scopes: FITBIT_SCOPES, returnTo: "/",
  }, request),
  disconnect: () => getAuth0().disconnectAccount({ connection: getFitbitConnection() }),
  getModel: getFireworksModel,
});
