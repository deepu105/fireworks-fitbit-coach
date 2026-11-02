import { createFireworks } from "@ai-sdk/fireworks";
import { vi } from "vitest";
import { createApi } from "../src/lib/api";
import { createFitbitService } from "../src/lib/fitbit/service";
import { FITBIT_SCOPES } from "../src/lib/fitbit/scopes";

export const origin = "http://localhost:3000";
export const now = new Date("2026-10-29T09:30:00Z");
export const dates = Array.from({ length: 8 }, (_, index) => `2026-10-${21 + index}`);
export const steps = [6000, 7000, 6500, 8000, 7500, 7200, 6800, 4300];
export const sleep = [440, 450, 460, 430, 455, 445, 435, 365];

export function civilDate(date: string) {
  const [year, month, day] = date.split("-").map(Number); return { year, month, day };
}
export function sleepPoint(date: string, minutes: number) {
  return { dataPointName: "private-log-id", sleep: { interval: {
    startTime: `${date}T00:00:00Z`, endTime: `${date}T12:00:00Z`,
    endUtcOffset: "3600s", civilEndTime: { date: civilDate(date), time: { hours: 13 } },
  }, summary: { minutesAsleep: String(minutes) }, stages: [{ private: true }] } };
}
export function fitbitFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/identity")) return Response.json({ name: "users/me/identity", healthUserId: "private-fitbit-id", legacyUserId: "private-legacy-id" });
    if (path.includes("/steps/")) return Response.json({ rollupDataPoints: dates.map((date, index) => ({ civilStartTime: { date: civilDate(date) }, steps: { countSum: String(steps[index]) }, name: "Private Alice" })).reverse() });
    if (path.includes("/active-minutes/")) return Response.json({ rollupDataPoints: dates.map((date, index) => ({ civilStartTime: { date: civilDate(date) }, activeMinutes: { activeMinutesRollupByActivityLevel: [
      { activityLevel: "MODERATE", activeMinutesSum: index === 7 ? "10" : "15" }, { activityLevel: "VIGOROUS", activeMinutesSum: index === 7 ? "10" : "15" }, { activityLevel: "LIGHT", activeMinutesSum: "120" },
    ] } })) });
    if (path.includes("/sleep/")) return Response.json({ dataPoints: dates.map((date, index) => sleepPoint(date, sleep[index])) });
    if (path.includes("/daily-resting-heart-rate/")) return Response.json({ dataPoints: dates.map((date, index) => ({ dailyRestingHeartRate: { date: civilDate(date), beatsPerMinute: index === 7 ? "63" : "60" } })) });
    throw new Error(`Unexpected fixture request: ${path}`);
  });
}

export function makeRequest(path = "/api/advice", body: unknown = { shareWithFireworks: true }, from = origin) {
  return new Request(`${origin}${path}`, { method: "POST", headers: { Origin: from, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export function setup(options: { providerError?: boolean } = {}) {
  const apiFetch = fitbitFetch();
  const getAccounts = vi.fn(async () => [{ connection: "google-health", scopes: FITBIT_SCOPES }]);
  const getToken = vi.fn(async () => "private-fitbit-token");
  const service = createFitbitService({ connection: "google-health", getAccounts, getToken, fetch: apiFetch, now: () => now });
  const providerRequests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const providerFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    providerRequests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (options.providerError) return Response.json({ error: { message: "private-provider-diagnostic private-fireworks-key" } }, { status: 401 });
    const first = providerRequests.length === 1;
    const chunks = first ? [
      { choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-fitbit", type: "function", function: { name: "getDailyFitbitSummary", arguments: "{}" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ] : [
      { choices: [{ index: 0, delta: { role: "assistant", content: "On October 28, you recorded 4,300 steps and 6h 5m of sleep. Try a short walk and a consistent bedtime today." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", ...chunk })}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  const getSession = vi.fn(async (): Promise<{ user: { sub: string } } | null> => ({ user: { sub: "auth0|alice" } }));
  const getModel = vi.fn(() => createFireworks({ apiKey: "private-fireworks-key", fetch: providerFetch })("test-model"));
  const connect = vi.fn(async () => new Response(null, { status: 307, headers: { Location: "https://tenant.example.test/connect", "Set-Cookie": "transaction=encrypted; HttpOnly" } }));
  const disconnect = vi.fn(async () => {});
  const dependencies = { getSession, getAppOrigin: () => origin, status: service.status, report: service.report, connect, disconnect, getModel };
  return { api: createApi(dependencies), dependencies, apiFetch, getAccounts, getToken, getModel, getSession, providerRequests, connect, disconnect };
}
