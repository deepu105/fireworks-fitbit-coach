import { mockHealthEnabled } from "./environment";

// Fitbit data now uses Google Health API v4 and Google OAuth credentials.
const prefix = "https://www.googleapis.com/auth/googlehealth";
export const ACTIVITY_SCOPE = `${prefix}.activity_and_fitness.readonly`;
export const SLEEP_SCOPE = `${prefix}.sleep.readonly`;
export const METRICS_SCOPE = `${prefix}.health_metrics_and_measurements.readonly`;
export const FITBIT_SCOPES = [ACTIVITY_SCOPE, SLEEP_SCOPE, METRICS_SCOPE];

export function getFitbitConnection() {
  if (mockHealthEnabled()) return "mock-google-health";
  return process.env.AUTH0_FITBIT_CONNECTION?.trim() || "google-health";
}
