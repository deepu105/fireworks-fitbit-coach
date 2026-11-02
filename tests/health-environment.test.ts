import { afterEach, expect, it, vi } from "vitest";
import { healthApiOrigin } from "../src/lib/fitbit/environment";
import { getFitbitConnection } from "../src/lib/fitbit/scopes";

afterEach(() => vi.unstubAllEnvs());
it("keeps the real API by default and isolates development mock configuration", () => {
  vi.stubEnv("MOCK_GOOGLE_HEALTH", "false"); vi.stubEnv("AUTH0_FITBIT_CONNECTION", "google-health");
  expect(healthApiOrigin()).toBe("https://health.googleapis.com");
  vi.stubEnv("MOCK_GOOGLE_HEALTH", "true");
  expect(healthApiOrigin()).toBe("http://127.0.0.1:4013");expect(getFitbitConnection()).toBe("mock-google-health");
  vi.stubEnv("NODE_ENV", "production");
  expect(() => healthApiOrigin()).toThrow("Disable MOCK_GOOGLE_HEALTH");
  expect(() => getFitbitConnection()).toThrow("Disable MOCK_GOOGLE_HEALTH");
});
