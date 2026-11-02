import { ConfigurationError } from "../config";

export function mockHealthEnabled() {
  const enabled = process.env.MOCK_GOOGLE_HEALTH === "true";
  if (enabled && process.env.NODE_ENV === "production") throw new ConfigurationError("Disable MOCK_GOOGLE_HEALTH in production.");
  return enabled;
}
export function healthApiOrigin() {
  return mockHealthEnabled() ? "http://127.0.0.1:4013" : "https://health.googleapis.com";
}
