import { describe, expect, it } from "vitest";
import { fetchFitbitReport, latestCompleteDay } from "../src/lib/fitbit/report";
import { createFitbitService } from "../src/lib/fitbit/service";
import { ACTIVITY_SCOPE, FITBIT_SCOPES, SLEEP_SCOPE } from "../src/lib/fitbit/scopes";
import { civilDate, dates, fitbitFetch, now, setup, sleepPoint } from "./fixtures";

const signal = new AbortController().signal;
const reportOptions = { token: "private-fitbit-token", signal, now, timeZone: "Europe/Amsterdam" };

describe("Google Health v4 report", () => {
  it("uses an explicit cutoff timezone across date boundaries and daylight saving changes", () => {
    expect(latestCompleteDay(new Date("2026-10-29T00:30:00Z"), "America/Los_Angeles")).toBe("2026-10-27");
    expect(latestCompleteDay(new Date("2026-10-25T01:30:00Z"), "Europe/Amsterdam")).toBe("2026-10-24");
    expect(latestCompleteDay(new Date("2026-01-01T01:30:00Z"), "UTC")).toBe("2025-12-31");
    expect(() => latestCompleteDay(now, "not-a-timezone")).toThrow("valid IANA timezone");
  });

  it("normalizes documented v4 decimal strings, reverse ordered rollups and distinct activity levels", async () => {
    const apiFetch = fitbitFetch();
    const report = await fetchFitbitReport({ ...reportOptions, fetch: apiFetch });
    expect(report.date).toBe("2026-10-28");
    expect(report.latest).toEqual({ date: "2026-10-28", steps: 4300, activeMinutes: 20, sleepMinutes: 365, restingHeartRate: 63 });
    expect(report.baseline.steps).toEqual({ value: 7000, days: 7 });
    expect(report.baseline.sleepMinutes).toEqual({ value: 445, days: 7 });
    expect(report.days).toHaveLength(8);
    expect(apiFetch).toHaveBeenCalledTimes(5);
    for (const [input, init] of apiFetch.mock.calls) {
      expect(String(input)).toContain("https://health.googleapis.com/v4/users/me/");
      expect(init).toMatchObject({ headers: { Authorization: "Bearer private-fitbit-token" }, cache: "no-store", redirect: "error" });
      if (init?.method === "POST") expect(JSON.parse(String(init.body))).toMatchObject({ range: { start: { date: civilDate(dates[0]) }, end: { date: civilDate("2026-10-29") } }, windowSizeDays: 1 });
    }
    for (const value of ["Private Alice", "private-fitbit-id", "private-log-id", "private-legacy-id", "stages", "private-fitbit-token"]) expect(JSON.stringify(report)).not.toContain(value);
  });

  it("counts missing sleep as unknown and averages only the available days", async () => {
    const apiFetch = fitbitFetch(), normal = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (input, init) => String(input).includes("/sleep/") ? Response.json({ dataPoints: [sleepPoint(dates[0], 420), sleepPoint(dates[1], 480)] }) : normal(input, init));
    const report = await fetchFitbitReport({ ...reportOptions, fetch: apiFetch });
    expect(report.latest.sleepMinutes).toBeNull();
    expect(report.baseline.sleepMinutes).toEqual({ value: 450, days: 2 });
  });

  it("keeps explicit zero steps and rejects null, negative and unsafe int64 readings", async () => {
    const apiFetch = fitbitFetch(), normal = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (input, init) => String(input).includes("/steps/") ? Response.json({ rollupDataPoints: dates.map((date, index) => ({ civilStartTime: { date: civilDate(date) }, steps: { countSum: index === 7 ? "0" : [null, "-1", "9007199254740992"][index % 3] } })) }) : normal(input, init));
    const report = await fetchFitbitReport({ ...reportOptions, fetch: apiFetch });
    expect(report.latest.steps).toBe(0);
    expect(report.baseline.steps).toEqual({ value: null, days: 0 });
  });

  it("requires a linked health profile even after valid Google OAuth consent", async () => {
    const apiFetch = fitbitFetch();
    apiFetch.mockResolvedValue(Response.json({ error: { status: "FAILED_PRECONDITION", details: [{ reason: "ACCOUNT_NOT_LINKED" }] } }, { status: 400 }));
    await expect(fetchFitbitReport({ ...reportOptions, fetch: apiFetch })).rejects.toMatchObject({ code: "ACCOUNT_NOT_LINKED", status: 409 });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 429])("surfaces Google Health %i rather than reporting misleading partial results", async (status) => {
    const apiFetch = fitbitFetch(), normal = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (input, init) => String(input).includes("/sleep/") ? Response.json({ error: {} }, { status }) : normal(input, init));
    await expect(fetchFitbitReport({ ...reportOptions, fetch: apiFetch })).rejects.toMatchObject({ status: status === 429 ? 429 : 409 });
  });

  it("retains permitted metrics when sleep consent is missing or revoked", async () => {
    for (const revoked of [false, true]) {
      const apiFetch = fitbitFetch(), normal = apiFetch.getMockImplementation()!;
      apiFetch.mockImplementation(async (input, init) => String(input).includes("/sleep/") && revoked ? Response.json({ error: {} }, { status: 403 }) : normal(input, init));
      const report = await fetchFitbitReport({ ...reportOptions, fetch: apiFetch, scopes: revoked ? FITBIT_SCOPES : [ACTIVITY_SCOPE] });
      expect(report.latest.steps).toBe(4300);
      expect(report.latest.sleepMinutes).toBeNull();
      expect(report.warnings.join(" ")).toContain(revoked ? "Sleep access was denied" : "Sleep permission was not granted");
      if (!revoked) expect(apiFetch.mock.calls.some(([input]) => String(input).includes("/sleep/"))).toBe(false);
    }
  });

  it("distinguishes disabled API configuration from a missing data permission", async () => {
    const apiFetch = fitbitFetch(), normal = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (input, init) => String(input).includes("/sleep/") ? Response.json({ error: { details: [{ reason: "SERVICE_DISABLED" }] } }, { status: 403 }) : normal(input, init));
    await expect(fetchFitbitReport({ ...reportOptions, fetch: apiFetch })).rejects.toMatchObject({ code: "GOOGLE_HEALTH_NOT_ENABLED", status: 503 });
  });

  it("follows sleep pagination with unchanged date filters", async () => {
    const apiFetch = fitbitFetch(), normal = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (input, init) => String(input).includes("/sleep/") ? Response.json(new URL(String(input)).searchParams.has("pageToken") ? { dataPoints: [sleepPoint(dates[7], 365)] } : { dataPoints: [sleepPoint(dates[0], 440)], nextPageToken: "opaque-page-token" }) : normal(input, init));
    const report = await fetchFitbitReport({ ...reportOptions, fetch: apiFetch });
    expect(report.latest.sleepMinutes).toBe(365);
    const calls = apiFetch.mock.calls.filter(([input]) => String(input).includes("/sleep/"));
    expect(calls).toHaveLength(2);
    expect(new URL(String(calls[0][0])).searchParams.get("filter")).toBe(new URL(String(calls[1][0])).searchParams.get("filter"));
    expect(JSON.stringify(report)).not.toContain("opaque-page-token");
  });

  it("excludes an entire incomplete dataset when a page token repeats", async () => {
    const apiFetch = fitbitFetch(), normal = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (input, init) => String(input).includes("/sleep/") ? Response.json({ dataPoints: [sleepPoint(dates[7], 300)], nextPageToken: "repeated" }) : normal(input, init));
    const report = await fetchFitbitReport({ ...reportOptions, fetch: apiFetch });
    expect(report.latest.sleepMinutes).toBeNull();
    expect(report.warnings.join(" ")).toContain("Sleep data was unavailable");
  });

  it("derives a sleep end date from its recorded offset if civil time is absent", async () => {
    const apiFetch = fitbitFetch(), normal = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (input, init) => String(input).includes("/sleep/") ? Response.json({ dataPoints: [{ sleep: { interval: { startTime: "2026-10-28T16:00:00Z", endTime: "2026-10-29T00:30:00Z", endUtcOffset: "-28800s" }, summary: { minutesAsleep: "400" } } }] }) : normal(input, init));
    expect((await fetchFitbitReport({ ...reportOptions, fetch: apiFetch })).latest.sleepMinutes).toBe(400);
  });

  it("does not fabricate readings when the linked account has no data", async () => {
    const apiFetch = fitbitFetch(), normal = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (input, init) => String(input).endsWith("/identity") ? normal(input, init) : Response.json({}));
    await expect(fetchFitbitReport({ ...reportOptions, fetch: apiFetch })).rejects.toMatchObject({ code: "NO_RECENT_DATA", status: 422 });
  });

  it("excludes overlapping sleep sessions and duplicate daily step buckets", async () => {
    const apiFetch = fitbitFetch(), normal = apiFetch.getMockImplementation()!;
    apiFetch.mockImplementation(async (input, init) => String(input).includes("/sleep/") ? Response.json({ dataPoints: [sleepPoint(dates[7], 400), sleepPoint(dates[7], 300)] }) : String(input).includes("/steps/") ? Response.json({ rollupDataPoints: [1, 2].map(() => ({ civilStartTime: { date: civilDate(dates[7]) }, steps: { countSum: "2000" } })) }) : normal(input, init));
    const report = await fetchFitbitReport({ ...reportOptions, fetch: apiFetch });
    expect(report.latest.sleepMinutes).toBeNull(); expect(report.latest.steps).toBeNull();
    expect(report.warnings.join(" ")).toContain("Overlapping or invalid sleep");
    expect(report.warnings.join(" ")).toContain("Duplicate steps");
  });
});

describe("session-bound health connection", () => {
  it("requires a connected account and at least one health permission before token exchange", async () => {
    const context = setup();
    for (const accounts of [[], [{ connection: "google-health", scopes: ["openid"] }]]) {
      context.getAccounts.mockResolvedValue(accounts);
      expect((await context.api.report(new Request("http://localhost/api/fitbit/report"))).status).toBe(409);
      expect(context.getToken).not.toHaveBeenCalled(); expect(context.apiFetch).not.toHaveBeenCalled();
    }
    context.getAccounts.mockResolvedValue([{ connection: "google-health", scopes: [SLEEP_SCOPE] }]);
    expect((await context.api.report(new Request("http://localhost/api/fitbit/report"))).status).toBe(200);
  });

  it("does not arbitrarily select one of several health accounts", async () => {
    const context = setup();
    context.getAccounts.mockResolvedValue([{ connection: "google-health", scopes: FITBIT_SCOPES }, { connection: "google-health", scopes: FITBIT_SCOPES }]);
    const response = await context.api.report(new Request("http://localhost/api/fitbit/report"));
    expect(response.status).toBe(409); expect(await response.text()).toContain("MULTIPLE_ACCOUNTS");
    expect(context.getToken).not.toHaveBeenCalled();
  });

  it("does not reuse tokens between services bound to different sessions", async () => {
    const apiFetch = fitbitFetch();
    for (const token of ["alice-fitbit-token", "bob-fitbit-token"]) {
      const service = createFitbitService({ connection: "google-health", getAccounts: async () => [{ connection: "google-health", scopes: FITBIT_SCOPES }], getToken: async () => token, fetch: apiFetch, now: () => now });
      await service.report(signal);
    }
    expect(apiFetch.mock.calls.slice(0, 5).every(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer alice-fitbit-token")).toBe(true);
    expect(apiFetch.mock.calls.slice(5).every(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer bob-fitbit-token")).toBe(true);
  });
});
