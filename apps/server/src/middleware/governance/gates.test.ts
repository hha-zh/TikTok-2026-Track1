import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "../../agent-service.js";
import { createApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { GovernanceLedger } from "../evidence/ledger.js";
import { JsonStore } from "../../store.js";
import { RunTokenService } from "./run-token.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const service = { listAgents: () => [], systemInfo: async () => ({}) } as unknown as AgentService;
const secretBody = { secret: "protected-metrics-value" };

async function fixture(runTokensUsed = 200) {
  const root = await mkdtemp(path.join(tmpdir(), "governance-gates-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.principals.push(
      { id: "wtan", kind: "human" },
      { id: "agent-parent", kind: "agent", ownerId: "wtan", parentPrincipalId: "wtan" },
    );
    database.envelopes.push({
      id: "grant-parent", principalId: "agent-parent",
      exercisable: { resources: ["app/*"], actions: ["read", "tool:inspect_metrics", "delegate"] },
      delegatable: { resources: ["sec/INC-42"], actions: ["read"] },
      depth: 1, maxTokens: 800, maxToolCalls: 10, maxChildren: 2,
      runId: "run-1", createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    database.grantStates.push({ grantId: "grant-parent", revoked: false, tokensUsed: 100, childCount: 0 });
    database.runStates.push({ runId: "run-1", maxTokens: 1200, tokensUsed: runTokensUsed });
    database.mockResources.push(
      { id: "app/metrics", ownerId: "wtan", domain: "app", body: secretBody },
      { id: "payments/private_incident.json", ownerId: "wtan", domain: "payments", body: { secret: "payment-incident" } },
      { id: "sec/INC-42", ownerId: "wtan", domain: "sec", body: { secret: "incident-42" } },
    );
  });
  const runTokens = new RunTokenService(Buffer.alloc(32, 17));
  const ledger = new GovernanceLedger(store, () => "2026-01-02T00:00:00.000Z");
  const app = await createApp(loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "app-only" }), service, { store, runTokens, ledger });
  const token = runTokens.mint({ runId: "run-1", principalId: "agent-parent", grantId: "grant-parent", exp: 4_102_444_800 });
  return { app, store, token, runTokens };
}

async function getResource(app: Awaited<ReturnType<typeof createApp>>, token: string, id: string, headers = {}) {
  return app.inject({ method: "GET", url: `/api/resources/${id}`, headers: { authorization: `Bearer ${token}`, ...headers } });
}

describe("Resource Gate", () => {
  it("allows an exercisable backend-only resource and records safe evidence", async () => {
    const { app, store, token } = await fixture();
    const response = await getResource(app, token, "app/metrics");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(secretBody);
    const event = store.snapshot().governanceEvents.at(-1)!;
    expect(event.kind).toBe("resource_allowed");
    expect(JSON.stringify(event)).not.toContain(secretBody.secret);
    await app.close();
  });

  it.each([
    ["payments/private_incident.json", "RESOURCE_NOT_GRANTED", "payment-incident"],
    ["sec/INC-42", "NOT_EXERCISABLE_DELEGATE_ONLY", "incident-42"],
  ])("denies %s without exposing its body", async (id, expectedReason, protectedValue) => {
    const { app, store, token } = await fixture();
    const response = await getResource(app, token, id);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden", reason: expectedReason });
    expect(response.body).not.toContain(protectedValue);
    const event = store.snapshot().governanceEvents.at(-1)!;
    expect(event.kind).toBe("resource_denied");
    expect(JSON.stringify(event)).not.toContain(protectedValue);
    await app.close();
  });

  it("rejects forged tokens without human-header fallback", async () => {
    const { app, token } = await fixture();
    const forged = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    for (const headers of [{}, { "x-principal-id": "wtan" }]) {
      expect((await getResource(app, forged, "app/metrics", headers)).statusCode).toBe(401);
    }
    await app.close();
  });

  it("blocks an exhausted shared run budget", async () => {
    const { app, token } = await fixture(1200);
    const response = await getResource(app, token, "app/metrics");
    expect(response.statusCode).toBe(403);
    expect(response.json().reason).toBe("BUDGET_EXCEEDED");
    await app.close();
  });
});

describe("Trusted Tool Gate", () => {
  it("executes an allowed registered tool and records an allow", async () => {
    const { app, store, token } = await fixture();
    const response = await app.inject({ method: "POST", url: "/api/tools/inspect_metrics", headers: { authorization: `Bearer ${token}` }, payload: { arbitrary: "do-not-log-this" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tool: "inspect_metrics", status: "healthy" });
    const event = store.snapshot().governanceEvents.at(-1)!;
    expect(event.kind).toBe("tool_allowed");
    expect(JSON.stringify(event)).not.toContain("do-not-log-this");
    await app.close();
  });

  it("denies an ungranted registered tool and records the denial", async () => {
    const { app, store, token } = await fixture();
    const response = await app.inject({ method: "POST", url: "/api/tools/apply_production_patch", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "forbidden", reason: "ACTION_NOT_GRANTED" });
    expect(store.snapshot().governanceEvents.at(-1)?.kind).toBe("tool_denied");
    await app.close();
  });

  it("fails closed for an unknown tool without creating a decision event", async () => {
    const { app, store, token } = await fixture();
    const response = await app.inject({ method: "POST", url: "/api/tools/not_registered", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(404);
    expect(response.json().reason).toBe("MALFORMED_INPUT");
    expect(store.snapshot().governanceEvents).toHaveLength(0);
    await app.close();
  });
});
