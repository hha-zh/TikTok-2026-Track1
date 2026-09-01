import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentService } from "../../agent-service.js";
import { createApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { JsonStore } from "../../store.js";
import { GovernanceLedger } from "../evidence/ledger.js";
import { authorize } from "./authorize.js";
import { resolveGrant } from "./grant-resolver.js";
import { RunTokenService } from "./run-token.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;
const now = "2026-01-02T00:00:00.000Z";

async function fixture(appAuthToken = "") {
  const root = await mkdtemp(path.join(tmpdir(), "human-revocation-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.principals.push(
      { id: "wtan", kind: "human" },
      { id: "other-human", kind: "human" },
      { id: "agent-parent", kind: "agent", ownerId: "wtan", parentPrincipalId: "wtan" },
      { id: "agent-child", kind: "agent", ownerId: "wtan", parentPrincipalId: "agent-parent" },
    );
    const common = {
      exercisable: { resources: ["app/*"], actions: ["read"] },
      delegatable: { resources: [], actions: [] },
      maxTokens: 800,
      maxToolCalls: 10,
      maxChildren: 2,
      runId: "run-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    database.envelopes.push(
      { ...common, id: "grant-parent", principalId: "agent-parent", depth: 1 },
      { ...common, id: "grant-child", principalId: "agent-child", depth: 0, parentGrantId: "grant-parent" },
    );
    database.grantStates.push(
      { grantId: "grant-parent", revoked: false, tokensUsed: 100, childCount: 1 },
      { grantId: "grant-child", revoked: false, tokensUsed: 10, childCount: 0 },
    );
    database.runStates.push({ runId: "run-1", maxTokens: 1200, tokensUsed: 200 });
    database.mockResources.push({
      id: "app/metrics",
      ownerId: "wtan",
      domain: "app",
      body: { secret: "protected-metric" },
    });
  });
  const runTokens = new RunTokenService(Buffer.alloc(32, 29));
  const ledger = new GovernanceLedger(store, () => now);
  const app = await createApp(
    loadConfig({
      NODE_ENV: "test",
      ...(appAuthToken ? { APP_AUTH_TOKEN: appAuthToken } : {}),
    }),
    service,
    { store, runTokens, ledger },
  );
  const token = runTokens.mint({
    runId: "run-1",
    principalId: "agent-parent",
    grantId: "grant-parent",
    exp: 4_102_444_800,
  });
  return { app, store, token };
}

function revokeHeaders(principalId: string, appAuthToken?: string) {
  return {
    "x-principal-id": principalId,
    ...(appAuthToken ? { authorization: `Bearer ${appAuthToken}` } : {}),
  };
}

describe("human grant revocation", () => {
  it("lets the persisted owner revoke an Agent envelope", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/envelopes/grant-parent/revoke",
      headers: revokeHeaders("wtan"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ grantId: "grant-parent", revoked: true });
    await app.close();
  });

  it("preserves APP_AUTH_TOKEN transport authentication", async () => {
    const { app } = await fixture("transport-secret");
    const denied = await app.inject({
      method: "POST",
      url: "/api/envelopes/grant-parent/revoke",
      headers: revokeHeaders("wtan"),
    });
    expect(denied.statusCode).toBe(401);
    const allowed = await app.inject({
      method: "POST",
      url: "/api/envelopes/grant-parent/revoke",
      headers: revokeHeaders("wtan", "transport-secret"),
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("does not let an Agent token call the human route or fall back to a human header", async () => {
    const { app, token } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/envelopes/grant-parent/revoke",
      headers: { authorization: `Bearer ${token}`, "x-principal-id": "wtan" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects an unknown human", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "POST", url: "/api/envelopes/grant-parent/revoke",
      headers: revokeHeaders("missing-human"),
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects the wrong human owner", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "POST", url: "/api/envelopes/grant-parent/revoke",
      headers: revokeHeaders("other-human"),
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("fails closed for an unknown envelope", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "POST", url: "/api/envelopes/missing/revoke",
      headers: revokeHeaders("wtan"),
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("appends one grant_revoked event and updates GrantState", async () => {
    const { app, store } = await fixture();
    await app.inject({ method: "POST", url: "/api/envelopes/grant-parent/revoke", headers: revokeHeaders("wtan") });
    const database = store.snapshot();
    expect(database.governanceEvents.map((event) => event.kind)).toEqual(["grant_revoked"]);
    expect(database.grantStates.find((state) => state.grantId === "grant-parent")?.revoked).toBe(true);
    await app.close();
  });

  it("is idempotent without duplicate transition events", async () => {
    const { app, store } = await fixture();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({ method: "POST", url: "/api/envelopes/grant-parent/revoke", headers: revokeHeaders("wtan") });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ grantId: "grant-parent", revoked: true });
    }
    expect(store.snapshot().governanceEvents).toHaveLength(1);
    await app.close();
  });

  it("immediately denies a previously allowed request using the unchanged Agent token", async () => {
    const { app, token } = await fixture();
    const request = () => app.inject({ method: "GET", url: "/api/resources/app/metrics", headers: { authorization: `Bearer ${token}` } });
    expect((await request()).statusCode).toBe(200);
    await app.inject({ method: "POST", url: "/api/envelopes/grant-parent/revoke", headers: revokeHeaders("wtan") });
    const denied = await request();
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "forbidden", reason: "PARENT_GRANT_REVOKED" });
    await app.close();
  });

  it("invalidates descendants through resolved ancestry", async () => {
    const { app, store } = await fixture();
    const child = store.snapshot().principals.find((item) => item.id === "agent-child")!;
    const decide = () => {
      const resolution = resolveGrant({ principalId: "agent-child", grantId: "grant-child", runId: "run-1" }, store, now);
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) throw new Error("child grant did not resolve");
      return authorize(child, "read", "app/metrics", resolution.state);
    };
    expect(decide()).toEqual({ verdict: "ALLOW", reason: "AUTHORIZED" });
    await app.inject({ method: "POST", url: "/api/envelopes/grant-parent/revoke", headers: revokeHeaders("wtan") });
    expect(decide()).toEqual({ verdict: "DENY", reason: "PARENT_GRANT_REVOKED" });
    await app.close();
  });

  it("keeps the response narrow without exposing the envelope or token", async () => {
    const { app, token } = await fixture();
    const response = await app.inject({ method: "POST", url: "/api/envelopes/grant-parent/revoke", headers: revokeHeaders("wtan") });
    expect(response.body).not.toContain("exercisable");
    expect(response.body).not.toContain(token);
    await app.close();
  });

  it("keeps revocation evidence free of tokens and protected contents", async () => {
    const { app, store, token } = await fixture();
    await app.inject({ method: "POST", url: "/api/envelopes/grant-parent/revoke", headers: revokeHeaders("wtan") });
    const event = JSON.stringify(store.snapshot().governanceEvents[0]);
    expect(event).not.toContain(token);
    expect(event).not.toContain("protected-metric");
    expect(event).not.toContain("exercisable");
    await app.close();
  });
});
