export class ConfigurationError extends Error {}

const auth0Variables = [
  "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET", "APP_BASE_URL",
] as const;

export function missingAuth0Variables() {
  return auth0Variables.filter((name) => !process.env[name]?.trim());
}

export function getAuth0Config() {
  if (missingAuth0Variables().length) {
    throw new ConfigurationError("Complete the Auth0 settings in .env.local.");
  }
  const domain = process.env.AUTH0_DOMAIN!.trim();
  const tenant = new URL(domain.startsWith("https://") ? domain : `https://${domain}`);
  const app = new URL(process.env.APP_BASE_URL!);
  if (tenant.protocol !== "https:" || tenant.username || tenant.password ||
      tenant.pathname !== "/" || tenant.search || tenant.hash) {
    throw new ConfigurationError("AUTH0_DOMAIN must be an Auth0 tenant hostname.");
  }
  if (!["http:", "https:"].includes(app.protocol) || app.username || app.password ||
      app.pathname !== "/" || app.search || app.hash ||
      (app.protocol === "http:" && !["localhost", "127.0.0.1"].includes(app.hostname))) {
    throw new ConfigurationError("Use HTTPS for APP_BASE_URL, or HTTP on localhost.");
  }
  if (!/^[a-fA-F0-9]{64}$/.test(process.env.AUTH0_SECRET!)) {
    throw new ConfigurationError("Generate AUTH0_SECRET with openssl rand -hex 32.");
  }
  return { tenantOrigin: tenant.origin, appOrigin: app.origin };
}
