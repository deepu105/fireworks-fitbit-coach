import { PublicError } from "../http";
import { FITBIT_SCOPES } from "./scopes";
import { fetchFitbitReport } from "./report";

export type Account = { connection: string; scopes?: string[] };
export function connectionStatus(accounts: Account[], connection: string) {
  const matches = accounts.filter((account) => account.connection === connection);
  const connected = matches.length === 1;
  const needsPermissions = connected && !FITBIT_SCOPES.some((scope) => matches[0].scopes?.includes(scope));
  return { connected, needsPermissions, multipleAccounts: matches.length > 1 };
}

export function createFitbitService(dependencies: {
  connection: string;
  getAccounts: () => Promise<Account[]>;
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  now?: () => Date;
  apiOrigin?: string;
}) {
  return {
    status: async () => connectionStatus(await dependencies.getAccounts(), dependencies.connection),
    report: async (signal: AbortSignal) => {
      const accounts = await dependencies.getAccounts();
      const status = connectionStatus(accounts, dependencies.connection);
      if (status.multipleAccounts) throw new PublicError("MULTIPLE_ACCOUNTS", "Disconnect Fitbit, then connect the one account you want to use.", 409);
      if (!status.connected) throw new PublicError("CONNECT_FITBIT", "Connect Google Health to read your Fitbit data.", 409);
      if (status.needsPermissions) throw new PublicError("HEALTH_PERMISSIONS_REQUIRED", "Connect Google Health and grant at least one of the requested read permissions.", 409);
      let token: string;
      try { token = await dependencies.getToken(); }
      catch { throw new PublicError("RECONNECT_REQUIRED", "The Fitbit token could not be retrieved. Reconnect Fitbit or sign in again.", 409); }
      if (!token) throw new PublicError("RECONNECT_REQUIRED", "Reconnect Fitbit to read your data.", 409);
      return fetchFitbitReport({ token, signal, apiOrigin: dependencies.apiOrigin, fetch: dependencies.fetch, now: dependencies.now?.(), scopes: accounts.find((account) => account.connection === dependencies.connection)?.scopes });
    },
  };
}
