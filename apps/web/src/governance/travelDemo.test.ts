import { afterEach, describe, expect, it, vi } from "vitest";
import { isTravelDemoAgent, startTravelDemo, startUserTravelDemo } from "./travelDemo";

afterEach(() => vi.unstubAllGlobals());

describe("Travel reference-workload frontend bridge", () => {
  it("matches only the explicitly named persistent demo Agent", () => {
    expect(isTravelDemoAgent("Travel Recovery Assistant")).toBe(true);
    expect(isTravelDemoAgent("Coding assistant")).toBe(false);
    expect(isTravelDemoAgent("Transport specialist")).toBe(false);
  });

  it("returns the backend binding without generating lifecycle or budget state", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: "returned-run-id",
      principalId: "travel-user",
    }), { status: 202, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(startTravelDemo("the user request")).resolves.toEqual({
      runId: "returned-run-id",
      principalId: "travel-user",
    });
    expect(fetch).toHaveBeenCalledWith("/api/governance/travel-demo-runs", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ request: "the user request", executionMode: "deterministic" }),
    }));
  });

  it("requests real execution only when explicitly selected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: "travel-real-1", principalId: "travel-user",
    }), { status: 202, headers: { "content-type": "application/json" } })));
    await startTravelDemo("the user request", "real");
    expect(fetch).toHaveBeenCalledWith("/api/governance/travel-demo-runs", expect.objectContaining({
      body: JSON.stringify({ request: "the user request", executionMode: "real" }),
    }));
  });

  it("always requests real execution for the user-facing Travel flow", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId: "travel-real-user", principalId: "travel-user",
    }), { status: 202, headers: { "content-type": "application/json" } })));
    await startUserTravelDemo("normal user submission", "11111111-1111-4111-8111-111111111111");
    expect(fetch).toHaveBeenCalledWith("/api/governance/travel-demo-runs", expect.objectContaining({
      body: JSON.stringify({ request: "normal user submission", executionMode: "real",
        agentId: "11111111-1111-4111-8111-111111111111" }),
    }));
  });
});
