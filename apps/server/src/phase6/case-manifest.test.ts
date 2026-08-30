import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import { GovernanceLedger } from "../middleware/evidence/ledger.js";
import { authorize } from "../middleware/governance/authorize.js";
import {
  createArtifact,
  publishArtifact,
} from "../middleware/governance/artifacts.js";
import { deriveChildEnvelope } from "../middleware/governance/delegation.js";
import {
  invokeTrustedTool,
  readManagedResource,
} from "../middleware/governance/gates.js";
import {
  ARTIFACT_SECURITY_FINDING,
  RESOURCE_AUDIT,
  RESOURCE_PAYMENTS,
  seedGovernanceFixtures,
  startGovernedRun,
} from "../middleware/governance/fixtures.js";
import { resolveGrant } from "../middleware/governance/grant-resolver.js";
import type { AuthenticatedIdentity } from "../middleware/governance/identity.js";
import {
  ADAPTIVE_RUNTIME_CASES,
  ALL_CASES,
  AUTHORITY_BUDGET_CASES,
  BOUNCER_BOUNDARIES,
  HARD_GOVERNANCE_CASES,
  MODEL_CROSSING_LIMITATION,
} from "./case-manifest.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

type AgentIdentity = Extract<AuthenticatedIdentity, { kind: "agent" }>;

async function governedHarness(burn = 0) {
  const root = await mkdtemp(path.join(tmpdir(), "phase6-cases-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await seedGovernanceFixtures(store);
  const ledger = new GovernanceLedger(store);
  const governed = await startGovernedRun(store, ledger, { runId: "run-1" });
  if (burn > 0) {
    await ledger.appendEvent(
      "tokens_consumed",
      { inputTokens: burn, cachedInputTokens: 0, outputTokens: 0, totalTokens: burn },
      {
        runId: "run-1",
        grantId: governed.envelope.id,
        principalId: governed.principal.id,
      },
    );
  }
  const identity: AgentIdentity = {
    kind: "agent",
    principalId: governed.principal.id,
    grantId: governed.envelope.id,
    runId: "run-1",
    principal: governed.principal,
  };
  return { store, ledger, governed, identity, deps: { store, ledger } };
}

describe("Phase 6 manifest integrity", () => {
  it("numbers HG-01..HG-15 and AR-01..AR-10 without gaps", () => {
    expect(HARD_GOVERNANCE_CASES.map((entry) => entry.id)).toEqual(
      Array.from({ length: 15 }, (_, index) => `HG-${String(index + 1).padStart(2, "0")}`),
    );
    expect(ADAPTIVE_RUNTIME_CASES.map((entry) => entry.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `AR-${String(index + 1).padStart(2, "0")}`),
    );
    expect(AUTHORITY_BUDGET_CASES.map((entry) => entry.id)).toEqual(
      Array.from({ length: 7 }, (_, index) => `AB-${String(index + 1).padStart(2, "0")}`),
    );
  });

  it("gives every case evidence and every non-proven case a stated limitation", () => {
    for (const entry of ALL_CASES) {
      expect(entry.evidence.length, entry.id).toBeGreaterThan(0);
      expect(entry.claim.length, entry.id).toBeGreaterThan(0);
      if (entry.status !== "PROVEN") {
        // A manifest that grades itself generously is worse than none.
        expect(entry.limitation, entry.id).toBeTruthy();
      }
    }
  });

  it("records the model-crossing limitation rather than softening HG-14", () => {
    const hg14 = HARD_GOVERNANCE_CASES.find((entry) => entry.id === "HG-14");
    expect(hg14?.status).toBe("PARTIAL");
    expect(MODEL_CROSSING_LIMITATION.mediatedAt).toBe("dispatch");
    expect(MODEL_CROSSING_LIMITATION.notMediatedAt).toContain("individual model call");
  });
});

describe("HG-14 enumerates every Bouncer-managed boundary", () => {
  it("names exactly the five boundaries the claim covers", () => {
    expect([...BOUNCER_BOUNDARIES]).toEqual([
      "Resource",
      "Trusted Tool",
      "Model/Budget",
      "Delegation",
      "Artifact/Return",
    ]);
  });

  it("Resource: refuses a cross-owner read through authorize()", async () => {
    const { identity, deps, store } = await governedHarness();
    const result = await readManagedResource(identity, RESOURCE_PAYMENTS, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("RESOURCE_NOT_GRANTED");
    expect(
      store.snapshot().governanceEvents.some((e) => e.kind === "resource_denied"),
    ).toBe(true);
  });

  it("Trusted Tool: refuses an ungranted tool through authorize()", async () => {
    const { identity, deps, store } = await governedHarness();
    const result = await invokeTrustedTool(identity, "apply_production_patch", deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ACTION_NOT_GRANTED");
    expect(
      store.snapshot().governanceEvents.some((e) => e.kind === "tool_denied"),
    ).toBe(true);
  });

  it("Model/Budget: refuses a model crossing once the run budget is spent", async () => {
    // PARTIAL by design: this is the pre-dispatch gate on accumulated usage.
    const { store, identity, governed } = await governedHarness(12_000);
    const resolution = resolveGrant(
      {
        principalId: identity.principalId,
        grantId: governed.envelope.id,
        runId: "run-1",
      },
      store,
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const decision = authorize(identity.principal, "model:invoke", null, resolution.state);
    expect(decision.verdict).toBe("DENY");
    expect(decision.reason).toBe("BUDGET_EXCEEDED");
  });

  it("Delegation: refuses a child scope outside the parent's delegatable set", async () => {
    const { governed } = await governedHarness();
    const derivation = deriveChildEnvelope(
      governed.envelope,
      {
        exercisable: { resources: [RESOURCE_PAYMENTS], actions: ["read"] },
        delegatable: { resources: [], actions: [] },
        maxTokens: 100,
        maxToolCalls: 1,
        maxChildren: 0,
      },
      { id: "child", principalId: "child-principal", createdAt: new Date().toISOString() },
    );
    expect(derivation.ok).toBe(false);
    if (!derivation.ok) expect(derivation.reason).toBe("CHILD_EXCEEDS_PARENT");
  });

  it("Artifact/Return: refuses a schema-violating publication", async () => {
    const { store, ledger, governed } = await governedHarness();
    // A child that may publish a SecurityFinding.
    const childPrincipalId = "child-principal";
    const childGrantId = "child-grant";
    await store.mutate((database) => {
      database.principals.push({
        id: childPrincipalId,
        kind: "agent",
        ownerId: "wtan",
        parentPrincipalId: governed.principal.id,
      });
      database.envelopes.push({
        id: childGrantId,
        principalId: childPrincipalId,
        exercisable: {
          resources: [ARTIFACT_SECURITY_FINDING, RESOURCE_AUDIT],
          actions: ["read", "artifact:create", "artifact:publish"],
        },
        delegatable: { resources: [], actions: [] },
        depth: 0,
        maxTokens: 1000,
        maxToolCalls: 2,
        maxChildren: 0,
        runId: "run-1",
        parentGrantId: governed.envelope.id,
        createdAt: new Date().toISOString(),
      });
      database.grantStates.push({
        grantId: childGrantId,
        revoked: false,
        tokensUsed: 0,
        childCount: 0,
      });
    });
    const child: AgentIdentity = {
      kind: "agent",
      principalId: childPrincipalId,
      grantId: childGrantId,
      runId: "run-1",
      principal: { id: childPrincipalId, kind: "agent" },
    };
    const deps = { store, ledger };

    const created = await createArtifact(
      child,
      { artifactType: ARTIFACT_SECURITY_FINDING, fields: { verdict: "expected" } },
      deps,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const published = await publishArtifact(
      child,
      created.value.id,
      {
        artifactType: ARTIFACT_SECURITY_FINDING,
        // Free prose in a permitted field: exactly what the gate exists for.
        fields: { verdict: "rmenon exported 47 payment records" },
      },
      deps,
    );
    expect(published.ok).toBe(false);
    if (!published.ok) expect(published.reason).toBe("ARTIFACT_SCHEMA_VIOLATION");
    expect(
      store.snapshot().governanceEvents.some((e) => e.kind === "artifact_rejected"),
    ).toBe(true);
  });
});
