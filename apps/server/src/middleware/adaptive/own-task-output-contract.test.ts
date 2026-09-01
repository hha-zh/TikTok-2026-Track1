import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../store.js";
import { GovernanceLedger } from "../evidence/ledger.js";
import { registerArtifactFieldSpecs } from "../governance/artifacts.js";
import { seedGovernanceFixtures, startGovernedRun } from "../governance/fixtures.js";
import {
  ExecutionEngine,
  type EngineIdentity,
  type TaskExecutionRequest,
  type TaskExecutionResult,
  type TaskExecutor,
} from "./execution-engine.js";
import { task, type TaskGraph } from "./task-graph.js";

/**
 * Stage 7D.5 finding N.
 *
 * commitArtifacts branches on `publishedArtifactId === undefined`. That branch
 * exists for a good reason — same-principal output does not cross a principal
 * boundary, so it must NOT be forced through the cross-principal Return Gate.
 * But it previously also skipped the declared `producedArtifactTypes` contract
 * and all schema validation, so a task could satisfy a typed dependency with
 * arbitrary output simply by declining to publish.
 *
 * These tests pin the repair: the type contract is enforced on the unpublished
 * branch too, and it fails CLOSED.
 */
const PROBE_TYPE = "OwnOutputContractProbe";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FixedOutputExecutor implements TaskExecutor {
  constructor(private readonly values: Record<string, unknown>) {}
  async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
    return {
      ok: true,
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, totalTokens: 10 },
      // No publishedArtifactId: this is the own_task_output branch.
      producedArtifacts: request.task.producedArtifacts.map((id) => ({
        id, value: this.values[id],
      })),
    };
  }
}

async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), "own-output-contract-"));
  roots.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await seedGovernanceFixtures(store);
  registerArtifactFieldSpecs(PROBE_TYPE, {
    verdict: { kind: "enum", values: ["pass", "fail"] },
    score: { kind: "int", min: 0, max: 100 },
  });
  await store.mutate((database) => {
    if (!database.artifactSchemas.some((item) => item.artifactType === PROBE_TYPE)) {
      database.artifactSchemas.push({
        artifactType: PROBE_TYPE, version: 1, maxFieldCount: 2,
        maxSerializedBytes: 256, allowedFieldNames: ["verdict", "score"],
      });
    }
  });
  const ledger = new GovernanceLedger(store);
  const governed = await startGovernedRun(store, ledger, { runId: "own-output-run" });
  const identity: EngineIdentity = {
    principal: governed.principal, grantId: governed.envelope.id, runId: "own-output-run",
  };
  return { store, ledger, identity };
}

const typedGraph = (): TaskGraph => ({
  id: "own-output-graph",
  nodes: [
    task({
      id: "produce", actions: ["model:invoke"],
      producedArtifacts: ["probe"], producedArtifactTypes: { probe: PROBE_TYPE },
    }),
    task({
      id: "consume", actions: ["model:invoke"],
      dependsOn: ["produce"], requiredArtifacts: ["probe"],
    }),
  ],
});

const run = async (values: Record<string, unknown>, graph: TaskGraph = typedGraph()) => {
  const { store, ledger, identity } = await harness();
  const engine = new ExecutionEngine({
    store, ledger, executor: new FixedOutputExecutor(values),
    delegation: { async delegate() { return { ok: false, reason: "GRANT_NOT_FOUND" }; } },
  });
  return engine.run(graph, identity);
};

describe("finding N — declared artifact contract on the unpublished commit branch", () => {
  it("admits own_task_output that satisfies its declared type", async () => {
    const result = await run({ probe: { verdict: "pass", score: 40 } });
    expect(result.outcome).toBe("COMPLETED");
    expect(result.progress.completed.has("produce")).toBe(true);
    expect(result.progress.completed.has("consume")).toBe(true);
  });

  it("REGRESSION: fails closed on an undeclared field name", async () => {
    const result = await run({ probe: { verdict: "pass", raw_model_answer: "because..." } });
    expect(result.outcome).not.toBe("COMPLETED");
    expect(result.progress.completed.has("produce")).toBe(false);
  });

  it("REGRESSION: fails closed on a value outside its field specification", async () => {
    const result = await run({ probe: { verdict: "definitely maybe", score: 40 } });
    expect(result.outcome).not.toBe("COMPLETED");
    expect(result.progress.completed.has("produce")).toBe(false);
  });

  it("REGRESSION: fails closed when the output is not a field record at all", async () => {
    const result = await run({ probe: "the passport looked fine to me" });
    expect(result.outcome).not.toBe("COMPLETED");
    expect(result.progress.completed.has("produce")).toBe(false);
  });

  it("REGRESSION: fails closed when the declared type has no registered schema", async () => {
    const graph: TaskGraph = {
      id: "unregistered-graph",
      nodes: [task({
        id: "produce", actions: ["model:invoke"],
        producedArtifacts: ["probe"], producedArtifactTypes: { probe: "NeverRegisteredType" },
      })],
    };
    const result = await run({ probe: { verdict: "pass" } }, graph);
    expect(result.outcome).not.toBe("COMPLETED");
  });

  it("REGRESSION: an invalid artifact never satisfies a downstream dependency", async () => {
    const result = await run({ probe: { verdict: "not-a-valid-enum" } });
    // The consumer depends on `probe`. If the invalid value had been committed,
    // the consumer would have become ready and run.
    expect(result.progress.completed.has("consume")).toBe(false);
  });

  it("leaves untyped own_task_output behaviour unchanged", async () => {
    // Tasks that declare no producedArtifactTypes (Travel T0/T3) keep working
    // exactly as before: there is no contract to enforce.
    const graph: TaskGraph = {
      id: "untyped-graph",
      nodes: [
        task({ id: "produce", actions: ["model:invoke"], producedArtifacts: ["freeform"] }),
        task({ id: "consume", actions: ["model:invoke"], dependsOn: ["produce"], requiredArtifacts: ["freeform"] }),
      ],
    };
    const result = await run({ freeform: { anything: "at all", nested: { deep: true } } }, graph);
    expect(result.outcome).toBe("COMPLETED");
    expect(result.progress.completed.has("consume")).toBe(true);
  });

  it("does not route same-principal output through the cross-principal Return Gate", async () => {
    const { store, ledger, identity } = await harness();
    const engine = new ExecutionEngine({
      store, ledger, executor: new FixedOutputExecutor({ probe: { verdict: "pass", score: 1 } }),
      delegation: { async delegate() { return { ok: false, reason: "GRANT_NOT_FOUND" }; } },
    });
    const result = await engine.run(typedGraph(), identity);
    expect(result.outcome).toBe("COMPLETED");
    // Validation happened inline: no artifact was created or published, and no
    // Return Gate event was emitted for this same-principal output.
    const database = store.snapshot();
    expect(database.artifacts).toHaveLength(0);
    const kinds = database.governanceEvents
      .filter((event) => event.runId === "own-output-run").map((event) => event.kind);
    expect(kinds).not.toContain("artifact_created");
    expect(kinds).not.toContain("artifact_published");
  });
});
