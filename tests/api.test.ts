import { describe, expect, it } from "vitest";
import { makeRequest, origin, setup } from "./fixtures";

describe("protected Fitbit and advice routes", () => {
  it("rejects unauthenticated requests on every endpoint before using any external service", async () => {
    const context = setup();
    context.getSession.mockResolvedValue(null);
    for (const handler of Object.values(context.api)) expect((await handler(makeRequest())).status).toBe(401);
    for (const method of [context.getAccounts, context.getToken, context.getModel, context.connect, context.disconnect, context.apiFetch]) expect(method).not.toHaveBeenCalled();
  });

  it("rejects foreign-origin connection, disconnection, and advice requests", async () => {
    const context = setup();
    for (const handler of [context.api.connect, context.api.disconnect, context.api.advice]) expect((await handler(makeRequest(undefined, undefined, "https://unrelated.example"))).status).toBe(403);
    expect(context.connect).not.toHaveBeenCalled(); expect(context.disconnect).not.toHaveBeenCalled(); expect(context.getToken).not.toHaveBeenCalled();
  });

  it.each([{}, { shareWithFireworks: false }, { shareWithFireworks: true, subject: "auth0|bob" }, { shareWithFireworks: true, report: { steps: 50000 } }])("requires explicit sharing and rejects caller-supplied metrics or identity: %j", async (body) => {
    const context = setup();
    expect((await context.api.advice(makeRequest(undefined, body))).status).toBe(400);
    expect(context.getAccounts).not.toHaveBeenCalled();
    expect(context.getModel).not.toHaveBeenCalled();
  });

  it("rejects malformed and oversized advice bodies before reading health data", async () => {
    const context = setup();
    for (const [body, status] of [["{", 400], ["x".repeat(2049), 413]] as const) {
      const request = new Request(`${origin}/api/advice`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body });
      expect((await context.api.advice(request)).status).toBe(status);
    }
    expect(context.apiFetch).not.toHaveBeenCalled();
  });

  it("preserves OAuth transaction cookies and changes POST to a GET redirect", async () => {
    const context = setup();
    const response = await context.api.connect(makeRequest("/api/fitbit/connect"));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://tenant.example.test/connect");
    expect(response.headers.get("set-cookie")).toContain("transaction=encrypted");
  });

  it("disconnects only through the session-bound adapter", async () => {
    const context = setup();
    expect((await context.api.disconnect(makeRequest("/api/fitbit/disconnect"))).status).toBe(200);
    expect(context.disconnect).toHaveBeenCalledExactlyOnceWith();
  });

  it("returns status without making a Token Vault exchange or fetching Fitbit data", async () => {
    const context = setup();
    const response = await context.api.status(new Request(`${origin}/api/fitbit/status`));
    expect(await response.json()).toEqual({ connected: true, needsPermissions: false, multipleAccounts: false });
    expect(context.getToken).not.toHaveBeenCalled();
    expect(context.apiFetch).not.toHaveBeenCalled();
  });
});

describe("Fireworks advice workflow", () => {
  it("streams advice through the real provider adapter with a forced server-owned Fitbit tool", async () => {
    const context = setup();
    const response = await context.api.advice(makeRequest());
    const stream = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(stream).toContain('"type":"tool-output-available"');
    expect(stream).toContain("4,300 steps");
    expect(stream).toContain("[DONE]");
    expect(context.getToken).toHaveBeenCalledTimes(1);
    expect(context.providerRequests).toHaveLength(2);
    expect(context.providerRequests[0].body.tool_choice).toEqual({ type: "function", function: { name: "getDailyFitbitSummary" } });
    expect(context.providerRequests[1].body.tool_choice).toBe("none");
    const payload = JSON.stringify(context.providerRequests.map((request) => request.body));
    expect(payload).toContain('"steps\\\":4300');
    for (const secret of ["private-fitbit-token", "private-fireworks-key", "Private Alice", "private-fitbit-id", "private-log-id", "private-activity-name", "auth0|alice", "caloriesOut"]) {
      expect(payload).not.toContain(secret);
      expect(stream).not.toContain(secret);
    }
  });

  it("does not call inference when Fitbit is disconnected or token retrieval fails", async () => {
    const context = setup();
    context.getToken.mockRejectedValue(new Error("private-refresh-token"));
    const response = await context.api.advice(makeRequest());
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("private-refresh-token");
    expect(context.getModel).not.toHaveBeenCalled();
    expect(context.apiFetch).not.toHaveBeenCalled();
  });

  it("hides provider diagnostics and health data from error responses", async () => {
    const context = setup({ providerError: true });
    const stream = await (await context.api.advice(makeRequest())).text();
    expect(stream).toContain("Fireworks could not generate");
    expect(stream).not.toContain("private-provider-diagnostic");
    expect(stream).not.toContain("private-fireworks-key");
    expect(context.providerRequests).toHaveLength(1);
  });
});


it("returns an actionable Auth0 rate-limit response without upstream diagnostics", async () => {
  const context = setup();
  context.dependencies.report = async () => { throw new Error("private-provider-diagnostic", { cause: { status: 429 } }); };
  const response = await context.api.report(new Request(`${origin}/api/fitbit/report`));
  expect(response.status).toBe(429);
  const body = await response.text();
  expect(body).toContain("AUTH0_RATE_LIMIT");expect(body).not.toContain("private-provider-diagnostic");
});
