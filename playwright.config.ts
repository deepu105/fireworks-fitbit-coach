import { defineConfig } from "@playwright/test";
import { testSecret } from "./tests/session";

export const testOrigin = "http://127.0.0.1:3088";
export const testTenant = "https://fixture.auth0.invalid";

export default defineConfig({
  testDir: "./tests/browser", fullyParallel: false, workers: 1,
  use: { baseURL: testOrigin, channel: "chrome", trace: "retain-on-failure", viewport: { width: 1280, height: 1000 } },
  reporter: "list",
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3088",
    url: testOrigin, reuseExistingServer: false, timeout: 60_000,
    env: {
      NEXT_TEST_DIST_DIR: ".next-browser", MOCK_GOOGLE_HEALTH: "false",
      AUTH0_DOMAIN: "fixture.auth0.invalid", AUTH0_CLIENT_ID: "fixture-client", AUTH0_CLIENT_SECRET: "fixture-secret",
      AUTH0_SECRET: testSecret, APP_BASE_URL: testOrigin, AUTH0_FITBIT_CONNECTION: "google-health", FIREWORKS_API_KEY: "", FIREWORKS_MODEL: "",
    },
  },
});
