import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import { JsonStore } from "./store.js";
import { RunTokenService } from "./middleware/governance/run-token.js";
import { GovernanceLedger } from "./middleware/evidence/ledger.js";
import { SECURITY_FINDING_SCHEMA } from "./middleware/governance/fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

async function runtimeFixture(appAuthToken = "") {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-identity-http-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.principals.push(
      { id: "human-1", kind: "human" },
      {
        id: "agent-1",
        kind: "agent",
        ownerId: "human-1",
        parentPrincipalId: "human-1",
      },
    );
  });
  const runTokens = new RunTokenService(Buffer.alloc(32, 11));
  const app = await createApp(
    loadConfig({
      NODE_ENV: "test",
      ...(appAuthToken ? { APP_AUTH_TOKEN: appAuthToken } : {}),
    }),
    service,
    { store, runTokens },
  );
  return { app, runTokens };
}

const runtimeClaims = {
  runId: "run-1",
  principalId: "agent-1",
  grantId: "grant-1",
  exp: 4_102_444_800,
};

describe("HTTP boundary", () => {
  it("accepts a valid child runtime token across the complete Return Gate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "runtime-artifact-http-test-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();
    await store.mutate((database) => {
      database.principals.push(
        { id: "parent-agent", kind: "agent", ownerId: "human-1" },
        {
          id: "child-agent",
          kind: "agent",
          ownerId: "human-1",
          parentPrincipalId: "parent-agent",
        },
      );
      database.envelopes.push(
        {
          id: "parent-grant",
          principalId: "parent-agent",
          exercisable: { resources: [], actions: ["model:invoke"] },
          delegatable: {
            resources: ["SecurityFinding"],
            actions: ["artifact:create", "artifact:publish"],
          },
          depth: 1,
          maxTokens: 2000,
          maxToolCalls: 0,
          maxChildren: 1,
          runId: "run-return-gate",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "child-grant",
          principalId: "child-agent",
          exercisable: {
            resources: ["SecurityFinding"],
            actions: ["artifact:create", "artifact:publish"],
          },
          delegatable: { resources: [], actions: [] },
          depth: 0,
          maxTokens: 1000,
          maxToolCalls: 0,
          maxChildren: 0,
          runId: "run-return-gate",
          parentGrantId: "parent-grant",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      );
      database.grantStates.push(
        { grantId: "parent-grant", revoked: false, tokensUsed: 0, childCount: 1 },
        { grantId: "child-grant", revoked: false, tokensUsed: 0, childCount: 0 },
      );
      database.runStates.push({ runId: "run-return-gate", maxTokens: 2000, tokensUsed: 0 });
      database.artifactSchemas.push(SECURITY_FINDING_SCHEMA);
    });
    const runTokens = new RunTokenService(Buffer.alloc(32, 13));
    const ledger = new GovernanceLedger(store);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
      { store, runTokens, ledger },
    );
    const token = runTokens.mint({
      runId: "run-return-gate",
      principalId: "child-agent",
      grantId: "child-grant",
      exp: 4_102_444_800,
    });
    const fields = {
      actor_class: "service",
      action_count: 1,
      time_window: { start: 1, end: 2 },
      verdict: "expected",
    };
    const created = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      headers: { authorization: `Bearer ${token}` },
      payload: { artifactType: "SecurityFinding", fields },
    });
    expect(created.statusCode).toBe(201);
    const artifactId = created.json<{ id: string }>().id;
    const published = await app.inject({
      method: "POST",
      url: `/api/artifacts/${artifactId}/publish`,
      headers: { authorization: `Bearer ${token}` },
      payload: { artifactType: "SecurityFinding", fields },
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().recipients).toEqual(["parent-agent"]);
    expect(published.body).not.toContain(token);
    await app.close();
  });

  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("authenticates a runtime callback without exposing its token", async () => {
    const { app, runTokens } = await runtimeFixture("a-strong-test-token");
    const token = runTokens.mint(runtimeClaims);
    const response = await app.inject({
      method: "GET",
      url: "/api/runtime/identity",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      principalId: "agent-1",
      grantId: "grant-1",
      runId: "run-1",
      kind: "agent",
    });
    expect(response.body).not.toContain(token);
    await app.close();
  });

  it("rejects forged and expired runtime credentials", async () => {
    const { app, runTokens } = await runtimeFixture();
    const valid = runTokens.mint(runtimeClaims);
    const forged = valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A");
    const expired = runTokens.mint({ ...runtimeClaims, exp: 1 });

    for (const token of [forged, expired]) {
      const response = await app.inject({
        method: "GET",
        url: "/api/runtime/identity",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(token);
    }
    await app.close();
  });

  it("does not fall back to a human header for a forged runtime token", async () => {
    const { app, runTokens } = await runtimeFixture();
    const valid = runTokens.mint(runtimeClaims);
    const forged = valid.slice(0, -1) + (valid.endsWith("A") ? "B" : "A");
    const response = await app.inject({
      method: "GET",
      url: "/api/runtime/identity",
      headers: {
        authorization: `Bearer ${forged}`,
        "x-principal-id": "human-1",
      },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("verifies runtime tokens when APP_AUTH_TOKEN is empty", async () => {
    const { app, runTokens } = await runtimeFixture();
    const token = runTokens.mint(runtimeClaims);
    const response = await app.inject({
      method: "GET",
      url: "/api/runtime/identity",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("does not require governance identity on ordinary Starter Kit routes", async () => {
    const { app } = await runtimeFixture();
    const response = await app.inject({ method: "GET", url: "/api/agents" });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("does not reinterpret a runtime token as APP_AUTH_TOKEN", async () => {
    const { app, runTokens } = await runtimeFixture("a-strong-test-token");
    const token = runTokens.mint(runtimeClaims);
    const response = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("accepts only persisted human principals from an explicit header", async () => {
    const { app } = await runtimeFixture();
    const human = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-principal-id": "human-1" },
    });
    const agent = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-principal-id": "agent-1" },
    });
    const unknown = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { "x-principal-id": "unknown" },
    });

    expect(human.statusCode).toBe(200);
    expect(agent.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    await app.close();
  });
});
