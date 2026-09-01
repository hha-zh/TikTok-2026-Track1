import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../app.js";
import type { AgentService } from "../../agent-service.js";
import { loadConfig } from "../../config.js";
import { GovernanceLedger } from "../../middleware/evidence/ledger.js";
import { RunTokenService } from "../../middleware/governance/run-token.js";
import { TYPE_IDENTITY_VERIFICATION } from "./artifacts.js";
import { travelRunDescriptor } from "./evidence.js";
import { T0_UNDERSTAND, T1_TRANSPORT, T2_ACCOMMODATION, T4_IDENTITY, T5_VALIDATE } from "./graph.js";
import { PASSPORT_LEAK_CANARY, RESOURCE_PASSPORT } from "./resources.js";
import { runTravelLifecycle, type TravelLifecycleResult } from "./run.js";

let lifecycle: TravelLifecycleResult;
let app: FastifyInstance;
let body: { run: TravelLifecycleResult["view"] };

beforeAll(async () => {
  lifecycle = await runTravelLifecycle("travel-view-run");
  await lifecycle.store.mutate((database) => {
    database.principals.push({ id: "unrelated-human", kind: "human" });
    database.mockResources.push({ id: "private/unrelated", ownerId: "unrelated-human", domain: "private",
      body: { secret: "UNRELATED-PRIVATE-CANARY", run_token: "RUN-TOKEN-CANARY" } });
  });
  const service = { listAgents: () => [], systemInfo: async () => ({}) } as unknown as AgentService;
  app = await createApp(loadConfig({ NODE_ENV: "test" }), service, {
    store: lifecycle.store,
    runTokens: new RunTokenService(Buffer.alloc(32, 17)),
    ledger: new GovernanceLedger(lifecycle.store),
    governedRunDescriptor: (runId) => runId === lifecycle.runId
      ? travelRunDescriptor(lifecycle.oracle) : undefined,
  });
  const response = await app.inject({ method: "GET", url: `/api/governance/runs/${lifecycle.runId}`,
    headers: { "x-principal-id": "travel-user" } });
  expect(response.statusCode).toBe(200);
  body = response.json();
});

afterAll(async () => {
  await app.close();
  await lifecycle.cleanup();
});

const decision = (taskId: string) => body.run.routingDecisions.find((item) => item.taskId === taskId)!;

describe("Stage 7C stable governed-run evidence contract", () => {
  it("correlates the requested Travel run and safe workload identity", () => {
    expect(body.run.run.runId).toBe(lifecycle.runId);
    expect(body.run.run.workload).toEqual({
      id: "travel-disruption-v1",
      scenario: "cancelled-sin-to-tokyo-recovery",
      quality: "DECLARED",
    });
  });

  it("exposes the complete generic task lifecycle and dependencies", () => {
    expect(body.run.tasks).toHaveLength(7);
    expect(body.run.tasks.every((task) => task.status === "COMPLETED")).toBe(true);
    expect(body.run.tasks.find((task) => task.taskId === T4_IDENTITY)?.dependencies.value?.artifacts)
      .toEqual(["travel_constraints", "route_plan"]);
  });

  it("shows early REUSE and DIRECT from persisted routing evidence", () => {
    expect(decision(T0_UNDERSTAND)).toMatchObject({ who: "REUSE_CURRENT", how: "DIRECT" });
  });

  it("shows delegated parallel exploration from persisted routing evidence", () => {
    expect(decision(T1_TRANSPORT)).toMatchObject({ who: "DELEGATE_SPECIALIST", how: "PARALLEL" });
    expect(decision(T2_ACCOMMODATION)).toMatchObject({ who: "DELEGATE_SPECIALIST", how: "PARALLEL" });
  });

  it("preserves the exact passport denial", () => {
    expect(body.run.governanceEvents).toContainEqual(expect.objectContaining({
      category: "DENY", resourceId: RESOURCE_PASSPORT, verdict: "DENY",
      reasonCode: "NOT_EXERCISABLE_DELEGATE_ONLY",
    }));
    expect(body.run.governanceEvents.find((event) => event.category === "DENY"
      && event.resourceId === RESOURCE_PASSPORT)?.taskId).toBeUndefined();
    expect(body.run.governanceEvents).toContainEqual(expect.objectContaining({
      taskId: T4_IDENTITY, category: "ALLOW", resourceId: RESOURCE_PASSPORT,
      verdict: "ALLOW",
    }));
  });

  it("represents real parent-child grant relationships and runtime child kind", () => {
    expect(body.run.delegations).toHaveLength(3);
    expect(body.run.delegations.every((item) => item.parent.grantId === lifecycle.rootGrantId
      && item.child.kind === "runtime_delegated_agent")).toBe(true);
  });

  it("provides the identity specialist attenuation summary", () => {
    const identity = body.run.delegations.find((item) => item.taskId === T4_IDENTITY)!;
    expect(identity.attenuation.retained.resources).toEqual([RESOURCE_PASSPORT, TYPE_IDENTITY_VERIFICATION]);
    expect(identity.attenuation.retained.actions).toEqual(["read", "model:invoke", "artifact:create", "artifact:publish"]);
    expect(identity.attenuation.removed.childDelegation).toBe(true);
    expect(identity.attenuation.removed.resources).toContain("travel/transport_options");
  });

  it("exposes least-context ids without context values", () => {
    const context = body.run.contextProjections.find((item) => item.taskId === T4_IDENTITY)!;
    expect(context.includedArtifactIds).toEqual(["travel_constraints", "route_plan"]);
    expect(Object.keys(context)).not.toContain("values");
  });

  it("shows the bounded IdentityVerification Return Gate lifecycle", () => {
    const artifact = body.run.artifacts.find((item) => item.type === TYPE_IDENTITY_VERIFICATION)!;
    expect(artifact.taskId).toBe(T4_IDENTITY);
    expect(artifact.lifecycle).toMatchObject({ created: true, published: true, recipients: [lifecycle.rootPrincipalId] });
    expect(artifact.boundedFields).toEqual({ identity_verified: "yes", booking_name_matched: "yes",
      travel_document_valid: "yes", destination_eligible: "yes" });
  });

  it("does not expose raw passport or raw child output", () => {
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(PASSPORT_LEAK_CANARY);
    expect(serialized).not.toContain("documentIdentifier");
    expect(serialized).not.toContain("raw child");
  });

  it("does not expose RUN_TOKEN or unrelated private state", () => {
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("RUN-TOKEN-CANARY");
    expect(serialized).not.toContain("UNRELATED-PRIVATE-CANARY");
    expect(serialized.toLowerCase()).not.toContain("authorization");
  });

  it("shows runtime and root-grant token projections separately", () => {
    expect(body.run.runtimeState.budgetHorizon.runTokens).toEqual({ used: 9_400, cap: 12_000, remaining: 2_600 });
    expect(body.run.runtimeState.budgetHorizon.maxToolCalls.enforced).toBe(false);
    expect(body.run.authority.dimensions).toBe("PARALLEL_WITH_BUDGET_HORIZON");
  });

  it("correlates prior usage with the later T5 REUSE decision", () => {
    const later = decision(T5_VALIDATE);
    const usageBefore = body.run.usageFeedback.deltas.filter((item) => item.sequence < later.sequence)
      .reduce((sum, item) => sum + item.totalTokens, 0);
    expect(usageBefore).toBe(7_600);
    expect(later.who).toBe("REUSE_CURRENT");
    expect(later.horizon.runTokensRemaining).toBe(4_400);
    expect(body.run.usageFeedback.laterDecisionsReferenceProjectedState)
      .toEqual({ value: true, quality: "DERIVED" });
  });

  it("does not self-assert projected-state references when the recorded budget disagrees", async () => {
    const altered = await runTravelLifecycle("travel-view-altered-budget");
    try {
      await altered.store.mutate((database) => {
        const later = database.governanceEvents.find((event) => event.kind === "routing_decision"
          && (event.payload as { taskId?: string }).taskId === T5_VALIDATE);
        if (!later || later.kind !== "routing_decision") throw new Error("later decision missing");
        later.payload.budget.runTokensRemaining += 1;
      });
      const rebuilt = (await import("../../middleware/evidence/governed-run-view.js"))
        .buildGovernedRunView(altered.store, altered.runId, travelRunDescriptor(altered.oracle));
      expect(rebuilt?.usageFeedback.laterDecisionsReferenceProjectedState)
        .toEqual({ value: false, quality: "DERIVED" });
    } finally {
      await altered.cleanup();
    }
  });

  it("labels deterministic fixture provenance truthfully", () => {
    expect(body.run.usageFeedback.provenance).toEqual({ value: "DETERMINISTIC_SYNTHETIC_FIXTURE", quality: "DECLARED" });
    expect(body.run.tasks.every((task) => task.executionProvenance.value === "DETERMINISTIC_SYNTHETIC_FIXTURE")).toBe(true);
  });

  it("keeps domain constraints structurally separate from runtime budget", () => {
    expect(body.run.outcome.domain?.value?.summary).toMatchObject({
      spendingConstraint: { currency: "SGD", maximumAdditionalSpend: 700 },
      approvalPolicy: { currency: "SGD", threshold: 300 },
    });
    expect(body.run.outcome.runtime).toMatchObject({ status: "COMPLETED", completedTasks: 7, failedTasks: 0 });
  });

  it("exposes domain, governance, adaptive, and lifecycle oracle results separately", () => {
    expect(Object.values(body.run.outcome.domain!.value!.oracle).every(Boolean)).toBe(true);
    expect(Object.values(body.run.outcome.governanceOracle!.value!).every(Boolean)).toBe(true);
    expect(Object.values(body.run.outcome.adaptiveOracle!.value!).every(Boolean)).toBe(true);
    expect(Object.values(body.run.outcome.lifecycleOracle!.value!).every(Boolean)).toBe(true);

    // Stage 7D.4: the workload's verdict on itself must be distinguishable from
    // ledger-derived runtime facts sitting in the same outcome object.
    expect(body.run.outcome.runtime.quality).toBe("DERIVED");
    expect(body.run.outcome.runtime.source).toBe("LEDGER");
    for (const block of ["domain", "governanceOracle", "adaptiveOracle", "lifecycleOracle"] as const) {
      expect(body.run.outcome[block]!.quality).toBe("DECLARED");
      expect(body.run.outcome[block]!.source).toBe("WORKLOAD_DESCRIPTOR");
    }
  });

  it("shows truthful explicit revocation for every delegated grant", () => {
    expect(body.run.delegations.every((item) => item.child.lifecycle === "REVOKED")).toBe(true);
    expect(body.run.governanceEvents.filter((item) => item.category === "REVOKE")).toHaveLength(3);
  });

  it("requires the owning human and conceals unrelated runs", async () => {
    const unauthenticated = await app.inject({ method: "GET", url: `/api/governance/runs/${lifecycle.runId}` });
    expect(unauthenticated.statusCode).toBe(401);
    const unrelated = await app.inject({ method: "GET", url: `/api/governance/runs/${lifecycle.runId}`,
      headers: { "x-principal-id": "unrelated-human" } });
    expect(unrelated.statusCode).toBe(404);
  });
});
