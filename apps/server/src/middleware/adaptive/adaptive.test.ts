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
import {
  DEFAULT_ROUTER_POLICY,
  delegationThreshold,
  delegationValue,
  route,
  type RoutingInputs,
} from "./router.js";
import {
  availableArtifacts,
  isComplete,
  missingPromisedArtifacts,
  readyNodes,
  task,
  unreachableNodes,
  validateGraph,
  type GraphProgress,
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

const progress = (overrides: Partial<GraphProgress> = {}): GraphProgress => ({
  completed: new Set<string>(),
  skipped: new Set<string>(),
  artifacts: new Set<string>(),
  ...overrides,
});

/** Legal both ways: no resource, and model:invoke is exercisable AND delegatable. */
const reasoning = (id: string, overrides: Partial<TaskSpec> = {}) =>
  task({ id, resources: [], actions: ["model:invoke"], ...overrides });

const auditTask = (id: string, overrides: Partial<TaskSpec> = {}) =>
  task({ id, resources: [RESOURCE_AUDIT], ...overrides });

const entryFor = (item: TaskSpec, governanceState = state()) => ({
  node: item,
  candidates: buildCandidates(item, context(governanceState)),
});

const inputs = (
  entries: RoutingInputs["entries"],
  overrides: Partial<RoutingInputs> = {},
): RoutingInputs => ({
  entries,
  effectiveBudgetRemaining: 12_000,
  runBudgetRemaining: 12_000,
  runCapTokens: 12_000,
  childSlotsRemaining: 2,
  parallelCapacity: 2,
  ...overrides,
});

describe("Invocation ExecutionEnvelope", () => {
  it("narrows to principal ∩ task and never widens", () => {
    const metricsView = deriveExecutionEnvelope({
      state: state(),
      task: task({ id: "a", resources: [RESOURCE_METRICS, RESOURCE_PAYMENTS] }),
    });
    const reasoningView = deriveExecutionEnvelope({
      state: state(),
      task: task({ id: "b", resources: [] }),
    });
    expect(metricsView.principalId).toBe(reasoningView.principalId);
    expect(metricsView.effective.resources).toEqual([RESOURCE_METRICS]);
    expect(reasoningView.effective.resources).toEqual([]);
    expect(isNarrowing(metricsView, state())).toBe(true);
    expect(isNarrowing(reasoningView, state())).toBe(true);
  });

  it("applies policy as further narrowing, never as a grant", () => {
    const base = state();
    const overreaching = deriveExecutionEnvelope({
      state: base,
      task: task({ id: "a", resources: [RESOURCE_PAYMENTS] }),
      policy: { resources: [RESOURCE_PAYMENTS] },
    });
    expect(overreaching.effective.resources).toEqual([]);
    expect(isNarrowing(overreaching, base)).toBe(true);
  });

  it("keeps effective budget and run pressure as separate numbers", () => {
    // Grant nearly spent, run barely touched. Reporting run pressure from the
    // min would claim scarcity in the run that does not exist.
    const tight = state({
      grantState: { grantId: "grant-parent", revoked: false, tokensUsed: 11_000, childCount: 0 },
      runState: { runId: "run-1", maxTokens: 12_000, tokensUsed: 1_200 },
    });
    const view = deriveExecutionEnvelope({ state: tight, task: reasoning("a") });
    expect(view.budget.effectiveRemaining).toBe(1_000);
    expect(view.budget.runRemaining).toBe(10_800);
    expect(view.budget.runPressure).toBeCloseTo(0.1, 5);
  });
});

describe("TaskGraph", () => {
  it("settles dependsOn by completion or skip", () => {
    const graph: TaskGraph = {
      id: "g",
      nodes: [task({ id: "a", optional: true }), task({ id: "b", dependsOn: ["a"] })],
    };
    expect(validateGraph(graph)).toEqual({ ok: true });
    expect(
      readyNodes(graph, progress({ skipped: new Set(["a"]) })).map((item) => item.id),
    ).toEqual(["b"]);
  });

  it("treats committed artifacts, not task status, as the source of truth", () => {
    const graph: TaskGraph = {
      id: "g",
      nodes: [
        task({ id: "scan", producedArtifacts: ["workspace_summary"] }),
        task({ id: "plan", requiredArtifacts: ["workspace_summary"] }),
      ],
    };
    // Completed but nothing committed: the promise is not its own evidence.
    expect(readyNodes(graph, progress({ completed: new Set(["scan"]) }))).toEqual([]);
    expect(
      readyNodes(
        graph,
        progress({
          completed: new Set(["scan"]),
          artifacts: new Set(["workspace_summary"]),
        }),
      ).map((item) => item.id),
    ).toEqual(["plan"]);
  });

  it("does not satisfy a required artifact from a skipped producer", () => {
    const graph: TaskGraph = {
      id: "g",
      nodes: [
        task({ id: "scan", optional: true, producedArtifacts: ["workspace_summary"] }),
        task({ id: "plan", requiredArtifacts: ["workspace_summary"] }),
      ],
    };
    expect(readyNodes(graph, progress({ skipped: new Set(["scan"]) }))).toEqual([]);
  });

  it("reports a task whose artifact can no longer be produced as unreachable", () => {
    const graph: TaskGraph = {
      id: "g",
      nodes: [
        task({ id: "scan", producedArtifacts: ["workspace_summary"] }),
        task({ id: "plan", requiredArtifacts: ["workspace_summary"] }),
      ],
    };
    const stalled = unreachableNodes(graph, progress({ skipped: new Set(["scan"]) }));
    expect(stalled.map((item) => item.node.id)).toEqual(["plan"]);
    expect(unreachableNodes(graph, progress())).toEqual([]);
  });

  it("names promised artifacts a task did not actually produce", () => {
    const scan = task({ id: "scan", producedArtifacts: ["workspace_summary", "tree"] });
    expect(missingPromisedArtifacts(scan, new Set(["tree"]))).toEqual([
      "workspace_summary",
    ]);
    expect(missingPromisedArtifacts(scan, new Set(["workspace_summary", "tree"]))).toEqual(
      [],
    );
  });

  it("rejects two producers of the same artifact name", () => {
    // Alternative producers would make the ordering edges ambiguous.
    const result = validateGraph({
      id: "g",
      nodes: [
        task({ id: "a", producedArtifacts: ["summary"] }),
        task({ id: "b", producedArtifacts: ["summary"] }),
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toContainEqual({
        kind: "duplicate_artifact_producer",
        artifact: "summary",
        nodeIds: ["a", "b"],
      });
    }
  });

  it("rejects an artifact nobody produces, and a cycle through artifacts", () => {
    const orphan = validateGraph({
      id: "g",
      nodes: [task({ id: "a", requiredArtifacts: ["ghost"] })],
    });
    expect(orphan.ok).toBe(false);

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
    expect(
      isComplete(graph, progress({ completed: new Set(["a"]), skipped: new Set(["b"]) })),
    ).toBe(true);
    expect(availableArtifacts(graph, progress({ artifacts: new Set(["x"]) }))).toEqual(
      new Set(["x"]),
    );
  });
});

describe("CandidateBuilder", () => {
  it("marks reuse legal for a resource the principal may read itself", () => {
    const candidates = buildCandidates(
      task({ id: "a", resources: [RESOURCE_METRICS], actions: ["read"] }),
      context(),
    );
    expect(candidates.find((i) => i.placement === "REUSE_CURRENT")?.legal).toBe(true);
  });

  it("routes a delegate-only resource to delegation, not to reuse", () => {
    const candidates = buildCandidates(auditTask("a"), context());
    expect(candidates.find((i) => i.placement === "REUSE_CURRENT")?.reason).toBe(
      "NOT_EXERCISABLE_DELEGATE_ONLY",
    );
    expect(candidates.find((i) => i.placement === "DELEGATE_SPECIALIST")?.legal).toBe(true);
  });

  it("finds no legal placement for a resource in neither authority set", () => {
    const candidates = buildCandidates(
      task({ id: "a", resources: [RESOURCE_PAYMENTS] }),
      context(),
    );
    expect(legalCandidates(candidates)).toHaveLength(0);
  });

  it("reports the capacity denial, not a scope denial, when depth is exhausted", () => {
    const exhausted = state({ envelope: envelope({ depth: 0 }) });
    const candidates = buildCandidates(auditTask("a"), context(exhausted));
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
    expect(legalCandidates(buildCandidates(reasoning("a"), context()))).toHaveLength(2);
  });
});

describe("Router — WHO", () => {
  it("reuses when both are legal and nothing suggests extra agency is worth it", () => {
    const plan = route(inputs([entryFor(reasoning("a"))]));
    expect(plan.assignments[0]?.placement).toBe("REUSE_CURRENT");
  });

  it("delegates when a specialist is declared required", () => {
    const plan = route(
      inputs([entryFor(reasoning("a", { hints: { specialistRequired: true } }))]),
    );
    expect(plan.assignments[0]?.placement).toBe("DELEGATE_SPECIALIST");
  });

  it("raises the delegation bar from RUN pressure, not from the grant cap", () => {
    const hints = { expectedUtilityGain: 0.2, expectedIncrementalCost: 400 };
    const relaxed = route(inputs([entryFor(reasoning("a", { hints }))]));
    const pressured = route(
      inputs([entryFor(reasoning("a", { hints }))], {
        runBudgetRemaining: 900,
        effectiveBudgetRemaining: 900,
      }),
    );
    expect(relaxed.assignments[0]?.placement).toBe("DELEGATE_SPECIALIST");
    expect(pressured.assignments[0]?.placement).toBe("REUSE_CURRENT");

    // A squeezed GRANT with a roomy RUN must not raise the bar: that scarcity
    // is not the run's, and delegating spends the run's ceiling.
    const grantSqueezed = route(
      inputs([entryFor(reasoning("a", { hints }))], {
        effectiveBudgetRemaining: 900,
        runBudgetRemaining: 12_000,
      }),
    );
    expect(delegationThreshold(12_000, 12_000)).toBeLessThan(
      delegationThreshold(900, 12_000),
    );
    expect(grantSqueezed.assignments[0]?.delegationThreshold).toBe(
      delegationThreshold(12_000, 12_000),
    );
  });

  it("takes routing constants from an injected policy", () => {
    const hints = { expectedUtilityGain: 0.2, expectedIncrementalCost: 400 };
    const strict = route(
      inputs([entryFor(reasoning("a", { hints }))], {
        policy: { baseThreshold: 100 },
      }),
    );
    expect(strict.assignments[0]?.placement).toBe("REUSE_CURRENT");
    expect(DEFAULT_ROUTER_POLICY.baseThreshold).toBe(1);
  });

  it("scores no declared hints as zero rather than guessing", () => {
    expect(delegationValue(reasoning("a"))).toBe(0);
  });

  it("skips an optional impossible task and blocks a required one", () => {
    const optional = route(
      inputs([entryFor(task({ id: "a", resources: [RESOURCE_PAYMENTS], optional: true }))]),
    );
    expect(optional.assignments[0]?.disposition).toBe("SKIP");

    const required = route(
      inputs([entryFor(task({ id: "a", resources: [RESOURCE_PAYMENTS] }))]),
    );
    expect(required.assignments[0]?.disposition).toBe("BLOCKED");
    expect(required.blocked).toBe(true);
  });

  it("never invents an allow for a task governance denied", () => {
    const revoked = state({
      grantState: { grantId: "grant-parent", revoked: true, tokensUsed: 0, childCount: 0 },
    });
    const plan = route(
      inputs([entryFor(task({ id: "a", resources: [RESOURCE_METRICS] }), revoked)], {
        effectiveBudgetRemaining: 999_999,
        runBudgetRemaining: 999_999,
        childSlotsRemaining: 9,
        parallelCapacity: 9,
      }),
    );
    expect(plan.assignments[0]?.disposition).toBe("BLOCKED");
    expect(plan.assignments[0]?.governanceReason).toBe("PARENT_GRANT_REVOKED");
  });
});

describe("Router — HOW", () => {
  const independentAudit = (id: string) => auditTask(id, { hints: { independent: true } });
  const independentReasoning = (id: string) =>
    reasoning(id, { hints: { independent: true } });

  it("is DIRECT for a single unit of work", () => {
    expect(route(inputs([entryFor(independentAudit("a"))])).shape).toBe("DIRECT");
  });

  it("runs an independent REUSE alongside an independent DELEGATE", () => {
    // Distinct executors: the current principal and a child. This is the case
    // a 'two delegations' rule would have missed.
    const plan = route(
      inputs([entryFor(independentReasoning("a")), entryFor(independentAudit("b"))]),
    );
    expect(plan.assignments[0]?.placement).toBe("REUSE_CURRENT");
    expect(plan.assignments[1]?.placement).toBe("DELEGATE_SPECIALIST");
    expect(plan.shape).toBe("PARALLEL");
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0]?.nodeIds).toEqual(["a", "b"]);
  });

  it("serialises two REUSE tasks: one principal cannot run two at once", () => {
    const plan = route(
      inputs([entryFor(independentReasoning("a")), entryFor(independentReasoning("b"))]),
    );
    expect(plan.assignments.every((i) => i.placement === "REUSE_CURRENT")).toBe(true);
    expect(plan.shape).toBe("SERIAL");
    expect(plan.waves).toHaveLength(2);
  });

  it("preserves work as extra waves when parallel capacity is 1", () => {
    const plan = route(
      inputs([entryFor(independentAudit("a")), entryFor(independentAudit("b"))], {
        parallelCapacity: 1,
      }),
    );
    // Preserved and serialised, never dropped.
    expect(plan.assignments.map((i) => i.disposition)).toEqual(["DEGRADE", "DEGRADE"]);
    expect(plan.waves.map((wave) => wave.nodeIds)).toEqual([["a"], ["b"]]);
    expect(plan.shape).toBe("SERIAL");
    expect(plan.shapeReason).toContain("capacity is 1");
  });

  it("withholds concurrency when budget headroom is thin", () => {
    const plan = route(
      inputs([entryFor(independentAudit("a")), entryFor(independentAudit("b"))], {
        effectiveBudgetRemaining: 250,
      }),
    );
    expect(plan.shape).toBe("SERIAL");
    expect(plan.shapeReason).toContain("headroom");
    expect(plan.assignments.every((i) => i.disposition === "DEGRADE")).toBe(true);
    expect(plan.waves).toHaveLength(2);
  });

  it("serialises delegations that are not declared independent", () => {
    const plan = route(inputs([entryFor(auditTask("a")), entryFor(auditTask("b"))]));
    expect(plan.shape).toBe("SERIAL");
    expect(plan.waves.map((wave) => wave.nodeIds)).toEqual([["a"], ["b"]]);
  });

  it("assigns every runnable task to exactly one wave", () => {
    const plan = route(
      inputs(
        [
          entryFor(independentReasoning("a")),
          entryFor(independentAudit("b")),
          entryFor(independentAudit("c")),
        ],
        { childSlotsRemaining: 2, parallelCapacity: 2 },
      ),
    );
    const scheduled = plan.waves.flatMap((wave) => wave.nodeIds);
    const running = plan.assignments
      .filter((i) => i.disposition === "RUN" || i.disposition === "DEGRADE")
      .map((i) => i.nodeId);
    expect([...scheduled].sort()).toEqual([...running].sort());
    expect(new Set(scheduled).size).toBe(scheduled.length);
  });
});
