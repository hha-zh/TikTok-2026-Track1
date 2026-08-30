/**
 * AB-01..AB-07 — Authority × Budget interaction.
 *
 * These are BACKEND VERIFICATION cases. They sit underneath the concrete
 * scenarios ("Todo with a relaxed budget", "a delegate-only incident slice")
 * and exist to make three statements deterministically checkable:
 *
 *   1. Permission does not imply affordability.
 *   2. Affordability cannot create permission.
 *   3. When several topologies are both authorized and affordable, agency
 *      expands only when its marginal benefit justifies the extra cost.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import { GovernanceLedger } from "../middleware/evidence/ledger.js";
import { ExecutionEngine } from "../middleware/adaptive/execution-engine.js";
import {
  buildCandidates,
  feasibleCandidates,
  isStructurallyNarrower,
} from "../middleware/adaptive/candidates.js";
import { route, type RoutingInputs } from "../middleware/adaptive/router.js";
import { task, type TaskSpec } from "../middleware/adaptive/task-graph.js";
import {
  RESOURCE_AUDIT,
  RESOURCE_METRICS,
  seedGovernanceFixtures,
  startGovernedRun,
} from "../middleware/governance/fixtures.js";
import { resolveGrant } from "../middleware/governance/grant-resolver.js";
import type { GovernanceState } from "../middleware/governance/types.js";
import {
  createTodoDelegationPort,
  TodoWorkspaceExecutor,
} from "../workload/todo/adapter.js";
import {
  buildTodoGraph,
  TASK_OPTIONAL_REVIEWER,
  TASK_TEST_PLAN,
  TASK_UI_PLAN,
} from "../workload/todo/graph.js";
import { seedTodoWorkload, TODO_DELEGATABLE_RESOURCES } from "../workload/todo/seed.js";
import { ARTIFACT_UI_PLAN } from "../workload/todo/artifacts.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const NOW = "2026-01-01T00:00:00.000Z";

interface HarnessOptions {
  burn?: number;
  /** Marks the root grant's children as already spent. */
  childrenUsed?: number;
  revoked?: boolean;
}

async function harness(options: HarnessOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ab-cases-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await seedGovernanceFixtures(store);
  await seedTodoWorkload(store);
  const ledger = new GovernanceLedger(store);
  const governed = await startGovernedRun(store, ledger, {
    runId: "run-1",
    additionalDelegatableResources: TODO_DELEGATABLE_RESOURCES,
  });
  if (options.burn) {
    await ledger.appendEvent(
      "tokens_consumed",
      {
        inputTokens: options.burn,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: options.burn,
      },
      {
        runId: "run-1",
        grantId: governed.envelope.id,
        principalId: governed.principal.id,
      },
    );
  }
  await store.mutate((database) => {
    const grantState = database.grantStates.find(
      (item) => item.grantId === governed.envelope.id,
    );
    if (!grantState) return;
    if (options.childrenUsed !== undefined) grantState.childCount = options.childrenUsed;
    if (options.revoked) grantState.revoked = true;
  });

  const resolution = resolveGrant(
    {
      principalId: governed.principal.id,
      grantId: governed.envelope.id,
      runId: "run-1",
    },
    store,
  );
  if (!resolution.ok) throw new Error("resolve failed: " + resolution.reason);

  return {
    store,
    ledger,
    governed,
    state: resolution.state,
    identity: {
      principal: governed.principal,
      grantId: governed.envelope.id,
      runId: "run-1",
    },
  };
}

const candidatesFor = (
  node: TaskSpec,
  state: GovernanceState,
  principal: GovernanceState["envelope"] extends never ? never : Parameters<typeof buildCandidates>[1]["principal"],
  parallelCapacity = 2,
) => buildCandidates(node, { principal, state, now: NOW, parallelCapacity });

const routeOne = (
  node: TaskSpec,
  candidates: ReturnType<typeof buildCandidates>,
  state: GovernanceState,
  overrides: Partial<RoutingInputs> = {},
) =>
  route({
    entries: [{ node, candidates }],
    effectiveBudgetRemaining: Math.min(
      state.envelope.maxTokens - state.grantState.tokensUsed,
      state.runState.maxTokens - state.runState.tokensUsed,
    ),
    runBudgetRemaining: state.runState.maxTokens - state.runState.tokensUsed,
    runCapTokens: state.runState.maxTokens,
    childSlotsRemaining: state.envelope.maxChildren - state.grantState.childCount,
    parallelCapacity: 2,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// The two views
// ---------------------------------------------------------------------------

describe("Authority and Budget are peer views on every candidate", () => {
  it("exposes an explicit AuthorityView and BudgetView", async () => {
    const { state, identity } = await harness();
    const node = task({
      id: "plan",
      resources: [],
      actions: ["model:invoke"],
      estimatedTokens: 100,
    });
    const [reuse, delegate] = candidatesFor(node, state, identity.principal);

    expect(reuse?.authority.requiredActions).toEqual(["model:invoke"]);
    expect(reuse?.authority.effectiveActions).toEqual(["model:invoke"]);
    expect(reuse?.budget.effectiveTokensRemaining).toBe(12_000);
    expect(reuse?.budget.estimatedTokens).toBe(100);
    expect(delegate?.budget.childSlotsRemaining).toBe(2);
    expect(delegate?.budget.depthRemaining).toBe(1);
    expect(delegate?.budget.parallelCapacity).toBe(2);
  });

  it("computes feasible as authority.legal AND budget.affordable", async () => {
    const { state, identity } = await harness();
    const node = task({ id: "plan", resources: [], actions: ["model:invoke"] });
    for (const candidate of candidatesFor(node, state, identity.principal)) {
      expect(candidate.feasible).toBe(
        candidate.authority.legal && candidate.budget.affordable,
      );
    }
  });

  it("keeps effective remaining as min(grant, run) and pressure on the run alone", async () => {
    const { store, governed, identity } = await harness();
    // Grant nearly spent, run barely touched.
    await store.mutate((database) => {
      const grantState = database.grantStates.find(
        (item) => item.grantId === governed.envelope.id,
      );
      if (grantState) grantState.tokensUsed = 11_000;
      const runState = database.runStates.find((item) => item.runId === "run-1");
      if (runState) runState.tokensUsed = 1_200;
    });
    const resolution = resolveGrant(
      { principalId: identity.principal.id, grantId: governed.envelope.id, runId: "run-1" },
      store,
    );
    if (!resolution.ok) throw new Error("resolve failed");
    const node = task({ id: "plan", resources: [], actions: ["model:invoke"] });
    const [reuse] = candidatesFor(node, resolution.state, identity.principal);

    expect(reuse?.budget.grantTokensRemaining).toBe(1_000);
    expect(reuse?.budget.runTokensRemaining).toBe(10_800);
    expect(reuse?.budget.effectiveTokensRemaining).toBe(1_000);
    // Not 1 - 1000/12000. The run is not scarce just because the grant is.
    expect(reuse?.budget.runPressure).toBeCloseTo(0.1, 5);
  });

  it("preserves the hard ReasonCode inside the authority view", async () => {
    const { state, identity } = await harness();
    const node = task({ id: "audit", resources: [RESOURCE_AUDIT], actions: ["read"] });
    const [reuse] = candidatesFor(node, state, identity.principal);
    expect(reuse?.authority.legal).toBe(false);
    expect(reuse?.authority.reason).toBe("NOT_EXERCISABLE_DELEGATE_ONLY");
    // The budget axis is untouched by an authority failure.
    expect(reuse?.budget.affordable).toBe(true);
  });

  it("detects a structurally narrower delegated scope truthfully", async () => {
    const { state } = await harness();
    // A planner child: one artifact type, no onward delegation.
    expect(
      isStructurallyNarrower(
        { resources: [ARTIFACT_UI_PLAN], actions: ["model:invoke", "artifact:publish"] },
        state.envelope,
      ),
    ).toBe(true);
    // Escalation is never "narrower".
    expect(
      isStructurallyNarrower(
        { resources: ["payments/private_incident.json"], actions: ["read"] },
        state.envelope,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AB-01 / AB-02 — the same workload, different runtime state
// ---------------------------------------------------------------------------

async function runTodo(burn: number, parallelCapacity = 2) {
  const { store, ledger, identity } = await harness({ burn });
  const engine = new ExecutionEngine({
    store,
    ledger,
    executor: new TodoWorkspaceExecutor(store, ledger),
    delegation: createTodoDelegationPort(store, ledger),
    policy: { parallelCapacity },
  });
  const result = await engine.run(buildTodoGraph(), identity);
  const routing = store
    .snapshot()
    .governanceEvents.filter((event) => event.kind === "routing_decision");
  const decisionFor = (taskId: string) =>
    routing.find((event) => (event.payload as { taskId: string }).taskId === taskId)
      ?.payload as
      | {
          placement: string | null;
          shape: string;
          candidates: { placement: string; feasible: boolean }[];
        }
      | undefined;
  return { result, decisionFor };
}

describe("AB-01 — Todo, relaxed budget", () => {
  it("delegates both planners and runs them in one parallel wave", async () => {
    const { result, decisionFor } = await runTodo(0);
    expect(result.outcome).toBe("COMPLETED");
    expect(decisionFor(TASK_UI_PLAN)?.placement).toBe("DELEGATE_SPECIALIST");
    expect(decisionFor(TASK_TEST_PLAN)?.placement).toBe("DELEGATE_SPECIALIST");
    expect(decisionFor(TASK_UI_PLAN)?.shape).toBe("PARALLEL");
    // Both placements were genuinely available; this was a choice, not a fallback.
    expect(decisionFor(TASK_UI_PLAN)?.candidates.every((item) => item.feasible)).toBe(
      true,
    );
  });
});

describe("AB-02 — the same Todo graph under budget pressure", () => {
  it("reuses and serialises with only the runtime budget changed", async () => {
    const { result, decisionFor } = await runTodo(10_200);
    expect(result.outcome).toBe("COMPLETED");
    expect(decisionFor(TASK_UI_PLAN)?.placement).toBe("REUSE_CURRENT");
    expect(decisionFor(TASK_TEST_PLAN)?.placement).toBe("REUSE_CURRENT");
    expect(decisionFor(TASK_UI_PLAN)?.shape).toBe("SERIAL");
    // Delegation stayed legal AND affordable; it simply stopped being worth it.
    const delegate = decisionFor(TASK_UI_PLAN)?.candidates.find(
      (item) => item.placement === "DELEGATE_SPECIALIST",
    );
    expect(delegate?.feasible).toBe(true);
    expect(result.progress.skipped.has(TASK_OPTIONAL_REVIEWER)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AB-03..AB-06 — the interaction statements
// ---------------------------------------------------------------------------

const auditTask = (overrides: Partial<TaskSpec> = {}) =>
  task({
    id: "incident_review",
    resources: [RESOURCE_AUDIT],
    actions: ["read"],
    estimatedTokens: 200,
    ...overrides,
  });

describe("AB-03 — authority forces topology expansion", () => {
  it("delegates because the current principal may cause but not perform it", async () => {
    const { state, identity } = await harness();
    const node = auditTask();
    const candidates = candidatesFor(node, state, identity.principal);
    const reuse = candidates.find((item) => item.placement === "REUSE_CURRENT");
    const delegate = candidates.find((item) => item.placement === "DELEGATE_SPECIALIST");

    expect(reuse?.authority.legal).toBe(false);
    expect(reuse?.authority.reason).toBe("NOT_EXERCISABLE_DELEGATE_ONLY");
    expect(reuse?.budget.affordable).toBe(true);
    expect(delegate?.authority.legal).toBe(true);
    expect(delegate?.budget.affordable).toBe(true);

    const plan = routeOne(node, candidates, state);
    expect(plan.assignments[0]?.placement).toBe("DELEGATE_SPECIALIST");
    expect(plan.assignments[0]?.disposition).toBe("RUN");
  });
});

describe("AB-04 — the only legal topology is unaffordable", () => {
  it("blocks when child capacity is spent, never falling back to illegal reuse", async () => {
    // Worth recording precisely: maxChildren is enforced by authorize(), so a
    // spent child slot is an AUTHORITY denial, not a budget one. The candidate
    // still carries both axes, and the budget axis is honest about capacity.
    const { state, identity } = await harness({ childrenUsed: 2 });
    const node = auditTask();
    const candidates = candidatesFor(node, state, identity.principal);
    const delegate = candidates.find((item) => item.placement === "DELEGATE_SPECIALIST");

    expect(delegate?.authority.legal).toBe(false);
    expect(delegate?.authority.reason).toBe("MAX_CHILDREN_EXCEEDED");
    expect(delegate?.budget.childSlotsRemaining).toBe(0);
    expect(delegate?.budget.reason).toBe("CHILD_CAPACITY_EXHAUSTED");
    expect(feasibleCandidates(candidates)).toHaveLength(0);

    const plan = routeOne(node, candidates, state, { childSlotsRemaining: 0 });
    expect(plan.assignments[0]?.disposition).toBe("BLOCKED");
    // Never rescued into the illegal placement.
    expect(plan.assignments[0]?.placement).toBeNull();
    expect(plan.blocked).toBe(true);
    // Both axes survive in the explanation.
    expect(plan.assignments[0]?.note).toContain("NOT_EXERCISABLE_DELEGATE_ONLY");
    expect(plan.assignments[0]?.note).toContain("CHILD_CAPACITY_EXHAUSTED");
  });

  it("terminates without reuse when the only legal topology cannot be afforded", async () => {
    // Tokens, not capacity: the estimate is pessimistic by design, so the
    // runtime waits under the defer ceiling and then terminates truthfully.
    const { store, ledger, identity } = await harness({ burn: 11_950 });
    const engine = new ExecutionEngine({
      store,
      ledger,
      executor: new TodoWorkspaceExecutor(store, ledger),
      delegation: createTodoDelegationPort(store, ledger),
      policy: { maxDeferPerTask: 2 },
    });
    const result = await engine.run(
      { id: "incident", nodes: [auditTask({ estimatedTokens: 5_000 })] },
      identity,
    );
    // A terminal outcome, and never a fallback into the illegal placement.
    expect(["DEFER_CEILING", "BLOCKED"]).toContain(result.outcome);
    expect(result.progress.completed.size).toBe(0);
    const routing = store
      .snapshot()
      .governanceEvents.filter((event) => event.kind === "routing_decision");
    expect(
      routing.every(
        (event) => (event.payload as { placement: string | null }).placement !== "REUSE_CURRENT",
      ),
    ).toBe(true);
  });

  it("blocks the same way when delegation depth is spent", async () => {
    const { state, identity } = await harness();
    const exhausted: GovernanceState = {
      ...state,
      envelope: { ...state.envelope, depth: 0 },
    };
    const node = auditTask();
    const candidates = candidatesFor(node, exhausted, identity.principal);
    const delegate = candidates.find((item) => item.placement === "DELEGATE_SPECIALIST");
    // Depth is checked by authorize() first, so this is an authority denial.
    expect(delegate?.authority.reason).toBe("DELEGATION_CEILING_REACHED");
    expect(feasibleCandidates(candidates)).toHaveLength(0);
    expect(routeOne(node, candidates, exhausted).assignments[0]?.disposition).toBe(
      "BLOCKED",
    );
  });
});

describe("AB-05 — affordability cannot create permission", () => {
  it("reuses when delegation is hard-illegal, however healthy the budget", async () => {
    const { state, identity } = await harness();
    // app/metrics is exercisable but NOT delegatable.
    const node = task({
      id: "read_metrics",
      resources: [RESOURCE_METRICS],
      actions: ["read"],
      estimatedTokens: 100,
      hints: { expectedUtilityGain: 0.99, expectedIncrementalCost: 1 },
    });
    const candidates = candidatesFor(node, state, identity.principal);
    const delegate = candidates.find((item) => item.placement === "DELEGATE_SPECIALIST");
    expect(delegate?.authority.legal).toBe(false);
    expect(delegate?.authority.reason).toBe("CHILD_EXCEEDS_PARENT");
    expect(delegate?.budget.affordable).toBe(true);

    // Enormous budget and a near-maximal declared benefit change nothing.
    const plan = routeOne(node, candidates, state, {
      effectiveBudgetRemaining: 10_000_000,
      runBudgetRemaining: 10_000_000,
      runCapTokens: 10_000_000,
      childSlotsRemaining: 99,
    });
    expect(plan.assignments[0]?.placement).toBe("REUSE_CURRENT");
  });
});

describe("AB-06 — revocation overrides budget", () => {
  it("blocks with the hard reason, unrescued by utility or isolation", async () => {
    const { state, identity } = await harness({ revoked: true });
    const node = task({
      id: "plan",
      resources: [],
      actions: ["model:invoke"],
      estimatedTokens: 100,
      hints: {
        expectedUtilityGain: 0.99,
        expectedIncrementalCost: 1,
        isolationPreference: "preferred",
      },
    });
    const candidates = candidatesFor(node, state, identity.principal);
    expect(candidates.every((item) => item.authority.legal === false)).toBe(true);
    expect(candidates.every((item) => item.authority.reason === "PARENT_GRANT_REVOKED")).toBe(
      true,
    );

    const plan = routeOne(node, candidates, state, {
      effectiveBudgetRemaining: 10_000_000,
      runBudgetRemaining: 10_000_000,
      runCapTokens: 10_000_000,
      childSlotsRemaining: 99,
    });
    expect(plan.assignments[0]?.disposition).toBe("BLOCKED");
    expect(plan.assignments[0]?.governanceReason).toBe("PARENT_GRANT_REVOKED");
    // The isolation hint contributed nothing, because delegation was illegal.
    expect(plan.assignments[0]?.authorityIsolationGain).toBe(0);
  });
});

describe("AB-07 — declared isolation preference (soft)", () => {
  // Below the threshold on its own; the isolation bonus is what carries it over.
  const modest = {
    expectedUtilityGain: 0.03,
    expectedIncrementalCost: 400,
  };

  it("reuses on a modest benefit without an isolation preference", async () => {
    const { state, identity } = await harness();
    const node = task({
      id: "plan",
      resources: [],
      actions: ["model:invoke"],
      estimatedTokens: 100,
      delegatedAuthority: {
        resources: [ARTIFACT_UI_PLAN],
        actions: ["model:invoke", "artifact:create", "artifact:publish"],
      },
      hints: modest,
    });
    const candidates = candidatesFor(node, state, identity.principal);
    expect(routeOne(node, candidates, state).assignments[0]?.placement).toBe(
      "REUSE_CURRENT",
    );
  });

  it("may cross the threshold when isolation is preferred and the child is narrower", async () => {
    const { state, identity } = await harness();
    const node = task({
      id: "plan",
      resources: [],
      actions: ["model:invoke"],
      estimatedTokens: 100,
      delegatedAuthority: {
        resources: [ARTIFACT_UI_PLAN],
        actions: ["model:invoke", "artifact:create", "artifact:publish"],
      },
      hints: { ...modest, isolationPreference: "preferred" },
    });
    const candidates = candidatesFor(node, state, identity.principal);
    const delegate = candidates.find((item) => item.placement === "DELEGATE_SPECIALIST");
    expect(delegate?.authority.structurallyNarrower).toBe(true);

    const plan = routeOne(node, candidates, state);
    expect(plan.assignments[0]?.placement).toBe("DELEGATE_SPECIALIST");
    expect(plan.assignments[0]?.authorityIsolationGain).toBeGreaterThan(0);
  });

  it("never makes REUSE hard-illegal", async () => {
    const { state, identity } = await harness();
    const node = task({
      id: "plan",
      resources: [],
      actions: ["model:invoke"],
      hints: { isolationPreference: "preferred" },
    });
    const candidates = candidatesFor(node, state, identity.principal);
    const reuse = candidates.find((item) => item.placement === "REUSE_CURRENT");
    // A routing hint must never become a second authorization system.
    expect(reuse?.authority.legal).toBe(true);
    expect(reuse?.authority.reason).toBe("AUTHORIZED");
    expect(reuse?.feasible).toBe(true);
  });
});
