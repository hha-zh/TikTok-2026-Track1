/**
 * The runtime feedback loop, end to end and un-faked.
 *
 *   routing decision -> execution -> tokens_consumed -> projection -> next decision
 *
 * Nothing here writes `runState.tokensUsed` or `grantState.tokensUsed`. If a
 * test has to hand-place the number the runtime is supposed to derive, it
 * proves the assertion and not the loop. The only lever these tests pull is
 * what the executor actually costs; every downstream number is read back from
 * the ledger's projections.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import { GovernanceLedger } from "../middleware/evidence/ledger.js";
import { ExecutionEngine } from "../middleware/adaptive/execution-engine.js";
import {
  PARENT_MAX_TOKENS,
  RUN_CAP_TOKENS,
  seedGovernanceFixtures,
  startGovernedRun,
} from "../middleware/governance/fixtures.js";
import {
  createTodoDelegationPort,
  TodoWorkspaceExecutor,
} from "../workload/todo/adapter.js";
import {
  buildTodoGraph,
  TASK_TEST_PLAN,
  TASK_UI_PLAN,
  TASK_WORKSPACE_SCAN,
} from "../workload/todo/graph.js";
import { seedTodoWorkload, TODO_DELEGATABLE_RESOURCES } from "../workload/todo/seed.js";
import type { GovernanceEvent } from "../middleware/evidence/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface DecisionPayload {
  decisionId: string;
  taskId: string;
  placement: string | null;
  estimatedTokens: number | null;
  budget: { runTokensRemaining: number; runPressure: number };
}

/**
 * `actualTokens` is the ONLY lever. It changes what work costs, exactly as a
 * real executor would; it does not touch accounting.
 */
async function runLoop(actualTokens?: (taskId: string) => number) {
  const root = await mkdtemp(path.join(tmpdir(), "feedback-loop-"));
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

  // The run starts with nothing spent. Every later number is earned.
  expect(
    store.snapshot().runStates.find((item) => item.runId === "run-1")?.tokensUsed,
  ).toBe(0);

  const engine = new ExecutionEngine({
    store,
    ledger,
    executor: new TodoWorkspaceExecutor(store, ledger, {
      ...(actualTokens ? { actualTokens } : {}),
    }),
    delegation: createTodoDelegationPort(store, ledger),
    policy: { parallelCapacity: 2 },
  });
  const result = await engine.run(buildTodoGraph(), {
    principal: governed.principal,
    grantId: governed.envelope.id,
    runId: "run-1",
  });

  const events = store.snapshot().governanceEvents;
  const decisions = events
    .filter((event) => event.kind === "routing_decision")
    .map((event) => ({
      seq: event.seq,
      payload: event.payload as unknown as DecisionPayload,
    }));
  const consumption = events
    .filter((event) => event.kind === "tokens_consumed")
    .map((event) => ({
      seq: event.seq,
      total: (event.payload as unknown as { totalTokens: number }).totalTokens,
    }));
  const decisionFor = (taskId: string) =>
    decisions.find((item) => item.payload.taskId === taskId)?.payload;

  return { result, store, events, decisions, consumption, decisionFor };
}

/** Cumulative recorded consumption strictly before a given ledger position. */
const spentBefore = (
  consumption: { seq: number; total: number }[],
  seq: number,
): number =>
  consumption
    .filter((item) => item.seq < seq)
    .reduce((sum, item) => sum + item.total, 0);

// ---------------------------------------------------------------------------
// Part A — one ledger, one truth trail
// ---------------------------------------------------------------------------

describe("the ledger is the only persistent runtime truth trail", () => {
  it("assigns a dense, strictly increasing sequence across every writer", async () => {
    const { events } = await runLoop();
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((event) => event.seq)).toEqual(
      events.map((_, index) => index + 1),
    );
  });

  it("stamps every event with the run, grant and principal it happened under", async () => {
    const { events } = await runLoop();
    for (const event of events as GovernanceEvent[]) {
      expect(event.runId, event.kind).toBeTruthy();
      expect(event.grantId, event.kind).toBeTruthy();
      expect(event.principalId, event.kind).toBeTruthy();
      expect(event.ts, event.kind).toBeTruthy();
    }
  });

  it("derives run usage from recorded events and nothing else", async () => {
    const { store, consumption } = await runLoop();
    const recorded = consumption.reduce((sum, item) => sum + item.total, 0);
    const projected = store
      .snapshot()
      .runStates.find((item) => item.runId === "run-1")?.tokensUsed;
    expect(recorded).toBeGreaterThan(0);
    // Not "close to". The projection IS the fold of the events.
    expect(projected).toBe(recorded);
  });
});

// ---------------------------------------------------------------------------
// Part B — the loop actually closes
// ---------------------------------------------------------------------------

describe("execution feeds the next routing decision", () => {
  it("shows each decision the budget the ledger had recorded at that moment", async () => {
    const { decisions, consumption } = await runLoop();
    expect(decisions.length).toBeGreaterThan(1);
    for (const decision of decisions) {
      const expected = RUN_CAP_TOKENS - spentBefore(consumption, decision.seq);
      expect(decision.payload.budget.runTokensRemaining, decision.payload.decisionId).toBe(
        expected,
      );
    }
  });

  it("spends the budget monotonically as the run proceeds", async () => {
    const { decisions } = await runLoop();
    const remaining = decisions.map((item) => item.payload.budget.runTokensRemaining);
    const pressure = decisions.map((item) => item.payload.budget.runPressure);
    for (let index = 1; index < remaining.length; index += 1) {
      expect(remaining[index]!).toBeLessThanOrEqual(remaining[index - 1]!);
      expect(pressure[index]!).toBeGreaterThanOrEqual(pressure[index - 1]!);
    }
    // The first round genuinely saw a full budget, and the run genuinely spent.
    expect(remaining[0]).toBe(RUN_CAP_TOKENS);
    expect(remaining[remaining.length - 1]).toBeLessThan(RUN_CAP_TOKENS);
  });

  it("changes a later decision because earlier work was expensive, not because a test said so", async () => {
    // The planners are identical in both runs and are decided in the same
    // round. The only difference is what the round before them actually cost.
    const expensive = await runLoop((taskId) =>
      taskId === TASK_WORKSPACE_SCAN ? 10_200 : 200,
    );
    const cheap = await runLoop((taskId) => (taskId === TASK_WORKSPACE_SCAN ? 300 : 200));

    expect(cheap.result.outcome).toBe("COMPLETED");
    expect(expensive.result.outcome).toBe("COMPLETED");

    expect(cheap.decisionFor(TASK_UI_PLAN)?.placement).toBe("DELEGATE_SPECIALIST");
    expect(cheap.decisionFor(TASK_TEST_PLAN)?.placement).toBe("DELEGATE_SPECIALIST");
    expect(expensive.decisionFor(TASK_UI_PLAN)?.placement).toBe("REUSE_CURRENT");
    expect(expensive.decisionFor(TASK_TEST_PLAN)?.placement).toBe("REUSE_CURRENT");

    // The cause is in the trail, not in the assertion: one prior execution,
    // recorded through the ledger, is the whole difference.
    expect(RUN_CAP_TOKENS - (expensive.decisionFor(TASK_UI_PLAN)?.budget.runTokensRemaining ?? 0))
      .toBe(10_200);
    expect(RUN_CAP_TOKENS - (cheap.decisionFor(TASK_UI_PLAN)?.budget.runTokensRemaining ?? 0))
      .toBe(300);
  });

  it("moves the threshold, not the intrinsic value of delegating", async () => {
    // Part G at integration scale: pressure raises the bar, it does not make
    // the same delegation intrinsically worth less.
    const expensive = await runLoop((taskId) =>
      taskId === TASK_WORKSPACE_SCAN ? 10_200 : 200,
    );
    const cheap = await runLoop((taskId) => (taskId === TASK_WORKSPACE_SCAN ? 300 : 200));
    const under = expensive.decisionFor(TASK_UI_PLAN);
    const relaxed = cheap.decisionFor(TASK_UI_PLAN);

    expect(under?.delegationValue).toBe(relaxed?.delegationValue);
    expect(under?.delegationThreshold ?? 0).toBeGreaterThan(
      relaxed?.delegationThreshold ?? 0,
    );
    expect(under?.delegationValue ?? 0).toBeLessThan(under?.delegationThreshold ?? 0);
    expect(relaxed?.delegationValue ?? 0).toBeGreaterThan(
      relaxed?.delegationThreshold ?? 0,
    );
  });
});

// ---------------------------------------------------------------------------
// Part H — provenance stays separated
// ---------------------------------------------------------------------------

describe("a declared estimate never becomes observed usage", () => {
  it("accounts what execution reported, not what the graph predicted", async () => {
    const graph = buildTodoGraph();
    const declared = new Map(
      graph.nodes.map((node) => [node.id, node.estimatedTokens] as const),
    );
    // Deliberately nothing like the estimate, in both directions.
    const { store, consumption, decisionFor } = await runLoop((taskId) =>
      taskId === TASK_WORKSPACE_SCAN ? 1_900 : 120,
    );

    const projected = store
      .snapshot()
      .runStates.find((item) => item.runId === "run-1")?.tokensUsed;
    const declaredTotal = [...declared.values()].reduce((sum, item) => sum + item, 0);
    expect(projected).toBe(consumption.reduce((sum, item) => sum + item.total, 0));
    expect(projected).not.toBe(declaredTotal);

    // The estimate is still recorded - as a DECLARED planning input, beside
    // the OBSERVED budget rather than inside it.
    const decision = decisionFor(TASK_WORKSPACE_SCAN);
    expect(decision?.estimatedTokens).toBe(declared.get(TASK_WORKSPACE_SCAN));
    expect(decision?.estimatedTokens).not.toBe(1_900);
  });

  it("never reserves an estimate against the cap", async () => {
    // ui_plan and test_plan are decided in the same round. If estimates were
    // reserved at planning time, the second would already see less budget.
    const { decisions } = await runLoop();
    const sameRound = decisions.filter(
      (item) =>
        item.payload.taskId === TASK_UI_PLAN || item.payload.taskId === TASK_TEST_PLAN,
    );
    expect(sameRound.length).toBe(2);
    expect(sameRound[0]!.payload.budget.runTokensRemaining).toBe(
      sameRound[1]!.payload.budget.runTokensRemaining,
    );
    // Both declared a non-zero estimate, so there was something to reserve.
    expect(sameRound[0]!.payload.estimatedTokens ?? 0).toBeGreaterThan(0);
    expect(PARENT_MAX_TOKENS).toBeGreaterThan(0);
  });
});
