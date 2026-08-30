import { readFile } from "node:fs/promises";
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
import {
  DelegationService,
  deriveChildEnvelope,
  type ChildEnvelopeRequest,
} from "./delegation.js";
import { resolveGrant } from "./grant-resolver.js";
import type { AuthenticatedIdentity } from "./identity.js";
import { RunTokenService } from "./run-token.js";
import type { Envelope, GovernanceState, Principal } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const now = "2026-01-02T00:00:00.000Z";
const parentPrincipal: Principal = { id: "agent-parent", kind: "agent", ownerId: "wtan" };
const parentEnvelope: Envelope = {
  id: "grant-parent",
  principalId: parentPrincipal.id,
  exercisable: { resources: ["app/*"], actions: ["read", "delegate"] },
  delegatable: { resources: ["sec/*"], actions: ["read", "delegate"] },
  depth: 2,
  maxTokens: 800,
  maxToolCalls: 10,
  maxChildren: 2,
  runId: "run-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-02-01T00:00:00.000Z",
};
const request: ChildEnvelopeRequest = {
  exercisable: { resources: ["sec/INC-42"], actions: ["read"] },
  delegatable: { resources: [], actions: [] },
  maxTokens: 500,
  maxToolCalls: 5,
  maxChildren: 1,
  expiresAt: "2026-01-20T00:00:00.000Z",
};

function derive(
  childRequest: ChildEnvelopeRequest = request,
  parent: Envelope = parentEnvelope,
  maxTokensCeiling?: number,
) {
  return deriveChildEnvelope(parent, childRequest, {
    id: "grant-child",
    principalId: "agent-child",
    createdAt: now,
    ...(maxTokensCeiling === undefined ? {} : { maxTokensCeiling }),
  });
}

describe("deriveChildEnvelope", () => {
  it("accepts an exact resource within parent exact delegatable authority", () => expect(derive(request, { ...parentEnvelope, delegatable: { resources: ["sec/INC-42"], actions: ["read"] } }).ok).toBe(true));
  it("accepts a narrower exact resource beneath a parent namespace wildcard", () => expect(derive({ ...request, exercisable: { resources: ["sec/incidents/42"], actions: ["read"] } }).ok).toBe(true));
  it("rejects a resource outside parent delegatable authority", () => expect(derive({ ...request, exercisable: { resources: ["payments/private"], actions: ["read"] } })).toEqual({ ok: false, reason: "CHILD_EXCEEDS_PARENT" }));
  it("rejects a child wildcard broader than a parent exact resource", () => expect(derive({ ...request, exercisable: { resources: ["sec/*"], actions: ["read"] } }, { ...parentEnvelope, delegatable: { resources: ["sec/INC-42"], actions: ["read"] } })).toEqual({ ok: false, reason: "CHILD_EXCEEDS_PARENT" }));
  it("rejects an action outside parent delegatable authority", () => expect(derive({ ...request, exercisable: { resources: ["sec/INC-42"], actions: ["write"] } })).toEqual({ ok: false, reason: "CHILD_EXCEEDS_PARENT" }));
  it("rejects child delegatable scope outside parent or child exercisable scope", () => expect(derive({ ...request, delegatable: { resources: ["sec/*"], actions: ["read"] } })).toEqual({ ok: false, reason: "CHILD_EXCEEDS_PARENT" }));
  it("clamps numeric ceilings downward including effective remaining tokens", () => {
    const result = derive({ ...request, maxTokens: 900, maxToolCalls: 99, maxChildren: 99 }, parentEnvelope, 300);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope).toMatchObject({ maxTokens: 300, maxToolCalls: 10, maxChildren: 2 });
  });
  it("derives depth as parent depth minus one", () => {
    const result = derive();
    if (!result.ok) throw new Error("derivation failed");
    expect(result.envelope.depth).toBe(1);
  });
  it("prevents the child from outliving its parent", () => {
    const result = derive({ ...request, expiresAt: "2027-01-01T00:00:00.000Z" });
    if (!result.ok) throw new Error("derivation failed");
    expect(result.envelope.expiresAt).toBe(parentEnvelope.expiresAt);
  });
  it("always derives runId and parentGrantId from the parent", () => {
    const result = derive();
    if (!result.ok) throw new Error("derivation failed");
    expect(result.envelope.runId).toBe(parentEnvelope.runId);
    expect(result.envelope.parentGrantId).toBe(parentEnvelope.id);
  });
  it("ignores request attempts to inject ids and lifecycle fields", () => {
    const injected = { ...request, id: "evil", principalId: "evil", runId: "evil", parentGrantId: "evil", createdAt: "evil", revokedAt: now } as ChildEnvelopeRequest;
    const result = derive(injected);
    if (!result.ok) throw new Error("derivation failed");
    expect(result.envelope).toMatchObject({ id: "grant-child", principalId: "agent-child", runId: "run-1", parentGrantId: "grant-parent", createdAt: now });
    expect(result.envelope.revokedAt).toBeUndefined();
  });
  it("keeps the brand private and exposes no unchecked construction helper", async () => {
    const source = await readFile(new URL("./delegation.ts", import.meta.url), "utf8");
    expect(source).toContain("const derivedEnvelopeBrand: unique symbol");
    expect(source).not.toMatch(/export\s+(?:const|function)\s+derivedEnvelopeBrand/);
    expect(source).not.toMatch(/asDerivedEnvelope|makeDerivedEnvelopeUnchecked|unsafeChildEnvelope/);
  });
  it("does not derive authority from parent exercisable-only scope", () => expect(derive({ ...request, exercisable: { resources: ["app/metrics"], actions: ["read"] } })).toEqual({ ok: false, reason: "CHILD_EXCEEDS_PARENT" }));
  it("allows a delegatable-only parent resource to become child exercisable", () => expect(derive().ok).toBe(true));
});

const serviceStub = { listAgents: () => [], systemInfo: async () => ({}) } as unknown as AgentService;

async function fixture(overrides: { revoked?: boolean; depth?: number; childCount?: number; runTokensUsed?: number; expiresAt?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "constructive-delegation-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  const seededEnvelope = {
    ...parentEnvelope,
    depth: overrides.depth ?? parentEnvelope.depth,
    expiresAt: overrides.expiresAt ?? parentEnvelope.expiresAt,
  };
  await store.mutate((database) => {
    database.principals.push({ id: "wtan", kind: "human" }, parentPrincipal);
    database.envelopes.push(seededEnvelope);
    database.grantStates.push({ grantId: "grant-parent", revoked: overrides.revoked ?? false, tokensUsed: 100, childCount: overrides.childCount ?? 0 });
    database.runStates.push({ runId: "run-1", maxTokens: 1200, tokensUsed: overrides.runTokensUsed ?? 200 });
  });
  const ledger = new GovernanceLedger(store, () => now);
  const ids = ["agent-child", "grant-child"];
  const delegation = new DelegationService({ store, ledger, now: () => now, id: () => ids.shift()! });
  const identity: Extract<AuthenticatedIdentity, { kind: "agent" }> = { kind: "agent", principalId: parentPrincipal.id, grantId: parentEnvelope.id, runId: parentEnvelope.runId, principal: parentPrincipal };
  return { root, store, ledger, delegation, identity };
}

describe("DelegationService", () => {
  it("constructs and persists a valid attenuated child grant", async () => {
    const { delegation, identity, store } = await fixture();
    const result = await delegation.delegate(identity, request);
    expect(result).toEqual({ ok: true, grant: { childPrincipalId: "agent-child", grantId: "grant-child", status: "grant_created" } });
    expect(store.snapshot().envelopes.some((item) => item.id === "grant-child")).toBe(true);
  });

  it.each([
    ["revoked parent", { revoked: true }, "PARENT_GRANT_REVOKED"],
    ["expired parent", { expiresAt: now }, "PARENT_GRANT_EXPIRED"],
    ["depth zero", { depth: 0 }, "DELEGATION_CEILING_REACHED"],
    ["max children", { childCount: 2 }, "MAX_CHILDREN_EXCEEDED"],
    ["exhausted run budget", { runTokensUsed: 1200 }, "BUDGET_EXCEEDED"],
  ] as const)("denies delegation for %s", async (_label, overrides, reason) => {
    const { delegation, identity, store } = await fixture(overrides);
    const result = await delegation.delegate(identity, request);
    expect(result).toEqual({ ok: false, statusCode: 403, reason });
    expect(store.snapshot().principals).toHaveLength(2);
  });

  it("rejects widening without creating authority or incrementing childCount", async () => {
    const { delegation, identity, store } = await fixture();
    const result = await delegation.delegate(identity, { ...request, exercisable: { resources: ["payments/private"], actions: ["read"] } });
    expect(result).toEqual({ ok: false, statusCode: 400, reason: "CHILD_EXCEEDS_PARENT" });
    const database = store.snapshot();
    expect(database.principals).toHaveLength(2);
    expect(database.envelopes).toHaveLength(1);
    expect(database.grantStates[0]?.childCount).toBe(0);
    expect(database.governanceEvents.map((event) => event.kind)).toEqual(["delegation_requested", "authority_evaluated"]);
  });

  it("increments parent childCount exactly once through grant_created", async () => {
    const { delegation, identity, store } = await fixture();
    await delegation.delegate(identity, request);
    const database = store.snapshot();
    expect(database.grantStates.find((state) => state.grantId === "grant-parent")?.childCount).toBe(1);
    expect(database.governanceEvents.filter((event) => event.kind === "grant_created")).toHaveLength(1);
  });

  it("persists child lineage, inherited human ownership and grant relationships", async () => {
    const { delegation, identity, store } = await fixture();
    await delegation.delegate(identity, request);
    const database = store.snapshot();
    expect(database.principals.find((item) => item.id === "agent-child")).toMatchObject({ ownerId: "wtan", parentPrincipalId: "agent-parent" });
    expect(database.envelopes.find((item) => item.id === "grant-child")).toMatchObject({ runId: "run-1", parentGrantId: "grant-parent" });
  });

  it("emits the deterministic successful evidence sequence", async () => {
    const { delegation, identity, store } = await fixture();
    await delegation.delegate(identity, request);
    expect(store.snapshot().governanceEvents.map((event) => event.kind)).toEqual(["delegation_requested", "authority_evaluated", "principal_created", "grant_created"]);
  });

  it("can mint a valid child token without persisting or evidencing the raw secret", async () => {
    const { delegation, identity, store } = await fixture();
    const result = await delegation.delegate(identity, request);
    if (!result.ok) throw new Error("delegation failed");
    const runTokens = new RunTokenService(Buffer.alloc(32, 37));
    const token = runTokens.mint({ runId: "run-1", principalId: result.grant.childPrincipalId, grantId: result.grant.grantId, exp: Math.floor(Date.parse(request.expiresAt!) / 1000) });
    expect(runTokens.verify(token, Math.floor(Date.parse(now) / 1000))).toMatchObject({ principalId: "agent-child", grantId: "grant-child", runId: "run-1" });
    expect(JSON.stringify(store.snapshot())).not.toContain(token);
  });

  it("proves parent denied on delegate-only resource while the persisted child is allowed", async () => {
    const { delegation, identity, store } = await fixture();
    await store.mutate((database) => {
      database.envelopes[0]!.delegatable.resources = ["sec/INC-42"];
    });
    const parentResolution = resolveGrant({ principalId: "agent-parent", grantId: "grant-parent", runId: "run-1" }, store, now);
    if (!parentResolution.ok) throw new Error("parent resolution failed");
    expect(authorize(parentPrincipal, "read", "sec/INC-42", parentResolution.state)).toEqual({ verdict: "DENY", reason: "NOT_EXERCISABLE_DELEGATE_ONLY" });
    await delegation.delegate(identity, request);
    const child = store.snapshot().principals.find((item) => item.id === "agent-child")!;
    const childResolution = resolveGrant({ principalId: "agent-child", grantId: "grant-child", runId: "run-1" }, store, now);
    if (!childResolution.ok) throw new Error("child resolution failed");
    expect(authorize(child, "read", "sec/INC-42", childResolution.state)).toEqual({ verdict: "ALLOW", reason: "AUTHORIZED" });
  });
});

describe("POST /api/delegations", () => {
  async function httpFixture() {
    const base = await fixture();
    await base.store.mutate((database) => {
      database.envelopes[0]!.expiresAt = "2099-01-01T00:00:00.000Z";
    });
    const runTokens = new RunTokenService(Buffer.alloc(32, 41));
    const app = await createApp(loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "transport-only" }), serviceStub, { store: base.store, runTokens, ledger: base.ledger });
    const token = runTokens.mint({ runId: "run-1", principalId: "agent-parent", grantId: "grant-parent", exp: 4_102_444_800 });
    return { ...base, app, token };
  }

  it("requires a bounded task before entering the live-child launcher", async () => {
    const { app, token } = await httpFixture();
    const response = await app.inject({ method: "POST", url: "/api/delegations", headers: { authorization: `Bearer ${token}` }, payload: { ...request, expiresAt: undefined } });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason).toBe("MALFORMED_INPUT");
    await app.close();
  });

  it("rejects a forged Runtime token", async () => {
    const { app, token } = await httpFixture();
    const forged = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const response = await app.inject({ method: "POST", url: "/api/delegations", headers: { authorization: `Bearer ${forged}` }, payload: { ...request, task: "safe task" } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("does not let a human header impersonate Runtime delegation", async () => {
    const { app } = await httpFixture();
    const response = await app.inject({ method: "POST", url: "/api/delegations", headers: { authorization: "Bearer transport-only", "x-principal-id": "wtan" }, payload: { ...request, task: "safe task" } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects client-supplied authority relationship fields", async () => {
    const { app, token } = await httpFixture();
    const response = await app.inject({ method: "POST", url: "/api/delegations", headers: { authorization: `Bearer ${token}` }, payload: { ...request, task: "safe task", principalId: "injected" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason).toBe("MALFORMED_INPUT");
    await app.close();
  });
});
