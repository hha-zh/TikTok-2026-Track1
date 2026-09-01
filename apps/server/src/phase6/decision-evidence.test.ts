/**
 * One candidate snapshot per task per round, and a decision that stays
 * attached to the invocation it produced.
 *
 * The bug this guards against is subtle and would never show up as a failing
 * assertion elsewhere: if candidates are built once for the router and again
 * for the ledger, the recorded evidence describes a set that was never ranked.
 * Two builds over identical state usually agree - and "usually" is exactly the
 * property that makes a governance trail worthless.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const built = vi.hoisted(() => [] as string[]);

// Counts real builds without changing what the engine sees.
vi.mock("../middleware/adaptive/candidates.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../middleware/adaptive/candidates.js")>();
  return {
    ...actual,
    buildCandidates: (
      node: Parameters<typeof actual.buildCandidates>[0],
      context: Parameters<typeof actual.buildCandidates>[1],
    ) => {
      built.push(node.id);
      return actual.buildCandidates(node, context);
    },
  };
});

const { JsonStore } = await import("../store.js");
const { GovernanceLedger } = await import("../middleware/evidence/ledger.js");
const { ExecutionEngine } = await import("../middleware/adaptive/execution-engine.js");
const { seedGovernanceFixtures, startGovernedRun } = await import(
  "../middleware/governance/fixtures.js"
);
const { createTodoDelegationPort, TodoWorkspaceExecutor } = await import(
  "../workload/todo/adapter.js"
);
const { buildTodoGraph } = await import("../workload/todo/graph.js");
const { seedTodoWorkload, TODO_DELEGATABLE_RESOURCES } = await import(
  "../workload/todo/seed.js"
);

const roots: string[] = [];
afterEach(async () => {
  built.length = 0;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

interface DecisionPayload {
  decisionId: string;
  taskId: string;
  disposition: string;
  placement: string | null;
  candidates: { placement: string; routableNow: boolean; hardEligible: boolean }[];
  budget: { runTokensRemaining: number; runPressure: number };
  estimatedTokens: number | null;
}

async function runGraph() {
  const root = await mkdtemp(path.join(tmpdir(), "decision-evidence-"));
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
  const engine = new ExecutionEngine({
    store,
    ledger,
    executor: new TodoWorkspaceExecutor(store, ledger),
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
    .map((event) => event.payload as unknown as DecisionPayload);
  const invocations = events
    .filter((event) => event.kind === "invocation_started")
    .map((event) => event.payload as unknown as {
      decisionId: string | null;
      invocationId: string;
      taskId: string;
    });
  return { result, decisions, invocations, events };
}

describe("one candidate snapshot per decision", () => {
  it("builds candidates exactly as many times as decisions are recorded", async () => {
    const { result, decisions } = await runGraph();
    expect(result.outcome).toBe("COMPLETED");
    expect(decisions.length).toBeGreaterThan(0);
    // The router and the ledger share one build. Two builds would double this.
    expect(built.length).toBe(decisions.length);
  });

  it("records a candidate set for every decision, including settled ones", async () => {
    const { decisions } = await runGraph();
    for (const decision of decisions) {
      expect(decision.candidates.length, decision.taskId).toBeGreaterThan(0);
      // A chosen placement must appear among the candidates that were ranked.
      if (decision.placement !== null) {
        const chosen = decision.candidates.find(
          (item) => item.placement === decision.placement,
        );
        expect(chosen, decision.taskId).toBeDefined();
        expect(chosen?.routableNow, decision.taskId).toBe(true);
      }
    }
  });
});

describe("decisions correlate with the invocations they produced", () => {
  it("gives every invocation the decisionId of a real decision for the same task", async () => {
    const { decisions, invocations } = await runGraph();
    expect(invocations.length).toBeGreaterThan(0);
    const byId = new Map(decisions.map((item) => [item.decisionId, item]));
    for (const invocation of invocations) {
      expect(invocation.decisionId, invocation.taskId).not.toBeNull();
      const decision = byId.get(invocation.decisionId ?? "");
      expect(decision, invocation.decisionId ?? "missing").toBeDefined();
      expect(decision?.taskId).toBe(invocation.taskId);
    }
  });

  it("keeps decision ids unique, so a re-planned task is a new decision", async () => {
    const { decisions } = await runGraph();
    const ids = decisions.map((item) => item.decisionId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("emits no invocation for a task that never reached dispatch", async () => {
    const { decisions, invocations } = await runGraph();
    const invoked = new Set(invocations.map((item) => item.taskId));
    for (const decision of decisions) {
      if (decision.disposition === "SKIP" || decision.disposition === "BLOCKED") {
        expect(invoked.has(decision.taskId), decision.taskId).toBe(false);
      }
    }
  });
});

describe("the decision payload is compact and carries no content", () => {
  it("records run state once per decision rather than once per candidate", async () => {
    const { decisions } = await runGraph();
    const decision = decisions[0];
    expect(decision).toBeDefined();
    if (!decision) return;
    expect(typeof decision.budget.runTokensRemaining).toBe("number");
    expect(typeof decision.budget.runPressure).toBe("number");
    for (const candidate of decision.candidates) {
      // Run-wide numbers do not belong on a per-placement view.
      expect(candidate).not.toHaveProperty("runTokensRemaining");
      expect(candidate).not.toHaveProperty("effectiveTokensRemaining");
      expect(candidate).not.toHaveProperty("estimatedTokens");
    }
  });

  it("names resources and actions without ever carrying their contents", async () => {
    const { events } = await runGraph();
    const serialised = JSON.stringify(
      events.filter((event) => event.kind === "routing_decision"),
    );
    // Seeded protected content, which lives only behind /api/resources/:id.
    expect(serialised).not.toMatch(/rmenon/i);
    expect(serialised).not.toMatch(/payment record/i);
    // No prompts, no model output.
    expect(serialised).not.toMatch(/"prompt"/);
    expect(serialised).not.toMatch(/"content"/);
  });
});
