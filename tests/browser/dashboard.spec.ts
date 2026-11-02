import { mkdir } from "node:fs/promises";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import type { FitbitReport } from "../../src/lib/fitbit/report";
import { encryptedSession } from "../session";
import { testOrigin, testTenant } from "../../playwright.config";

const days = Array.from({ length: 8 }, (_, index) => ({ date: `2026-10-${21 + index}`, steps: index === 7 ? 4300 : [6000, 7000, 6500, 8000, 7500, 7200, 6800][index], activeMinutes: index === 7 ? 20 : 30, sleepMinutes: index === 7 ? 365 : 445, restingHeartRate: index === 7 ? 63 : 60 }));
const report: FitbitReport = {
  date: "2026-10-28", timeZone: "Europe/Amsterdam", generatedAt: "2026-10-29T09:30:00Z", latest: days[7], days, warnings: [],
  baseline: { steps: { value: 7000, days: 7 }, activeMinutes: { value: 30, days: 7 }, sleepMinutes: { value: 445, days: 7 }, restingHeartRate: { value: 60, days: 7 } },
};

async function signIn(context: BrowserContext) {
  await context.addCookies([{ name: "__session", value: await encryptedSession("alice", testTenant), url: testOrigin, httpOnly: true, sameSite: "Lax" }]);
}
async function mockData(page: Page, connected = true, currentReport = report) {
  await page.route("**/api/fitbit/status", (route) => route.fulfill({ json: { connected, needsPermissions: false, multipleAccounts: false } }));
  await page.route("**/api/fitbit/report", (route) => connected ? route.fulfill({ json: currentReport }) : route.fulfill({ status: 409, json: { code: "CONNECT_FITBIT", error: "Connect Google Health." } }));
}
function adviceStream(content?: string) {
  const chunks = [
    { type: "start", messageId: "fixture-advice" }, { type: "start-step" },
    { type: "tool-input-available", toolCallId: "read-fitbit", toolName: "getDailyFitbitSummary", input: {} },
    { type: "tool-output-available", toolCallId: "read-fitbit", output: report },
    { type: "finish-step" }, { type: "start-step" },
    { type: "text-start", id: "advice" },
    { type: "text-delta", id: "advice", delta: content ?? "## Your October 28 summary\n\nYou recorded 4,300 steps, below your seven-day average of 7,000. Your sleep log shows 6h 5m, compared with a recent average of 7h 25m.\n\n### Try today\n\n- Take a short, comfortable walk when you have a break.\n- Aim for a consistent bedtime tonight.\n\n### Data limits\n\nThese are wearable estimates. A missing reading does not mean zero activity or sleep." },
    { type: "text-end", id: "advice" }, { type: "finish-step" }, { type: "finish", finishReason: "stop" },
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}

test("signed-out visitors see Auth0 login and API calls require a session", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in with Auth0" })).toHaveAttribute("href", "/auth/login");
  for (const path of ["status", "report"]) expect((await request.get(`/api/fitbit/${path}`)).status()).toBe(401);
  for (const path of ["connect", "disconnect"]) expect((await request.post(`/api/fitbit/${path}`)).status()).toBe(401);
  expect((await request.post("/api/advice", { data: { shareWithFireworks: true } })).status()).toBe(401);
  expect((await request.get("/auth/access-token")).status()).toBe(404);
});

test("signed-in users connect Fitbit with a POST to the fixed connection route", async ({ page, context }) => {
  await signIn(context); await mockData(page, false); await page.goto("/");
  await expect(page.getByRole("button", { name: "Connect Fitbit" })).toBeVisible();
  await expect(page.locator('form[action="/api/fitbit/connect"]')).toHaveAttribute("method", "post");
  await expect(page.getByRole("heading", { name: "Your daily summary will appear here" })).toBeVisible();
});

test("data loads without inference; sharing is required to generate and disconnect clears health data", async ({ page, context }) => {
  await signIn(context); await mockData(page);
  let inferenceCalls = 0;
  await page.route("**/api/advice", async (route) => {
    ++inferenceCalls;
    expect(route.request().postDataJSON()).toEqual({ shareWithFireworks: true });
    await route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" }, body: adviceStream() });
  });
  await page.route("**/api/fitbit/disconnect", (route) => route.fulfill({ json: { disconnected: true } }));
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Steps", exact: true })).toContainText("4,300");
  await expect(page.getByRole("region", { name: "Sleep", exact: true })).toContainText("6h 5m");
  await expect(page.getByRole("button", { name: "Generate suggestions" })).toBeDisabled();
  expect(inferenceCalls).toBe(0);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Generate suggestions" }).click();
  await expect(page.getByRole("log", { name: "Daily suggestions" })).toContainText("Take a short, comfortable walk");
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  expect(inferenceCalls).toBe(1);
  await mkdir("docs/screenshots", { recursive: true });
  await page.screenshot({ path: "docs/screenshots/dashboard.png", fullPage: true });
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect Fitbit" })).toBeVisible();
  await expect(page.getByText("4,300", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("log")).toHaveCount(0);
});

test("missing sleep is shown as no data on mobile without horizontal page overflow", async ({ page, context }) => {
  await signIn(context);
  await page.setViewportSize({ width: 390, height: 844 });
  const missingSleepDays = report.days.map((day) => day.date === report.date ? { ...day, sleepMinutes: null } : day);
  await mockData(page, true, { ...report, latest: missingSleepDays[7], days: missingSleepDays });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Sleep", exact: true })).toContainText("No data");
  await page.getByText("View daily readings", { exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await mkdir("docs/screenshots", { recursive: true });
  await page.screenshot({ path: "docs/screenshots/mobile.png", fullPage: true });
});

test("provider errors allow a new attempt with fresh sharing consent", async ({ page, context }) => {
  await signIn(context); await mockData(page);
  let attempts = 0;
  await page.route("**/api/advice", async (route) => {
    if (++attempts === 1) return route.fulfill({ status: 502, json: { error: "Fireworks is unavailable. Try again." } });
    return route.fulfill({ headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" }, body: adviceStream() });
  });
  await page.goto("/");
  await page.getByRole("checkbox").check(); await page.getByRole("button", { name: "Generate suggestions" }).click();
  await expect(page.getByRole("alert", { name: "Advice error" })).toContainText("Fireworks is unavailable");
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByRole("checkbox").check(); await page.getByRole("button", { name: "Generate suggestions" }).click();
  await expect(page.getByRole("log")).toContainText("Take a short, comfortable walk");
  expect(attempts).toBe(2);
});

test("the actual route checks the SDK session and consent before accessing Token Vault", async ({ context }) => {
  await signIn(context);
  const response = await context.request.post("/api/advice", { headers: { Origin: testOrigin }, data: { shareWithFireworks: false } });
  expect(response.status()).toBe(400);
  expect(await response.text()).toContain("CONSENT_REQUIRED");
  await context.clearCookies();
  await context.addCookies([{ name: "__session", value: "tampered", url: testOrigin }]);
  expect((await context.request.post("/api/advice", { headers: { Origin: testOrigin }, data: { shareWithFireworks: true } })).status()).toBe(401);
});


test("report-loading failures clear Checking and offer a working retry", async ({ page, context }) => {
  await signIn(context);
  let attempts = 0;
  await page.route("**/api/fitbit/report", (route) => ++attempts === 1 ?
    route.fulfill({ status: 502, json: { error: "Connection status is unavailable. Try again." } }) :
    route.fulfill({ status: 409, json: { code: "CONNECT_FITBIT", error: "Connect Google Health." } }));
  await page.goto("/");
  await expect(page.getByRole("alert", { name: "Fitbit error" })).toContainText("Connection status is unavailable");
  await expect(page.getByText("Checking", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry connection check" }).click();
  await expect(page.getByRole("button", { name: "Connect Fitbit" })).toBeVisible();
});


test("initial report loads once across rerenders and a manual refresh still works", async ({ page, context }) => {
  await signIn(context);
  let reportCalls = 0, statusCalls = 0;
  await page.route("**/api/fitbit/status", (route) => { ++statusCalls; return route.fulfill({ json: { connected: true } }); });
  await page.route("**/api/fitbit/report", (route) => { ++reportCalls; return route.fulfill({ json: report }); });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Steps", exact: true })).toContainText("4,300");
  await page.getByRole("checkbox").check();await page.getByRole("checkbox").uncheck();
  expect(reportCalls).toBe(1);expect(statusCalls).toBe(0);
  await page.getByRole("button", { name: "Refresh data" }).click();
  await expect(page.getByRole("button", { name: "Refresh data" })).toBeEnabled();
  expect(reportCalls).toBe(2);
});

test("an Auth0 rate limit shows retry and the next successful check loads data", async ({ page, context }) => {
  await signIn(context);
  let calls = 0;
  await page.route("**/api/fitbit/report", (route) => ++calls === 1 ?
    route.fulfill({ status: 429, json: { code: "AUTH0_RATE_LIMIT", error: "Auth0's request limit was reached. Wait a moment, then retry the connection check." } }) :
    route.fulfill({ json: report }));
  await page.goto("/");
  await expect(page.getByRole("alert", { name: "Fitbit error" })).toContainText("Auth0's request limit");
  await page.getByRole("button", { name: "Retry connection check" }).click();
  await expect(page.getByRole("region", { name: "Steps", exact: true })).toContainText("4,300");
  await expect(page.getByRole("alert", { name: "Fitbit error" })).toHaveCount(0);
});


test("model Markdown renders headings and lists without HTML execution or remote images", async ({ page, context }) => {
  await signIn(context); await mockData(page);
  const markdown = [
    "## Daily review", "**4,300** steps.", "- Take a comfortable walk\n- Keep a consistent bedtime",
    '<script>window.modelHtmlRan = true</script>', '<img src="https://markdown-image.invalid/raw.png" onerror="window.modelHtmlRan = true">',
    "![Generated image](https://markdown-image.invalid/image.png)",
    "[Unsafe](javascript:alert(1)) [App action](/auth/logout) [Source](https://example.com/health)",
  ].join("\n\n");
  const imageRequests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("markdown-image.invalid")) imageRequests.push(request.url()); });
  await page.route("**/api/advice", (route) => route.fulfill({ headers: { "Content-Type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" }, body: adviceStream(markdown) }));
  await page.goto("/");
  await page.getByRole("checkbox").check(); await page.getByRole("button", { name: "Generate suggestions" }).click();
  const output = page.getByRole("log", { name: "Daily suggestions" });
  await expect(output.getByRole("heading", { name: "Daily review" })).toBeVisible();
  await expect(output.locator("strong")).toHaveText("4,300");
  await expect(output.getByRole("listitem")).toHaveCount(2);
  await expect(output.locator("script, img")).toHaveCount(0);
  await expect(output.getByRole("link")).toHaveCount(1);
  await expect(output.getByRole("link", { name: "Source" })).toHaveAttribute("rel", "noopener noreferrer");
  expect(imageRequests).toEqual([]);
  expect(await page.evaluate(() => "modelHtmlRan" in window)).toBe(false);
  await expect(page.getByRole("checkbox")).not.toBeChecked();
});
