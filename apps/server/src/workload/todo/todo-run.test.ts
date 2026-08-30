import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../store.js";
import { GovernanceLedger } from "../../middleware/evidence/ledger.js";
import { ExecutionEngine } from "../../middleware/adaptive/execution-engine.js";
import { projectContext } from "../../middleware/adaptive/context-broker.js";
import { deriveExecutionEnvelope } from "../../middleware/adaptive/execution-envelope.js";
import { readyNodes } from "../../middleware/adaptive/task-graph.js";
import {
  PARENT_DELEGATABLE_RESOURCES,
  PARENT_EXERCISABLE_RESOURCES,
  RESOURCE_PAYMENTS,
  seedGovernanceFixtures,
  startGovernedRun,
  WORKLOAD_ARTIFACT_TYPES,
} from "../../middleware/governance/fixtures.js";
import { resolveGrant } from "../../middleware/governance/grant-resolver.js";
import {
  ARTIFACT_TEST_PLAN,
  ARTIFACT_UI_PLAN,
  TEST_PLAN_SCHEMA,
  UI_PLAN_SCHEMA,
} from "./artifacts.js";
import { createTodoDelegationPort, TodoWorkspaceExecutor } from "./adapter.js";
import {
  ARTIFACT_TEST_PLAN_RESULT,
  ARTIFACT_UI_PLAN_RESULT,
  ARTIFACT_WORKSPACE_SUMMARY,
  buildTodoGraph,
  TASK_IMPLEMENTATION,
  TASK_OPTIONAL_REVIEWER,
  TASK_TEST_PLAN,
  TASK_UI_PLAN,
  TASK_WORKSPACE_SCAN,
} from "./graph.js";
import { seedTodoWorkload } from "./seed.js";

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

/**
 * @param burn tokens to consume before the run starts, to create budget
 *   pressure without changing the graph.
 */
async function scenario(burn = 0) {
  const root = await mkdtemp(path.join(tmpdir(), "todo-workload-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await seedGovernanceFixtures(store);
  await seedTodoWorkload(store);
  const ledger = new GovernanceLedger(store);
  const governed = await startGovernedRun(store, ledger, { runId: "run-1" });

  if (burn > 0) {
    await ledger.appendEvent("tokens_consumed", usage(burn), {
      runId: "run-1",
      grantId: governed.envelope.id,
      principalId: governed.principal.id,
    });
  }

  const executor = new TodoWorkspaceExecutor(store, ledger);
  const engine = new ExecutionEngine({
    store,
    ledger,
    executor,
    delegation: createTodoDelegationPort(store, ledger),
  });
  const identity = {
    principal: governed.principal,
    grantId: governed.envelope.id,
    runId: "run-1",
  };
  return { store, ledger, executor, engine, identity, governed };
}

const placementOf = (executor: TodoWorkspaceExecutor, taskId: string) =>
  executor.executions.find((item) => item.taskId === taskId)?.placement;

describe("Todo workload — schemas", () => {
  it("keeps both plan types to enums and bounded integers only", () => {
    for (const schema of [UI_PLAN_SCHEMA, TEST_PLAN_SCHEMA]) {
      expect(schema.maxFieldCount).toBe(4);
      expect(schema.maxSerializedBytes).toBe(256);
      // No free-text field can exist: the spec language has no kind for one.
      expect(schema.allowedFieldNames).not.toContain("summary");
      expect(schema.allowedFieldNames).not.toContain("planText");
    }
  });

  it("grants the plan types as delegatable only, leaving the boundaries intact", () => {
    expect(WORKLOAD_ARTIFACT_TYPES).toEqual([ARTIFACT_UI_PLAN, ARTIFACT_TEST_PLAN]);
    for (const type of WORKLOAD_ARTIFACT_TYPES) {
      expect(PARENT_DELEGATABLE_RESOURCES).toContain(type);
      expect(PARENT_EXERCISABLE_RESOURCES).not.toContain(type);
    }
    // The three demo boundaries are untouched.
    expect(PARENT_EXERCISABLE_RESOURCES).not.toContain(RESOURCE_PAYMENTS);
    expect(PARENT_DELEGATABLE_RESOURCES).not.toContain(RESOURCE_PAYMENTS);
    expect(PARENT_EXERCISABLE_RESOURCES).not.toContain("sec/INC-42");
  });
});

describe("Todo workload — relaxed run budget", () => {
  it("delegates both planners and runs them in one parallel wave", async () => {
    const { engine, executor, identity } = await scenario();
    const result = await engine.run(buildTodoGraph(), identity);

    expect(result.outcome).toBe("COMPLETED");
    expect(placementOf(executor, TASK_WORKSPACE_SCAN)).toBe("REUSE_CURRENT");
    expect(placementOf(executor, TASK_UI_PLAN)).toBe("DELEGATE_SPECIALIST");
    expect(placementOf(executor, TASK_TEST_PLAN)).toBe("DELEGATE_SPECIALIST");

    const planningRound = result.rounds.find((round) =>
      round.plan.waves.some((wave) => wave.nodeIds.includes(TASK_UI_PLAN)),
    );
    expect(planningRound?.plan.shape).toBe("PARALLEL");
    expect(
      planningRound?.plan.waves
        .find((wave) => wave.nodeIds.includes(TASK_UI_PLAN))
        ?.nodeIds.sort(),
    ).toEqual([TASK_TEST_PLAN, TASK_UI_PLAN]);
  });

  it("completes the required work and the optional reviewer", async () => {
    const { engine, identity } = await scenario();
    const result = await engine.run(buildTodoGraph(), identity);
    expect(result.progress.completed.has(TASK_IMPLEMENTATION)).toBe(true);
    expect(result.progress.completed.has(TASK_OPTIONAL_REVIEWER)).toBe(true);
  });
});

describe("Todo workload — pressured run budget", () => {
  it("changes topology on the same graph: reuse, serial, reviewer dropped", async () => {
    const { engine, executor, identity } = await scenario(10_200);
    const result = await engine.run(buildTodoGraph(), identity);

    // Same graph, same declared hints, different runtime state.
    expect(placementOf(executor, TASK_UI_PLAN)).toBe("REUSE_CURRENT");
    expect(placementOf(executor, TASK_TEST_PLAN)).toBe("REUSE_CURRENT");

    const planningRound = result.rounds.find((round) =>
      round.plan.assignments.some((item) => item.nodeId === TASK_UI_PLAN),
    );
    expect(planningRound?.plan.shape).toBe("SERIAL");

    // Required work still finishes; only the optional reviewer is dropped.
    expect(result.progress.completed.has(TASK_IMPLEMENTATION)).toBe(true);
    expect(result.progress.skipped.has(TASK_OPTIONAL_REVIEWER)).toBe(true);
    expect(result.outcome).toBe("COMPLETED");
  });
});

describe("Todo workload — artifact and dependency behaviour", () => {
  it("holds implementation back until both plans are committed", async () => {
    const graph = buildTodoGraph();
    const withSummaryOnly = readyNodes(graph, {
      completed: new Set([TASK_WORKSPACE_SCAN]),
      skipped: new Set(),
      artifacts: new Set([ARTIFACT_WORKSPACE_SUMMARY]),
    }).map((node) => node.id);
    expect(withSummaryOnly).not.toContain(TASK_IMPLEMENTATION);
    expect(withSummaryOnly.sort()).toEqual([TASK_TEST_PLAN, TASK_UI_PLAN]);

    const withOnePlan = readyNodes(graph, {
      completed: new Set([TASK_WORKSPACE_SCAN, TASK_UI_PLAN]),
      skipped: new Set(),
      artifacts: new Set([ARTIFACT_WORKSPACE_SUMMARY, ARTIFACT_UI_PLAN_RESULT]),
    }).map((node) => node.id);
    // One plan is not enough.
    expect(withOnePlan).not.toContain(TASK_IMPLEMENTATION);
  });

  it("withholds a delegated planner's raw output from the parent", async () => {
    const { store, identity } = await scenario();
    const resolution = resolveGrant(
      { principalId: identity.principal.id, grantId: identity.grantId, runId: "run-1" },
      store,
    );
    if (!resolution.ok) throw new Error("resolve failed");
    const implementation = buildTodoGraph().nodes.find(
      (node) => node.id === TASK_IMPLEMENTATION,
    );
    if (!implementation) throw new Error("missing task");

    const projection = projectContext(
      implementation,
      deriveExecutionEnvelope({ state: resolution.state, task: implementation }),
      [
        // Exactly what a child would hold before publishing.
        {
          id: ARTIFACT_UI_PLAN_RESULT,
          origin: "own_task_output",
          producedByPrincipalId: "some-child-principal",
          value: { layout: "split_panel" },
        },
      ],
    );
    expect(projection.included).toEqual([]);
    expect(projection.missingRequired).toContain(ARTIFACT_UI_PLAN_RESULT);
    expect(projection.withheld[0]?.reason).toBe("NOT_VISIBLE_TO_EXECUTOR");
  });

  it("admits the published bounded plans and uses them in implementation", async () => {
    const { store, engine, executor, identity } = await scenario();
    const result = await engine.run(buildTodoGraph(), identity);
    expect(result.outcome).toBe("COMPLETED");

    // Both plans crossed the Return Gate as bounded artifacts.
    const published = store.snapshot().artifacts.filter((item) => item.published);
    expect(published.map((item) => item.type).sort()).toEqual([
      ARTIFACT_TEST_PLAN,
      ARTIFACT_UI_PLAN,
    ]);
    for (const artifact of published) {
      expect(artifact.recipients).toEqual([identity.principal.id]);
      expect(Object.keys(artifact.fields)).toHaveLength(4);
    }

    // The engine admitted them as published, not as raw child output.
    const admitted = result.artifacts.filter(
      (item) => item.origin === "published_finding",
    );
    expect(admitted.map((item) => item.id).sort()).toEqual([
      ARTIFACT_TEST_PLAN_RESULT,
      ARTIFACT_UI_PLAN_RESULT,
    ]);
    expect(placementOf(executor, TASK_IMPLEMENTATION)).toBe("REUSE_CURRENT");
  });

  it("refuses to dispatch implementation when a plan never crossed the gate", async () => {
    const { store, ledger, identity } = await scenario();
    // A planner that produces its value but never publishes it.
    const silent = new TodoWorkspaceExecutor(store, ledger);
    const original = silent.execute.bind(silent);
    silent.execute = async (request) => {
      const outcome = await original(request);
      if (request.task.id === TASK_UI_PLAN && outcome.ok) {
        return {
          ...outcome,
          producedArtifacts: outcome.producedArtifacts.map((item) => ({
            id: item.id,
            value: item.value,
          })),
        };
      }
      return outcome;
    };
    const engine = new ExecutionEngine({
      store,
      ledger,
      executor: silent,
      delegation: createTodoDelegationPort(store, ledger),
    });
    const result = await engine.run(buildTodoGraph(), identity);

    expect(result.outcome).toBe("EXECUTION_FAILED");
    expect(result.failures[0]?.taskId).toBe(TASK_IMPLEMENTATION);
    expect(result.failures[0]?.reason).toContain("required context unavailable");
  });
});

describe("Todo workload — backend denial and recovery", () => {
  it("is the backend that refuses the cross-principal read, not the model", async () => {
    const { store, engine, executor, identity } = await scenario();
    const result = await engine.run(buildTodoGraph(), identity);

    // The planted runbook note was followed, and authorize() said no.
    expect(executor.denials).toEqual([
      {
        taskId: TASK_WORKSPACE_SCAN,
        resourceId: RESOURCE_PAYMENTS,
        reason: "RESOURCE_NOT_GRANTED",
      },
    ]);

    // Real evidence on the ledger, from the real gate.
    const denied = store
      .snapshot()
      .governanceEvents.filter((event) => event.kind === "resource_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.payload).toMatchObject({
      resourceId: RESOURCE_PAYMENTS,
      reason: "RESOURCE_NOT_GRANTED",
    });

    // And the run recovered: the denial was on a non-critical path.
    expect(result.outcome).toBe("COMPLETED");
    expect(result.progress.completed.has(TASK_WORKSPACE_SCAN)).toBe(true);
    expect(result.progress.completed.has(TASK_IMPLEMENTATION)).toBe(true);
  });

  it("is not rescued by spare budget or routing utility", async () => {
    const { store, engine, identity } = await scenario();
    await engine.run(buildTodoGraph(), identity);
    // No allow for payments exists anywhere in the evidence, at any budget.
    const allowed = store
      .snapshot()
      .governanceEvents.filter(
        (event) =>
          event.kind === "resource_allowed" &&
          (event.payload as { resourceId?: string }).resourceId === RESOURCE_PAYMENTS,
      );
    expect(allowed).toHaveLength(0);
  });
});

describe("Todo workload — evidence for the Run Inspector", () => {
  it("records placement, routing score, wave, usage and outcome per round", async () => {
    const { store, engine, identity } = await scenario();
    const result = await engine.run(buildTodoGraph(), identity);

    const planning = result.rounds.find((round) =>
      round.plan.assignments.some((item) => item.nodeId === TASK_UI_PLAN),
    );
    const uiAssignment = planning?.plan.assignments.find(
      (item) => item.nodeId === TASK_UI_PLAN,
    );
    // Everything a Run Inspector needs is already on the plan.
    expect(uiAssignment?.placement).toBe("DELEGATE_SPECIALIST");
    expect(uiAssignment?.delegationValue).toBeGreaterThan(0);
    expect(uiAssignment?.delegationThreshold).toBeGreaterThan(0);
    expect(uiAssignment?.wave).toBe(0);
    expect(planning?.plan.shapeReason).toBeTruthy();
    expect(planning?.executed.every((item) => item.usage.totalTokens > 0)).toBe(true);

    const kinds = store.snapshot().governanceEvents.map((event) => event.kind);
    for (const kind of [
      "principal_created",
      "grant_created",
      "resource_allowed",
      "resource_denied",
      "artifact_created",
      "artifact_published",
      "tokens_consumed",
    ]) {
      expect(kinds).toContain(kind);
    }
    expect(result.outcome).toBe("COMPLETED");
  });

  it("charges delegated usage to the child and rolls it up to the run", async () => {
    const { store, engine, identity } = await scenario();
    await engine.run(buildTodoGraph(), identity);
    const consumed = store
      .snapshot()
      .governanceEvents.filter((event) => event.kind === "tokens_consumed");
    const childCharges = consumed.filter(
      (event) => event.principalId !== identity.principal.id,
    );
    expect(childCharges.length).toBeGreaterThanOrEqual(2);
    const runState = store.snapshot().runStates[0];
    expect(runState?.tokensUsed).toBe(
      consumed.reduce(
        (total, event) =>
          total + (event.payload as { totalTokens: number }).totalTokens,
        0,
      ),
    );
  });
});
