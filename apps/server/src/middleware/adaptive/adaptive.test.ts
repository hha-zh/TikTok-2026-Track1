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
import { route } from "./router.js";
import {
  isComplete,
  readyNodes,
  validateGraph,
  type TaskGraph,
  type TaskNode,
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

function node(overrides: Partial<TaskNode> & { id: string }): TaskNode {
  return {
    description: "step " + overrides.id,
    resources: [],
    actions: ["read"],
    dependsOn: [],
    estimatedTokens: 100,
    ...overrides,
  };
}

const context = (governanceState = state()) => ({
  principal: PRINCIPAL,
  state: governanceState,
  now: NOW,
});

describe("TaskGraph", () => {
  it("accepts a well-formed graph and orders readiness by dependency", () => {
    const graph: TaskGraph = {
      id: "g",
      nodes: [node({ id: "a" }), node({ id: "b", dependsOn: ["a"] })],
    };
    expect(validateGraph(graph)).toEqual({ ok: true });
    expect(readyNodes(graph).map((item) => item.id)).toEqual(["a"]);
    expect(
      readyNodes(graph, { completed: new Set(["a"]), skipped: new Set() }).map(
        (item) => item.id,
      ),
    ).toEqual(["b"]);
  });

  it("treats a dependency satisfied by a skipped node as satisfied", () => {
    // Otherwise one dropped optional node stalls everything beneath it.
    const graph: TaskGraph = {
      id: "g",
      nodes: [node({ id: "a", optional: true }), node({ id: "b", dependsOn: ["a"] })],
    };
    const ready = readyNodes(graph, {
      completed: new Set(),
      skipped: new Set(["a"]),
    });
    expect(ready.map((item) => item.id)).toEqual(["b"]);
  });

  it("reports duplicates, unknown dependencies and cycles", () => {
    const duplicate = validateGraph({ id: "g", nodes: [node({ id: "a" }), node({ id: "a" })] });
    expect(duplicate.ok).toBe(false);

    const unknown = validateGraph({
      id: "g",
      nodes: [node({ id: "a", dependsOn: ["ghost"] })],
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.problems[0]).toEqual({
        kind: "unknown_dependency",
        nodeId: "a",
        dependsOn: "ghost",
      });
    }

    const cyclic = validateGraph({
      id: "g",
      nodes: [
        node({ id: "a", dependsOn: ["b"] }),
        node({ id: "b", dependsOn: ["a"] }),
      ],
    });
    expect(cyclic.ok).toBe(false);
    if (!cyclic.ok) {
      expect(cyclic.problems).toContainEqual({ kind: "cycle", nodeIds: ["a", "b"] });
    }
  });

  it("is complete once every node is settled either way", () => {
    const graph: TaskGraph = { id: "g", nodes: [node({ id: "a" }), node({ id: "b" })] };
    expect(
      isComplete(graph, { completed: new Set(["a"]), skipped: new Set(["b"]) }),
    ).toBe(true);
    expect(isComplete(graph, { completed: new Set(["a"]), skipped: new Set() })).toBe(
      false,
    );
  });
});

describe("CandidateBuilder", () => {
  it("marks reuse legal for a resource the principal may read itself", () => {
    const candidates = buildCandidates(
      node({ id: "a", resources: [RESOURCE_METRICS], actions: ["read"] }),
      context(),
    );
    const reuse = candidates.find((item) => item.placement === "REUSE_CURRENT");
    expect(reuse?.legal).toBe(true);
    expect(reuse?.reason).toBe("AUTHORIZED");
  });

  it("routes a delegate-only resource to delegation, not to reuse", () => {
    // This is the exercisable/delegatable split doing its job: the parent may
    // cause the audit read without being able to perform it.
    const candidates = buildCandidates(
      node({ id: "a", resources: [RESOURCE_AUDIT], actions: ["read"] }),
      context(),
    );
    const reuse = candidates.find((item) => item.placement === "REUSE_CURRENT");
    const delegate = candidates.find((item) => item.placement === "DELEGATE_SPECIALIST");
    expect(reuse?.legal).toBe(false);
    expect(reuse?.reason).toBe("NOT_EXERCISABLE_DELEGATE_ONLY");
    expect(delegate?.legal).toBe(true);
  });

  it("finds no legal placement for a resource in neither authority set", () => {
    const candidates = buildCandidates(
      node({ id: "a", resources: [RESOURCE_PAYMENTS], actions: ["read"] }),
      context(),
    );
    expect(legalCandidates(candidates)).toHaveLength(0);
    expect(
      candidates.find((item) => item.placement === "REUSE_CURRENT")?.reason,
    ).toBe("RESOURCE_NOT_GRANTED");
    expect(
      candidates.find((item) => item.placement === "DELEGATE_SPECIALIST")?.reason,
    ).toBe("CHILD_EXCEEDS_PARENT");
  });

  it("reports the capacity denial, not a scope denial, when depth is exhausted", () => {
    // Asking scope first would blame CHILD_EXCEEDS_PARENT for what is really a
    // spent delegation ceiling, which reads as the wrong bug.
    const exhausted = state({ envelope: envelope({ depth: 0 }) });
    const candidates = buildCandidates(
      node({ id: "a", resources: [RESOURCE_AUDIT], actions: ["read"] }),
      context(exhausted),
    );
    expect(
      candidates.find((item) => item.placement === "DELEGATE_SPECIALIST")?.reason,
    ).toBe("DELEGATION_CEILING_REACHED");
  });

  it("passes a governance denial through untouched", () => {
    const revoked = state({
      grantState: {
        grantId: "grant-parent",
        revoked: true,
        tokensUsed: 0,
        childCount: 0,
      },
    });
    const candidates = buildCandidates(
      node({ id: "a", resources: [RESOURCE_METRICS], actions: ["read"] }),
      context(revoked),
    );
    // The adaptive layer must not soften or reinterpret this.
    expect(candidates.every((item) => item.reason === "PARENT_GRANT_REVOKED")).toBe(
      true,
    );
    expect(legalCandidates(candidates)).toHaveLength(0);
  });
});

describe("Router", () => {
  const entry = (item: TaskNode, governanceState = state()) => ({
    node: item,
    candidates: buildCandidates(item, context(governanceState)),
  });

  it("prefers reuse over delegation when both are legal", () => {
    const plan = route({
      entries: [entry(node({ id: "a", resources: [RESOURCE_METRICS] }))],
      budgetRemaining: 5000,
      childSlotsRemaining: 2,
    });
    expect(plan.shape).toBe("DIRECT");
    expect(plan.assignments[0]?.placement).toBe("REUSE_CURRENT");
    // Reuse costs no principal and no grant, so slots are untouched.
    expect(plan.childSlotsRemaining).toBe(2);
  });

  it("delegates when the principal may cause but not perform the work", () => {
    const plan = route({
      entries: [entry(node({ id: "a", resources: [RESOURCE_AUDIT] }))],
      budgetRemaining: 5000,
      childSlotsRemaining: 2,
    });
    expect(plan.assignments[0]?.disposition).toBe("RUN");
    expect(plan.assignments[0]?.placement).toBe("DELEGATE_SPECIALIST");
    expect(plan.childSlotsRemaining).toBe(1);
  });

  it("skips an optional node with no permitted placement but blocks a required one", () => {
    const optional = route({
      entries: [entry(node({ id: "a", resources: [RESOURCE_PAYMENTS], optional: true }))],
      budgetRemaining: 5000,
      childSlotsRemaining: 2,
    });
    expect(optional.assignments[0]?.disposition).toBe("SKIP");
    expect(optional.assignments[0]?.governanceReason).toBe("RESOURCE_NOT_GRANTED");
    expect(optional.blocked).toBe(false);

    const required = route({
      entries: [entry(node({ id: "a", resources: [RESOURCE_PAYMENTS] }))],
      budgetRemaining: 5000,
      childSlotsRemaining: 2,
    });
    // Proceeding without a required node would produce a confident partial answer.
    expect(required.assignments[0]?.disposition).toBe("BLOCKED");
    expect(required.blocked).toBe(true);
  });

  it("defers a required node it cannot afford and skips an optional one", () => {
    const plan = route({
      entries: [
        entry(node({ id: "a", resources: [RESOURCE_METRICS], estimatedTokens: 900 })),
        entry(
          node({
            id: "b",
            resources: [RESOURCE_METRICS],
            estimatedTokens: 900,
            optional: true,
          }),
        ),
        entry(node({ id: "c", resources: [RESOURCE_METRICS], estimatedTokens: 900 })),
      ],
      budgetRemaining: 1000,
      childSlotsRemaining: 2,
    });
    expect(plan.assignments.map((item) => item.disposition)).toEqual([
      "RUN",
      "SKIP",
      "DEFER",
    ]);
    expect(plan.plannedTokens).toBe(900);
  });

  it("falls back to reuse when delegation is legal but no child slots remain", () => {
    const plan = route({
      entries: [entry(node({ id: "a", resources: [RESOURCE_METRICS] }))],
      budgetRemaining: 5000,
      childSlotsRemaining: 0,
    });
    expect(plan.assignments[0]?.placement).toBe("REUSE_CURRENT");
  });

  it("defers rather than dropping when only delegation is legal and slots are gone", () => {
    const plan = route({
      entries: [entry(node({ id: "a", resources: [RESOURCE_AUDIT] }))],
      budgetRemaining: 5000,
      childSlotsRemaining: 0,
    });
    expect(plan.assignments[0]?.disposition).toBe("DEFER");
    expect(plan.assignments[0]?.note).toContain("no child slots");
  });

  it("goes parallel for two delegations and serial for two reuses", () => {
    const parallel = route({
      entries: [
        entry(node({ id: "a", resources: [RESOURCE_AUDIT] })),
        entry(node({ id: "b", resources: [RESOURCE_AUDIT] })),
      ],
      budgetRemaining: 5000,
      childSlotsRemaining: 2,
    });
    expect(parallel.shape).toBe("PARALLEL");

    const serial = route({
      entries: [
        entry(node({ id: "a", resources: [RESOURCE_METRICS] })),
        entry(node({ id: "b", resources: [RESOURCE_METRICS] })),
      ],
      budgetRemaining: 5000,
      childSlotsRemaining: 2,
    });
    // One principal cannot run two things at once.
    expect(serial.shape).toBe("SERIAL");
  });

  it("degrades to serial when only one child slot is left", () => {
    const plan = route({
      entries: [
        entry(node({ id: "a", resources: [RESOURCE_AUDIT] })),
        entry(node({ id: "b", resources: [RESOURCE_AUDIT] })),
      ],
      budgetRemaining: 5000,
      childSlotsRemaining: 1,
    });
    // Second node falls back to reuse - which is not permitted here - so it waits.
    expect(plan.shape).not.toBe("PARALLEL");
    expect(plan.assignments[1]?.disposition).toBe("DEFER");
  });

  it("never invents an allow for a node governance denied", () => {
    const revoked = state({
      grantState: {
        grantId: "grant-parent",
        revoked: true,
        tokensUsed: 0,
        childCount: 0,
      },
    });
    const plan = route({
      entries: [entry(node({ id: "a", resources: [RESOURCE_METRICS] }), revoked)],
      budgetRemaining: 999_999,
      childSlotsRemaining: 9,
    });
    // Generous budget and slots must not rescue a revoked grant.
    expect(plan.assignments[0]?.disposition).toBe("BLOCKED");
    expect(plan.assignments[0]?.governanceReason).toBe("PARENT_GRANT_REVOKED");
  });
});
