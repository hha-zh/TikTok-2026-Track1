import { describe, expect, it } from "vitest";
import type { Envelope, GovernanceState, Principal } from "../governance/types.js";
import {
  PARENT_DELEGATABLE_ACTIONS,
  PARENT_DELEGATABLE_RESOURCES,
  PARENT_EXERCISABLE_ACTIONS,
  PARENT_EXERCISABLE_RESOURCES,
  RESOURCE_AUDIT,
  RESOURCE_METRICS,
  RESOURCE_PAYMENTS,
} from "../governance/fixtures.js";
import { buildCandidates, legalCandidates } from "./candidates.js";
import { deriveExecutionEnvelope, isNarrowing } from "./execution-envelope.js";
import { delegationThreshold, delegationValue, route } from "./router.js";
import {
  availableArtifacts,
  isComplete,
  readyNodes,
  task,
  unreachableNodes,
  validateGraph,
  type TaskGraph,
  type TaskSpec,
} from "./task-graph.js";

const NOW = "2026-01-01T00:00:00.000Z";
const PRINCIPAL: Principal = { id: "agent-parent", kind: "agent", ownerId: "wtan" };

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "grant-parent",
    principalId: PRINCIPAL.id,
    exercisable: {
      resources: [...PARENT_EXERCISABLE_RESOURCES],
      actions: [...PARENT_EXERCISABLE_ACTIONS],
    },
    delegatable: {
      resources: [...PARENT_DELEGATABLE_RESOURCES],
      actions: [...PARENT_DELEGATABLE_ACTIONS],
    },
    depth: 1,
    maxTokens: 12_000,
    maxToolCalls: 40,
    maxChildren: 2,
    runId: "run-1",
    createdAt: NOW,
    ...overrides,
  };
}

function state(overrides: Partial<GovernanceState> = {}): GovernanceState {
  return {
    envelope: envelope(),
    ancestry: [],
    grantState: { grantId: "grant-parent", revoked: false, tokensUsed: 0, childCount: 0 },
    runState: { runId: "run-1", maxTokens: 12_000, tokensUsed: 0 },
    now: NOW,
    ...overrides,
  };
}

const context = (governanceState = state()) => ({
  principal: PRINCIPAL,
  state: governanceState,
  now: NOW,
});

/** Legal both ways: no resource, and model:invoke is exercisable AND delegatable. */
const reasoning = (id: string, overrides: Partial<TaskSpec> = {}) =>
  task({ id, resources: [], actions: ["model:invoke"], ...overrides });

describe("Invocation ExecutionEnvelope", () => {
  it("narrows to principal ∩ task and never widens", () => {
    const view = deriveExecutionEnvelope({
      state: state(),
      task: task({ id: "a", resources: [RESOURCE_METRICS, RESOURCE_PAYMENTS] }),
    });
    // payments is not exercisable, so it is not in the effective view at all.
    expect(view.effective.resources).toEqual([RESOURCE_METRICS]);
    expect(isNarrowing(view, state())).toBe(true);
  });

  it("applies policy as a further narrowing, never as a grant", () => {
    const base = state();
    const withPolicy = deriveExecutionEnvelope({
      state: base,
      task: task({ id: "a", resources: [...PARENT_EXERCISABLE_RESOURCES] }),
      policy: { resources: [RESOURCE_METRICS] },
    });
    expect(withPolicy.effective.resources).toEqual([RESOURCE_METRICS]);

    // A policy naming something the principal does not hold cannot add it.
    const overreaching = deriveExecutionEnvelope({
      state: base,
      task: task({ id: "a", resources: [RESOURCE_PAYMENTS] }),
      policy: { resources: [RESOURCE_PAYMENTS] },
    });
    expect(overreaching.effective.resources).toEqual([]);
    expect(isNarrowing(overreaching, base)).toBe(true);
  });

  it("records where the authority came from without becoming it", () => {
    const view = deriveExecutionEnvelope({ state: state(), task: reasoning("a") });
    expect(view.sourceGrantId).toBe("grant-parent");
    expect(view.executorPrincipalId).toBe(PRINCIPAL.id);
    // A view, not a verdict: it carries no allow/deny of any kind.
    expect(Object.keys(view)).not.toContain("verdict");
  });

  it("exposes a budget view that mirrors min(grant, run) and its pressure", () => {
    const tight = state({
      grantState: { grantId: "grant-parent", revoked: false, tokensUsed: 11_000, childCount: 0 },
      runState: { runId: "run-1", maxTokens: 12_000, tokensUsed: 3_000 },
    });
    const view = deriveExecutionEnvelope({ state: tight, task: reasoning("a") });
    expect(view.budget.grantRemaining).toBe(1_000);
    expect(view.budget.runRemaining).toBe(9_000);
    expect(view.budget.effectiveRemaining).toBe(1_000);
    expect(view.budget.pressure).toBeCloseTo(1 - 1_000 / 12_000, 5);
  });
});

describe("TaskGraph", () => {
  it("settles dependsOn by completion or skip", () => {
    const graph: TaskGraph = {
      id: "g",
      nodes: [task({ id: "a", optional: true }), task({ id: "b", dependsOn: ["a"] })],
    };
    expect(validateGraph(graph)).toEqual({ ok: true });
    const ready = readyNodes(graph, { completed: new Set(), skipped: new Set(["a"]) });
    // Ordering only, so one dropped optional task does not stall the rest.
    expect(ready.map((item) => item.id)).toEqual(["b"]);
  });

  it("does NOT satisfy a required artifact with a skipped producer", () => {
    const graph: TaskGraph = {
      id: "g",
      nodes: [
        task({ id: "scan", optional: true, producedArtifacts: ["workspace_summary"] }),
        task({ id: "plan", requiredArtifacts: ["workspace_summary"] }),
      ],
    };
    // A skipped task produced nothing; running `plan` would use an input that
    // does not exist.
    expect(
      readyNodes(graph, { completed: new Set(), skipped: new Set(["scan"]) }),
    ).toEqual([]);
    expect(
      readyNodes(graph, { completed: new Set(["scan"]), skipped: new Set() }).map(
        (item) => item.id,
      ),
    ).toEqual(["plan"]);
  });

  it("reports a task whose artifact can no longer be produced as unreachable", () => {
    const graph: TaskGraph = {
      id: "g",
      nodes: [
        task({ id: "scan", producedArtifacts: ["workspace_summary"] }),
        task({ id: "plan", requiredArtifacts: ["workspace_summary"] }),
      ],
    };
    const stalled = unreachableNodes(graph, {
      completed: new Set(),
      skipped: new Set(["scan"]),
    });
    // Without this the run looks stalled rather than blocked.
    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.node.id).toBe("plan");
    expect(stalled[0]?.missingArtifacts).toEqual(["workspace_summary"]);
    expect(unreachableNodes(graph)).toEqual([]);
  });

  it("tracks artifacts from completed tasks only", () => {
    const graph: TaskGraph = {
      id: "g",
      nodes: [
        task({ id: "a", producedArtifacts: ["x"] }),
        task({ id: "b", producedArtifacts: ["y"] }),
      ],
    };
    expect([
      ...availableArtifacts(graph, {
        completed: new Set(["a"]),
        skipped: new Set(["b"]),
      }),
    ]).toEqual(["x"]);
  });

  it("rejects an artifact nobody produces, and a cycle through artifacts", () => {
    const orphan = validateGraph({
      id: "g",
      nodes: [task({ id: "a", requiredArtifacts: ["ghost"] })],
    });
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) {
      expect(orphan.problems).toContainEqual({
        kind: "unproducible_artifact",
        nodeId: "a",
        artifact: "ghost",
      });
    }

    // An artifact requirement is as real an ordering edge as dependsOn.
    const cyclic = validateGraph({
      id: "g",
      nodes: [
        task({ id: "a", requiredArtifacts: ["y"], producedArtifacts: ["x"] }),
        task({ id: "b", requiredArtifacts: ["x"], producedArtifacts: ["y"] }),
      ],
    });
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) {
      expect(cyclic.problems).toContainEqual({ kind: "cycle", nodeIds: ["a", "b"] });
    }
  });

  it("is complete once every task is settled either way", () => {
    const graph: TaskGraph = { id: "g", nodes: [task({ id: "a" }), task({ id: "b" })] };
    expect(isComplete(graph, { completed: new Set(["a"]), skipped: new Set(["b"]) })).toBe(
      true,
    );
  });
});

describe("CandidateBuilder", () => {
  it("marks reuse legal for a resource the principal may read itself", () => {
    const candidates = buildCandidates(
      task({ id: "a", resources: [RESOURCE_METRICS], actions: ["read"] }),
      context(),
    );
    const reuse = candidates.find((item) => item.placement === "REUSE_CURRENT");
    expect(reuse?.legal).toBe(true);
    expect(reuse?.executionEnvelope?.effective.resources).toEqual([RESOURCE_METRICS]);
  });

  it("routes a delegate-only resource to delegation, not to reuse", () => {
    const candidates = buildCandidates(
      task({ id: "a", resources: [RESOURCE_AUDIT], actions: ["read"] }),
      context(),
    );
    expect(candidates.find((i) => i.placement === "REUSE_CURRENT")?.reason).toBe(
      "NOT_EXERCISABLE_DELEGATE_ONLY",
    );
    expect(candidates.find((i) => i.placement === "DELEGATE_SPECIALIST")?.legal).toBe(
      true,
    );
  });

  it("finds no legal placement for a resource in neither authority set", () => {
    const candidates = buildCandidates(
      task({ id: "a", resources: [RESOURCE_PAYMENTS], actions: ["read"] }),
      context(),
    );
    expect(legalCandidates(candidates)).toHaveLength(0);
  });

  it("reports the capacity denial, not a scope denial, when depth is exhausted", () => {
    const exhausted = state({ envelope: envelope({ depth: 0 }) });
    const candidates = buildCandidates(
      task({ id: "a", resources: [RESOURCE_AUDIT], actions: ["read"] }),
      context(exhausted),
    );
    expect(candidates.find((i) => i.placement === "DELEGATE_SPECIALIST")?.reason).toBe(
      "DELEGATION_CEILING_REACHED",
    );
  });

  it("passes a governance denial through untouched", () => {
    const revoked = state({
      grantState: { grantId: "grant-parent", revoked: true, tokensUsed: 0, childCount: 0 },
    });
    const candidates = buildCandidates(
      task({ id: "a", resources: [RESOURCE_METRICS] }),
      context(revoked),
    );
    expect(candidates.every((i) => i.reason === "PARENT_GRANT_REVOKED")).toBe(true);
  });

  it("finds a resource-free reasoning task legal both ways", () => {
    // This is where the adaptive choice actually lives.
    const candidates = buildCandidates(reasoning("a"), context());
    expect(legalCandidates(candidates)).toHaveLength(2);
  });
});

describe("Router — WHO", () => {
  const entry = (item: TaskSpec, governanceState = state()) => ({
    node: item,
    candidates: buildCandidates(item, context(governanceState)),
  });
  const inputs = (entries: ReturnType<typeof entry>[], overrides = {}) => ({
    entries,
    budgetRemaining: 12_000,
    runCapTokens: 12_000,
    childSlotsRemaining: 2,
    ...overrides,
  });

  it("reuses when both are legal and nothing suggests extra agency is worth it", () => {
    const plan = route(inputs([entry(reasoning("a"))]));
    expect(plan.assignments[0]?.placement).toBe("REUSE_CURRENT");
    expect(plan.assignments[0]?.note).toContain("no declared benefit");
  });

  it("delegates when a specialist is declared required", () => {
    const plan = route(
      inputs([entry(reasoning("a", { hints: { specialistRequired: true } }))]),
    );
    expect(plan.assignments[0]?.placement).toBe("DELEGATE_SPECIALIST");
    expect(plan.assignments[0]?.note).toContain("specialist declared required");
  });

  it("delegates when declared marginal benefit clears the threshold", () => {
    const plan = route(
      inputs([
        entry(
          reasoning("a", {
            hints: { expectedUtilityGain: 0.9, expectedIncrementalCost: 200 },
          }),
        ),
      ]),
    );
    expect(plan.assignments[0]?.placement).toBe("DELEGATE_SPECIALIST");
    expect(plan.assignments[0]?.delegationValue).toBeGreaterThanOrEqual(
      plan.assignments[0]?.delegationThreshold ?? 0,
    );
  });

  it("raises the delegation bar as budget pressure rises", () => {
    const hints = { expectedUtilityGain: 0.2, expectedIncrementalCost: 400 };
    const relaxed = route(inputs([entry(reasoning("a", { hints }))]));
    const pressured = route(
      inputs([entry(reasoning("a", { hints }))], { budgetRemaining: 900 }),
    );
    // Same declared benefit, different answer, because the budget is nearly spent.
    expect(delegationThreshold(12_000, 12_000)).toBeLessThan(
      delegationThreshold(900, 12_000),
    );
    expect(relaxed.assignments[0]?.placement).toBe("DELEGATE_SPECIALIST");
    expect(pressured.assignments[0]?.placement).toBe("REUSE_CURRENT");
    expect(pressured.assignments[0]?.note).toContain("below threshold");
  });

  it("scores no declared hints as zero rather than guessing", () => {
    expect(delegationValue(reasoning("a"), 12_000)).toBe(0);
  });

  it("still delegates when only delegation is legal, hints or not", () => {
    const plan = route(inputs([entry(task({ id: "a", resources: [RESOURCE_AUDIT] }))]));
    expect(plan.assignments[0]?.placement).toBe("DELEGATE_SPECIALIST");
    expect(plan.assignments[0]?.note).toContain("may cause this but not perform it");
  });

  it("skips an optional impossible task and blocks a required one", () => {
    const optional = route(
      inputs([entry(task({ id: "a", resources: [RESOURCE_PAYMENTS], optional: true }))]),
    );
    expect(optional.assignments[0]?.disposition).toBe("SKIP");
    expect(optional.blocked).toBe(false);

    const required = route(
      inputs([entry(task({ id: "a", resources: [RESOURCE_PAYMENTS] }))]),
    );
    expect(required.assignments[0]?.disposition).toBe("BLOCKED");
    expect(required.blocked).toBe(true);
  });

  it("never invents an allow for a task governance denied", () => {
    const revoked = state({
      grantState: { grantId: "grant-parent", revoked: true, tokensUsed: 0, childCount: 0 },
    });
    const plan = route(
      inputs([entry(task({ id: "a", resources: [RESOURCE_METRICS] }), revoked)], {
        budgetRemaining: 999_999,
        childSlotsRemaining: 9,
      }),
    );
    // Generous budget and spare slots must not rescue a revoked grant.
    expect(plan.assignments[0]?.disposition).toBe("BLOCKED");
    expect(plan.assignments[0]?.governanceReason).toBe("PARENT_GRANT_REVOKED");
  });

  it("defers rather than dropping when only delegation is legal and slots are gone", () => {
    const plan = route(
      inputs([entry(task({ id: "a", resources: [RESOURCE_AUDIT] }))], {
        childSlotsRemaining: 0,
      }),
    );
    expect(plan.assignments[0]?.disposition).toBe("DEFER");
  });
});

describe("Router — HOW", () => {
  const audit = (id: string, independent: boolean) =>
    task({ id, resources: [RESOURCE_AUDIT], hints: { independent } });
  const entry = (item: TaskSpec) => ({
    node: item,
    candidates: buildCandidates(item, context()),
  });

  it("is DIRECT for a single unit of work", () => {
    const plan = route({
      entries: [entry(audit("a", true))],
      budgetRemaining: 12_000,
      runCapTokens: 12_000,
      childSlotsRemaining: 2,
    });
    expect(plan.shape).toBe("DIRECT");
  });

  it("is PARALLEL only for independent delegations with budget headroom", () => {
    const plan = route({
      entries: [entry(audit("a", true)), entry(audit("b", true))],
      budgetRemaining: 12_000,
      runCapTokens: 12_000,
      childSlotsRemaining: 2,
    });
    expect(plan.shape).toBe("PARALLEL");
  });

  it("serialises two independent delegations when headroom is thin", () => {
    // HOW is not a consequence of WHO: same two delegations, different mode.
    const plan = route({
      entries: [entry(audit("a", true)), entry(audit("b", true))],
      budgetRemaining: 250,
      runCapTokens: 12_000,
      childSlotsRemaining: 2,
    });
    expect(plan.shape).toBe("SERIAL");
    expect(plan.shapeReason).toContain("headroom");
    expect(plan.assignments.map((item) => item.disposition)).toEqual([
      "DEGRADE",
      "DEGRADE",
    ]);
  });

  it("serialises delegations that are not declared independent", () => {
    const plan = route({
      entries: [entry(audit("a", false)), entry(audit("b", false))],
      budgetRemaining: 12_000,
      runCapTokens: 12_000,
      childSlotsRemaining: 2,
    });
    expect(plan.shape).toBe("SERIAL");
    expect(plan.shapeReason).toContain("not declared independent");
  });

  it("serialises two reuses: one principal cannot run two things at once", () => {
    const plan = route({
      entries: [
        entry(reasoning("a", { hints: { independent: true } })),
        entry(reasoning("b", { hints: { independent: true } })),
      ],
      budgetRemaining: 12_000,
      runCapTokens: 12_000,
      childSlotsRemaining: 2,
    });
    expect(plan.assignments.every((item) => item.placement === "REUSE_CURRENT")).toBe(
      true,
    );
    expect(plan.shape).toBe("SERIAL");
  });
});
