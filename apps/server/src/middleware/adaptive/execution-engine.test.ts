import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../store.js";
import { GovernanceLedger } from "../evidence/ledger.js";
import {
  RESOURCE_AUDIT,
  RESOURCE_METRICS,
  RESOURCE_PAYMENTS,
  seedGovernanceFixtures,
  startGovernedRun,
} from "../governance/fixtures.js";
import type { Envelope } from "../governance/types.js";
import {
  ExecutionEngine,
  type DelegationPort,
  type EngineIdentity,
  type TaskExecutionRequest,
  type TaskExecutionResult,
  type TaskExecutor,
} from "./execution-engine.js";
import { task, type TaskGraph, type TaskSpec } from "./task-graph.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const usage = (total: number) => ({
  inputTokens: total,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: total,
});

/** Produces whatever the task promised, and reports a controllable cost. */
class ScriptedExecutor implements TaskExecutor {
  readonly calls: TaskExecutionRequest[] = [];

  constructor(
    private readonly options: {
      actualTokens?: ((taskId: string) => number) | undefined;
      produce?: ((taskId: string) => { id: string; value: unknown }[]) | undefined;
      fail?: ((taskId: string) => boolean) | undefined;
      onExecute?: ((request: TaskExecutionRequest) => Promise<void>) | undefined;
    } = {},
  ) {}

  async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
    this.calls.push(request);
    await this.options.onExecute?.(request);
    const total = this.options.actualTokens?.(request.task.id) ?? request.task.estimatedTokens;
    if (this.options.fail?.(request.task.id)) {
      return { ok: false, producedArtifacts: [], usage: usage(total), error: "scripted" };
    }
    const produced =
      this.options.produce?.(request.task.id) ??
      request.task.producedArtifacts.map((id) => ({ id, value: { from: request.task.id } }));
    return { ok: true, producedArtifacts: produced, usage: usage(total) };
  }
}

/** Creates a real child principal, envelope and grant_created event. */
function realDelegation(store: JsonStore, ledger: GovernanceLedger): DelegationPort {
  return {
    async delegate({ parentPrincipal, parentGrantId, runId, task: node }) {
      const parent = store.snapshot().envelopes.find((item) => item.id === parentGrantId);
      if (!parent) return { ok: false, reason: "GRANT_NOT_FOUND" };
      const childPrincipalId = randomUUID();
      const grantId = randomUUID();
      const child: Envelope = {
        id: grantId,
        principalId: childPrincipalId,
        exercisable: {
          resources: [...node.resources],
          actions: [...node.actions],
        },
        delegatable: { resources: [], actions: [] },
        depth: parent.depth - 1,
        maxTokens: Math.min(node.estimatedTokens * 4, parent.maxTokens),
        maxToolCalls: parent.maxToolCalls,
        maxChildren: 0,
        runId,
        parentGrantId,
        createdAt: new Date().toISOString(),
      };
      await store.mutate((database) => {
        database.principals.push({
          id: childPrincipalId,
          kind: "agent",
          ownerId: parentPrincipal.ownerId ?? "wtan",
          parentPrincipalId: parentPrincipal.id,
        });
        database.envelopes.push(child);
      });
      await ledger.appendEvent(
        "grant_created",
        { parentGrantId, depth: child.depth },
        { runId, grantId, principalId: childPrincipalId },
      );
      return { ok: true, childPrincipalId, grantId };
    },
  };
}

async function harness(options: { runTokensUsed?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "adaptive-engine-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await seedGovernanceFixtures(store);
  const ledger = new GovernanceLedger(store);
  const governed = await startGovernedRun(store, ledger, { runId: "run-1" });

  if (options.runTokensUsed) {
    await ledger.appendEvent("tokens_consumed", usage(options.runTokensUsed), {
      runId: "run-1",
      grantId: governed.envelope.id,
      principalId: governed.principal.id,
    });
  }

  const identity: EngineIdentity = {
    principal: governed.principal,
    grantId: governed.envelope.id,
    runId: "run-1",
  };
  return { store, ledger, identity, governed };
}

const engineWith = (
  store: JsonStore,
  ledger: GovernanceLedger,
  executor: TaskExecutor,
  overrides: Partial<ConstructorParameters<typeof ExecutionEngine>[0]> = {},
) =>
  new ExecutionEngine({
    store,
    ledger,
    executor,
    delegation: realDelegation(store, ledger),
    ...overrides,
  });

/** Legal both ways, so the adaptive choice is the only thing deciding. */
const reasoning = (id: string, overrides: Partial<TaskSpec> = {}) =>
  task({ id, resources: [], actions: ["model:invoke"], ...overrides });

const graphOf = (...nodes: TaskSpec[]): TaskGraph => ({ id: "g", nodes });

describe("ExecutionEngine — the adaptive claim", () => {
  const hints = { expectedUtilityGain: 0.2, expectedIncrementalCost: 400 };

  it("delegates the same workload on a relaxed run budget", async () => {
    const { store, ledger, identity } = await harness();
    const executor = new ScriptedExecutor();
    const result = await engineWith(store, ledger, executor).run(
      graphOf(reasoning("plan", { estimatedTokens: 100, hints })),
      identity,
    );
    expect(result.outcome).toBe("COMPLETED");
    expect(executor.calls[0]?.placement).toBe("DELEGATE_SPECIALIST");
  });

  it("reuses the same workload on a pressured run budget", async () => {
    // Same graph, same hints, different runtime state - different topology.
    const { store, ledger, identity } = await harness({ runTokensUsed: 11_100 });
    const executor = new ScriptedExecutor();
    const result = await engineWith(store, ledger, executor).run(
      graphOf(reasoning("plan", { estimatedTokens: 100, hints })),
      identity,
    );
    expect(result.outcome).toBe("COMPLETED");
    expect(executor.calls[0]?.placement).toBe("REUSE_CURRENT");
  });
});

describe("ExecutionEngine — shape", () => {
  it("runs an independent REUSE beside an independent DELEGATE in one wave", async () => {
    const { store, ledger, identity } = await harness();
    const executor = new ScriptedExecutor();
    const result = await engineWith(store, ledger, executor).run(
      graphOf(
        reasoning("summarise", { hints: { independent: true } }),
        task({
          id: "audit",
          resources: [RESOURCE_AUDIT],
          hints: { independent: true },
        }),
      ),
      identity,
    );
    expect(result.outcome).toBe("COMPLETED");
    expect(result.rounds[0]?.plan.shape).toBe("PARALLEL");
    expect(result.rounds[0]?.plan.waves[0]?.nodeIds.sort()).toEqual([
      "audit",
      "summarise",
    ]);
  });

  it("serialises the same assignments when parallel capacity is 1", async () => {
    const { store, ledger, identity } = await harness();
    const executor = new ScriptedExecutor();
    const result = await engineWith(store, ledger, executor, {
      policy: { parallelCapacity: 1 },
    }).run(
      graphOf(
        reasoning("summarise", { hints: { independent: true } }),
        task({ id: "audit", resources: [RESOURCE_AUDIT], hints: { independent: true } }),
      ),
      identity,
    );
    expect(result.outcome).toBe("COMPLETED");
    expect(result.rounds[0]?.plan.shape).toBe("SERIAL");
    expect(result.rounds[0]?.plan.waves).toHaveLength(2);
    // Preserved, not dropped.
    expect(
      result.rounds[0]?.plan.assignments.every((item) => item.disposition === "DEGRADE"),
    ).toBe(true);
  });

  it("serialises two REUSE tasks", async () => {
    const { store, ledger, identity } = await harness();
    const executor = new ScriptedExecutor();
    const result = await engineWith(store, ledger, executor).run(
      graphOf(
        reasoning("a", { hints: { independent: true } }),
        reasoning("b", { hints: { independent: true } }),
      ),
      identity,
    );
    expect(result.rounds[0]?.plan.shape).toBe("SERIAL");
    expect(
      result.rounds[0]?.plan.assignments.every(
        (item) => item.placement === "REUSE_CURRENT",
      ),
    ).toBe(true);
  });
});

describe("ExecutionEngine — artifacts", () => {
  it("blocks the run when a skipped producer owed a required artifact", async () => {
    const { store, ledger, identity } = await harness();
    const executor = new ScriptedExecutor();
    const result = await engineWith(store, ledger, executor).run(
      graphOf(
        // No legal placement, and optional, so it is skipped.
        task({
          id: "scan",
          resources: [RESOURCE_PAYMENTS],
          optional: true,
          producedArtifacts: ["workspace_summary"],
        }),
        task({ id: "plan", requiredArtifacts: ["workspace_summary"] }),
      ),
      identity,
    );
    expect(result.outcome).toBe("UNREACHABLE");
    expect(result.failures[0]?.taskId).toBe("plan");
    expect(result.progress.completed.has("plan")).toBe(false);
  });

  it("does not mark a task completed when it did not produce what it promised", async () => {
    const { store, ledger, identity } = await harness();
    const executor = new ScriptedExecutor({ produce: () => [] });
    const result = await engineWith(store, ledger, executor).run(
      graphOf(task({ id: "scan", producedArtifacts: ["workspace_summary"] })),
      identity,
    );
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.progress.completed.has("scan")).toBe(false);
    expect(result.progress.artifacts.has("workspace_summary")).toBe(false);
    expect(result.failures[0]?.reason).toContain("promised artifacts not produced");
  });

  it("passes a committed artifact into the dependent task's context", async () => {
    const { store, ledger, identity } = await harness();
    const executor = new ScriptedExecutor();
    const result = await engineWith(store, ledger, executor).run(
      graphOf(
        reasoning("scan", { producedArtifacts: ["workspace_summary"] }),
        reasoning("plan", { requiredArtifacts: ["workspace_summary"] }),
      ),
      identity,
    );
    expect(result.outcome).toBe("COMPLETED");
    const planCall = executor.calls.find((call) => call.task.id === "plan");
    expect(planCall?.context.included.map((item) => item.id)).toEqual([
      "workspace_summary",
    ]);
  });

  it("keeps a delegated child's raw output away from the parent's next task", async () => {
    // The Return Gate boundary, observed end to end: the child's own output
    // carries the child's principal, so the parent cannot see it.
    const { store, ledger, identity } = await harness();
    const executor = new ScriptedExecutor();
    const result = await engineWith(store, ledger, executor).run(
      graphOf(
        task({
          id: "audit",
          resources: [RESOURCE_AUDIT],
          producedArtifacts: ["audit_notes"],
        }),
        reasoning("review", { requiredArtifacts: ["audit_notes"] }),
      ),
      identity,
    );
    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.failures[0]?.taskId).toBe("review");
    expect(result.failures[0]?.reason).toContain("required context unavailable");
  });
});

describe("ExecutionEngine — budget and termination", () => {
  it("routes the next round from actual usage, not the estimate", async () => {
    const { store, ledger, identity } = await harness();
    // Declares 100, actually burns almost the whole run.
    const executor = new ScriptedExecutor({
      actualTokens: (taskId) => (taskId === "first" ? 11_500 : 100),
    });
    const result = await engineWith(store, ledger, executor).run(
      graphOf(
        reasoning("first", { estimatedTokens: 100, producedArtifacts: ["done"] }),
        reasoning("second", { estimatedTokens: 100, requiredArtifacts: ["done"] }),
      ),
      identity,
    );
    const firstRound = result.rounds[0]?.plan.effectiveBudgetRemaining ?? 0;
    const secondRound = result.rounds[1]?.plan.effectiveBudgetRemaining ?? 0;
    // The second round sees the real spend, not the declared estimate.
    expect(firstRound).toBeGreaterThan(10_000);
    expect(secondRound).toBeLessThan(1_000);
    expect(store.snapshot().runStates[0]?.tokensUsed).toBe(11_600);
  });

  it("terminates on the defer ceiling instead of livelocking", async () => {
    const { store, ledger, identity } = await harness({ runTokensUsed: 11_990 });
    const executor = new ScriptedExecutor();
    const result = await engineWith(store, ledger, executor, {
      policy: { maxDeferPerTask: 2 },
    }).run(
      // Required, and permanently unaffordable: nothing will change.
      graphOf(reasoning("expensive", { estimatedTokens: 5_000 })),
      identity,
    );
    expect(result.outcome).toBe("DEFER_CEILING");
    expect(result.rounds.length).toBeLessThanOrEqual(4);
    expect(result.failures[0]?.reason).toContain("deferred");
  });

  it("records real usage on the ledger per executing principal", async () => {
    const { store, ledger, identity } = await harness();
    const executor = new ScriptedExecutor({ actualTokens: () => 250 });
    await engineWith(store, ledger, executor).run(
      graphOf(task({ id: "audit", resources: [RESOURCE_AUDIT] })),
      identity,
    );
    const consumed = store
      .snapshot()
      .governanceEvents.filter((event) => event.kind === "tokens_consumed");
    expect(consumed).toHaveLength(1);
    // Charged to the child that actually ran it, and rolled up to the run.
    expect(consumed[0]?.principalId).not.toBe(identity.principal.id);
    expect(store.snapshot().runStates[0]?.tokensUsed).toBe(250);
  });
});

describe("ExecutionEngine — governance is never rescued", () => {
  it("blocks a task governance denied, however much budget is spare", async () => {
    const { store, ledger, identity } = await harness();
    const executor = new ScriptedExecutor();
    const result = await engineWith(store, ledger, executor).run(
      graphOf(task({ id: "peek", resources: [RESOURCE_PAYMENTS] })),
      identity,
    );
    expect(result.outcome).toBe("BLOCKED");
    expect(result.failures[0]?.governanceReason).toBe("RESOURCE_NOT_GRANTED");
    expect(executor.calls).toHaveLength(0);
  });

  it("stops mediated work when the grant is revoked between planning and dispatch", async () => {
    const { store, ledger, identity, governed } = await harness();
    // Revoked while the first task is executing, i.e. after the plan was made.
    const executor = new ScriptedExecutor({
      onExecute: async (request) => {
        if (request.task.id !== "first") return;
        await ledger.appendEvent(
          "grant_revoked",
          { reason: "PARENT_GRANT_REVOKED" },
          {
            runId: "run-1",
            grantId: governed.envelope.id,
            principalId: governed.principal.id,
          },
        );
      },
    });
    const result = await engineWith(store, ledger, executor).run(
      graphOf(
        reasoning("first", { producedArtifacts: ["done"] }),
        reasoning("second", { requiredArtifacts: ["done"] }),
      ),
      identity,
    );
    // The stale plan cannot carry the second task past the revocation.
    expect(result.outcome).not.toBe("COMPLETED");
    expect(result.progress.completed.has("second")).toBe(false);
    expect(executor.calls.some((call) => call.task.id === "second")).toBe(false);
  });

  it("refuses a graph that fails structural validation before any execution", async () => {
    const { store, ledger, identity } = await harness();
    const executor = new ScriptedExecutor();
    const result = await engineWith(store, ledger, executor).run(
      graphOf(
        task({ id: "a", producedArtifacts: ["dup"] }),
        task({ id: "b", producedArtifacts: ["dup"] }),
      ),
      identity,
    );
    expect(result.outcome).toBe("BLOCKED");
    expect(result.failures[0]?.reason).toContain("duplicate_artifact_producer");
    expect(executor.calls).toHaveLength(0);
  });

  it("reads only what the invocation envelope narrowed to", async () => {
    const { store, ledger, identity } = await harness();
    const executor = new ScriptedExecutor();
    await engineWith(store, ledger, executor).run(
      graphOf(task({ id: "metrics", resources: [RESOURCE_METRICS], actions: ["read"] })),
      identity,
    );
    const call = executor.calls[0];
    expect(call?.envelope.effective.resources).toEqual([RESOURCE_METRICS]);
    expect(call?.envelope.sourceGrantId).toBe(identity.grantId);
    expect(call?.envelope.taskId).toBe("metrics");
  });
});
