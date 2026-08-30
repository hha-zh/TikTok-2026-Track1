import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import { JsonStore } from "./store.js";
import { RunTokenService } from "./middleware/governance/run-token.js";

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
