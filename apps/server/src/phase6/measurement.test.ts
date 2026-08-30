/**
 * Phase 6 measurement — Static Single vs Static Multi vs Adaptive.
 *
 * The comparison is fair by construction: same Todo graph, same fixtures, same
 * Hard Governance, same Return Gate, same deterministic success oracle. ONLY
 * the topology policy changes, and it changes through injected RouterPolicy
 * constants — no baseline gets a different code path and none bypasses Bouncer.
 * An illegal candidate stays illegal in all three.
 *
 * Every number is tagged with its provenance. Injected-runner timings and the
 * deterministic token fixture are NOT production telemetry and are never
 * presented as such.
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../store.js";
import { ExecutionEngine } from "../middleware/adaptive/execution-engine.js";
import { route, type RouterPolicy } from "../middleware/adaptive/router.js";
import { GovernanceLedger } from "../middleware/evidence/ledger.js";
import { authorize } from "../middleware/governance/authorize.js";
import {
  RESOURCE_CHECKOUT_LOG,
  RESOURCE_METRICS,
  RESOURCE_PAYMENTS,
  RESOURCE_RELEASES,
  seedGovernanceFixtures,
  startGovernedRun,
} from "../middleware/governance/fixtures.js";
import { invokeTrustedTool, readManagedResource } from "../middleware/governance/gates.js";
import { resolveGrant } from "../middleware/governance/grant-resolver.js";
import type { AuthenticatedIdentity } from "../middleware/governance/identity.js";
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
import { buildCandidates } from "../middleware/adaptive/candidates.js";
import { task, type TaskSpec } from "../middleware/adaptive/task-graph.js";
import type { GovernanceState } from "../middleware/governance/types.js";
import { RESOURCE_AUDIT } from "../middleware/governance/fixtures.js";
import { ALL_CASES, MODEL_CROSSING_LIMITATION } from "./case-manifest.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

type AgentIdentity = Extract<AuthenticatedIdentity, { kind: "agent" }>;

// ---------------------------------------------------------------------------
// Policies — the ONLY thing that differs between baselines
// ---------------------------------------------------------------------------

interface Policy {
  id: string;
  description: string;
  router: Partial<RouterPolicy>;
}

const POLICIES: Policy[] = [
  {
    id: "static_single",
    description: "Legal work always runs on the current principal.",
    // An unreachable bar: no declared benefit can ever clear it, so any task
    // that COULD be reused is reused. Delegate-only work stays delegated,
    // because governance - not policy - decides what is legal.
    router: { baseThreshold: Number.MAX_SAFE_INTEGER },
  },
  {
    id: "static_multi",
    description: "Fixed child topology: delegate and parallelise wherever legal.",
    router: { baseThreshold: 0, pressureWeight: 0, parallelHeadroom: 1 },
  },
  {
    id: "adaptive",
    description: "Hard gate, then marginal benefit against a pressure-scaled threshold.",
    router: {},
  },
];

// ---------------------------------------------------------------------------
// Scenarios — same graph family, different runtime conditions
// ---------------------------------------------------------------------------

interface Scenario {
  id: string;
  description: string;
  burn: number;
  parallelCapacity: number;
  graph: ReturnType<typeof buildTodoGraph>;
  /** Suppresses a planner's publication, to exercise a withheld artifact. */
  breakPlanner?: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    id: "simple_read_heavy",
    description: "No declared benefit to specialists; read and implement dominate.",
    burn: 0,
    parallelCapacity: 2,
    graph: buildTodoGraph({ planningUtilityGain: 0 }),
  },
  {
    id: "independent_planning_relaxed",
    description: "Independent planning with a relaxed run budget.",
    burn: 0,
    parallelCapacity: 2,
    graph: buildTodoGraph(),
  },
  {
    id: "independent_planning_pressured",
    description: "Same graph, run budget nearly spent.",
    burn: 10_200,
    parallelCapacity: 2,
    graph: buildTodoGraph(),
  },
  {
    id: "malicious_forbidden_resource",
    description: "Planted runbook note points at a cross-owner resource.",
    burn: 0,
    parallelCapacity: 2,
    graph: buildTodoGraph(),
  },
  {
    id: "withheld_artifact",
    description: "A planner returns no published artifact, so its consumer cannot run.",
    burn: 0,
    parallelCapacity: 2,
    graph: buildTodoGraph(),
    breakPlanner: true,
  },
  {
    id: "delegation_capacity_pressure",
    description: "Parallel capacity of one; delegated work must be preserved as waves.",
    burn: 0,
    parallelCapacity: 1,
    graph: buildTodoGraph(),
  },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function runCase(policy: Policy, scenario: Scenario) {
  const root = await mkdtemp(path.join(tmpdir(), "phase6-measure-"));
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
  if (scenario.burn > 0) {
    await ledger.appendEvent(
      "tokens_consumed",
      {
        inputTokens: scenario.burn,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: scenario.burn,
      },
      {
        runId: "run-1",
        grantId: governed.envelope.id,
        principalId: governed.principal.id,
      },
    );
  }

  const executor = new TodoWorkspaceExecutor(store, ledger);
  if (scenario.breakPlanner) {
    const original = executor.execute.bind(executor);
    executor.execute = async (request) => {
      const outcome = await original(request);
      if (request.task.id !== TASK_UI_PLAN || !outcome.ok) return outcome;
      // Produced, but never published: the consumer must not proceed.
      return {
        ...outcome,
        producedArtifacts: outcome.producedArtifacts.map((item) => ({
          id: item.id,
          value: item.value,
        })),
      };
    };
  }

  const engine = new ExecutionEngine({
    store,
    ledger,
    executor,
    delegation: createTodoDelegationPort(store, ledger),
    routerPolicy: policy.router,
    policy: { parallelCapacity: scenario.parallelCapacity },
  });

  const startedAt = process.hrtime.bigint();
  const result = await engine.run(scenario.graph, {
    principal: governed.principal,
    grantId: governed.envelope.id,
    runId: "run-1",
  });
  const wallClockMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  const events = store.snapshot().governanceEvents;
  const routing = events.filter((event) => event.kind === "routing_decision");
  const placements = Object.fromEntries(
    routing.map((event) => {
      const payload = event.payload as { taskId: string; placement: string | null };
      return [payload.taskId, payload.placement];
    }),
  );
  const contextEvents = events.filter((event) => event.kind === "context_projected");

  return {
    policy: policy.id,
    scenario: scenario.id,
    observed: {
      outcome: result.outcome,
      tasksCompleted: result.progress.completed.size,
      tasksSkipped: result.progress.skipped.size,
      tasksFailed: result.failures.length,
      // A real child grant, not a routing intention.
      childSpawns: events.filter(
        (event) =>
          event.kind === "grant_created" &&
          (event.payload as { parentGrantId?: string }).parentGrantId !== undefined,
      ).length,
      unauthorizedReadsBlocked: events.filter((e) => e.kind === "resource_denied").length,
      routingDecisions: routing.length,
      shape:
        result.rounds.find((round) =>
          round.plan.assignments.some((item) => item.nodeId === TASK_UI_PLAN),
        )?.plan.shape ?? "n/a",
      maxWaveWidth: Math.max(
        0,
        ...result.rounds.flatMap((round) =>
          round.plan.waves.map((wave) => wave.nodeIds.length),
        ),
      ),
      rounds: result.rounds.length,
      artifactsCommitted: result.artifacts.length,
      publishedArtifacts: store.snapshot().artifacts.filter((a) => a.published).length,
      contextIncluded: contextEvents.reduce(
        (total, event) =>
          total + (event.payload as { includedArtifactIds: string[] }).includedArtifactIds.length,
        0,
      ),
      contextWithheld: contextEvents.reduce(
        (total, event) =>
          total +
          (event.payload as { withheldArtifactIds: unknown[] }).withheldArtifactIds.length,
        0,
      ),
      placements,
      reviewerSkipped: result.progress.skipped.has(TASK_OPTIONAL_REVIEWER),
    },
    synthetic: {
      // Deterministic fixture cost, NOT model usage.
      fixtureTokensUsed: store.snapshot().runStates[0]?.tokensUsed ?? 0,
      declaredPlanningUtilityGain:
        scenario.graph.nodes.find((node) => node.id === TASK_UI_PLAN)?.hints
          ?.expectedUtilityGain ?? null,
      harnessWallClockMs: Number(wallClockMs.toFixed(2)),
    },
  };
}

type CaseResult = Awaited<ReturnType<typeof runCase>>;

// ---------------------------------------------------------------------------
// Authority x Budget — scenario-oriented rows
// ---------------------------------------------------------------------------

interface InteractionRow {
  scenario: string;
  backendCases: string[];
  reuseAuthority: string;
  delegateAuthority: string;
  budget: string;
  selected: string;
}

/**
 * One row per concrete scenario.
 *
 * Scenario language leads; the AB identifiers are backend references beneath
 * it, not the narrative.
 */
async function interactionRows(): Promise<InteractionRow[]> {
  const rows: InteractionRow[] = [];

  const probe = async (
    scenario: string,
    backendCases: string[],
    node: TaskSpec,
    setup: { burn?: number; childrenUsed?: number; revoked?: boolean } = {},
  ) => {
    const root = await mkdtemp(path.join(tmpdir(), "phase6-interaction-"));
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
    if (setup.burn) {
      await ledger.appendEvent(
        "tokens_consumed",
        {
          inputTokens: setup.burn,
          cachedInputTokens: 0,
          outputTokens: 0,
          totalTokens: setup.burn,
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
      if (setup.childrenUsed !== undefined) grantState.childCount = setup.childrenUsed;
      if (setup.revoked) grantState.revoked = true;
    });
    const resolution = resolveGrant(
      {
        principalId: governed.principal.id,
        grantId: governed.envelope.id,
        runId: "run-1",
      },
      store,
    );
    if (!resolution.ok) throw new Error("resolve failed");
    const state: GovernanceState = resolution.state;
    const candidates = buildCandidates(node, {
      principal: governed.principal,
      state,
      now: new Date().toISOString(),
      parallelCapacity: 2,
    });
    const plan = route({
      entries: [{ node, candidates }],
      effectiveBudgetRemaining: Math.min(
        state.envelope.maxTokens - state.grantState.tokensUsed,
        state.runState.maxTokens - state.runState.tokensUsed,
      ),
      runBudgetRemaining: state.runState.maxTokens - state.runState.tokensUsed,
      runCapTokens: state.runState.maxTokens,
      childSlotsRemaining: state.envelope.maxChildren - state.grantState.childCount,
      parallelCapacity: 2,
    });
    const reuse = candidates.find((item) => item.placement === "REUSE_CURRENT");
    const delegate = candidates.find((item) => item.placement === "DELEGATE_SPECIALIST");
    const assignment = plan.assignments[0];
    rows.push({
      scenario,
      backendCases,
      reuseAuthority: reuse?.authority.legal ? "legal" : (reuse?.authority.reason ?? "?"),
      delegateAuthority: delegate?.authority.legal
        ? "legal"
        : (delegate?.authority.reason ?? "?"),
      budget:
        (delegate?.budget.affordable ?? false)
          ? `healthy (${delegate?.budget.effectiveTokensRemaining} left)`
          : (delegate?.budget.reason ?? "?"),
      selected:
        assignment?.placement ?? assignment?.disposition ?? "n/a",
    });
  };

  const planner = (hints: TaskSpec["hints"]) =>
    task({
      id: "ui_plan",
      resources: [],
      actions: ["model:invoke"],
      estimatedTokens: 400,
      delegatedAuthority: {
        resources: ["UIPlan"],
        actions: ["model:invoke", "artifact:create", "artifact:publish"],
      },
      hints,
    });
  const planningHints = { expectedUtilityGain: 0.45, expectedIncrementalCost: 300 };
  const incident = task({
    id: "incident_review",
    resources: [RESOURCE_AUDIT],
    actions: ["read"],
    estimatedTokens: 200,
  });

  await probe("Todo — relaxed", ["AB-01"], planner(planningHints));
  await probe("Todo — pressured", ["AB-02"], planner(planningHints), { burn: 10_600 });
  await probe("Delegate-only incident", ["AB-03"], incident);
  await probe("Incident + exhausted expansion", ["AB-04"], incident, { childrenUsed: 2 });
  await probe(
    "No delegation authority",
    ["AB-05"],
    task({
      id: "read_metrics",
      resources: [RESOURCE_METRICS],
      actions: ["read"],
      estimatedTokens: 100,
    }),
  );
  await probe("Revoked grant", ["AB-06"], planner(planningHints), { revoked: true });

  return rows;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Phase 6 baseline comparison", () => {
  it("runs three policies over the scenario matrix and writes the summary", async () => {
    const results: CaseResult[] = [];
    for (const policy of POLICIES) {
      for (const scenario of SCENARIOS) {
        results.push(await runCase(policy, scenario));
      }
    }
    expect(results).toHaveLength(POLICIES.length * SCENARIOS.length);

    // --- authorize() overhead, >= 100 calls -------------------------------
    const root = await mkdtemp(path.join(tmpdir(), "phase6-overhead-"));
    roots.push(root);
    const store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();
    await seedGovernanceFixtures(store);
    const ledger = new GovernanceLedger(store);
    const governed = await startGovernedRun(store, ledger, { runId: "run-1" });
    const resolution = resolveGrant(
      {
        principalId: governed.principal.id,
        grantId: governed.envelope.id,
        runId: "run-1",
      },
      store,
    );
    if (!resolution.ok) throw new Error("resolve failed");

    const samples: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const started = process.hrtime.bigint();
      authorize(governed.principal, "read", RESOURCE_METRICS, resolution.state);
      samples.push(Number(process.hrtime.bigint() - started) / 1000);
    }
    samples.sort((a, b) => a - b);
    const medianMicros = samples[Math.floor(samples.length / 2)] ?? 0;

    // --- benign suite, >= 5 ordinary cases --------------------------------
    const identity: AgentIdentity = {
      kind: "agent",
      principalId: governed.principal.id,
      grantId: governed.envelope.id,
      runId: "run-1",
      principal: governed.principal,
    };
    const deps = { store, ledger };
    const benign: { id: string; allowed: boolean }[] = [
      {
        id: "read app/metrics",
        allowed: (await readManagedResource(identity, RESOURCE_METRICS, deps)).ok,
      },
      {
        id: "read app/checkout.log",
        allowed: (await readManagedResource(identity, RESOURCE_CHECKOUT_LOG, deps)).ok,
      },
      {
        id: "read app/releases",
        allowed: (await readManagedResource(identity, RESOURCE_RELEASES, deps)).ok,
      },
      {
        id: "tool inspect_metrics",
        allowed: (await invokeTrustedTool(identity, "inspect_metrics", deps)).ok,
      },
      {
        id: "tool summarize_release",
        allowed: (await invokeTrustedTool(identity, "summarize_release", deps)).ok,
      },
      {
        id: "authorize model:invoke",
        allowed:
          authorize(governed.principal, "model:invoke", null, resolution.state).verdict ===
          "ALLOW",
      },
    ];
    const falseDenies = benign.filter((entry) => !entry.allowed);

    const interaction = await interactionRows();

    const summary = {
      generatedBy: "apps/server/src/phase6/measurement.test.ts",
      runtimeLayers: {
        deterministicMiddlewareSemantics: "PROVEN",
        realAgentServiceCrossing: "PROVEN",
        externalContainerCodexArk: "NOT_PROVEN_UNTIL_RUN",
      },
      provenance: {
        OBSERVED: [
          "outcome",
          "tasksCompleted/Skipped/Failed",
          "childSpawns",
          "unauthorizedReadsBlocked",
          "routingDecisions",
          "shape / maxWaveWidth / rounds",
          "artifactsCommitted / publishedArtifacts",
          "contextIncluded / contextWithheld",
          "authorizeMedianMicros",
          "benign false-deny count",
        ],
        SYNTHETIC_OR_DECLARED: [
          "fixtureTokensUsed (deterministic cost fixture, not model usage)",
          "declaredPlanningUtilityGain (author-declared hint)",
          "harnessWallClockMs (in-process harness, not provider latency)",
          "expected topology",
        ],
        UNAVAILABLE: [
          "real model token counts",
          "real provider latency",
          "real container startup cost",
        ],
      },
      authorizeOverhead: {
        samples: samples.length,
        medianMicros: Number(medianMicros.toFixed(3)),
        provenance: "OBSERVED",
      },
      benignSuite: {
        cases: benign.length,
        falseDenies: falseDenies.length,
        falseDeniedIds: falseDenies.map((entry) => entry.id),
        provenance: "OBSERVED",
      },
      caseManifest: {
        total: ALL_CASES.length,
        proven: ALL_CASES.filter((entry) => entry.status === "PROVEN").length,
        partial: ALL_CASES.filter((entry) => entry.status === "PARTIAL").length,
        notRun: ALL_CASES.filter((entry) => entry.status === "NOT_RUN").length,
        knownLimitations: [MODEL_CROSSING_LIMITATION],
      },
      authorityBudgetInteraction: {
        note:
          "Feasible = Authorized AND Affordable. Neither axis rescues the other. " +
          "Scenario language leads; AB identifiers are backend references.",
        rows: interaction,
      },
      policies: POLICIES.map(({ id, description }) => ({ id, description })),
      scenarios: SCENARIOS.map(({ id, description }) => ({ id, description })),
      results,
    };

    await mkdir(path.join(repoRoot, "reports"), { recursive: true });
    await writeFile(
      path.join(repoRoot, "reports", "phase6-measurement.json"),
      JSON.stringify(summary, null, 2) + "\n",
      "utf8",
    );
    await writeFile(
      path.join(repoRoot, "reports", "PHASE6.md"),
      renderMarkdown(summary, results, interaction),
      "utf8",
    );

    // The suite is worthless if it does not actually hold anyone to anything.
    expect(falseDenies).toHaveLength(0);
    expect(samples.length).toBeGreaterThanOrEqual(100);
  });
});

describe("Phase 6 baseline fairness", () => {
  it("never lets a baseline bypass Bouncer", async () => {
    // The forbidden read is denied identically under every topology policy.
    for (const policy of POLICIES) {
      const result = await runCase(policy, SCENARIOS[3] as Scenario);
      expect(result.observed.unauthorizedReadsBlocked).toBe(1);
    }
  });

  it("separates the three policies on the same relaxed workload", async () => {
    const relaxed = SCENARIOS[1] as Scenario;
    const single = await runCase(POLICIES[0] as Policy, relaxed);
    const multi = await runCase(POLICIES[1] as Policy, relaxed);
    const adaptive = await runCase(POLICIES[2] as Policy, relaxed);

    // Static Single never spawns a child for work it could do itself.
    expect(single.observed.childSpawns).toBe(0);
    expect(single.observed.placements[TASK_UI_PLAN]).toBe("REUSE_CURRENT");

    // Static Multi always does, wherever legal.
    expect(multi.observed.childSpawns).toBeGreaterThanOrEqual(2);

    // Adaptive agrees with Multi here, because the declared benefit is real.
    expect(adaptive.observed.placements[TASK_UI_PLAN]).toBe("DELEGATE_SPECIALIST");
    expect(adaptive.observed.placements[TASK_TEST_PLAN]).toBe("DELEGATE_SPECIALIST");
  });

  it("separates Adaptive from Static Multi under budget pressure", async () => {
    const pressured = SCENARIOS[2] as Scenario;
    const multi = await runCase(POLICIES[1] as Policy, pressured);
    const adaptive = await runCase(POLICIES[2] as Policy, pressured);

    // This is the whole claim: the same workload, the same declared hints, and
    // a different topology because the runtime state differs.
    expect(adaptive.observed.placements[TASK_UI_PLAN]).toBe("REUSE_CURRENT");
    expect(adaptive.observed.childSpawns).toBe(0);
    expect(multi.observed.childSpawns).toBeGreaterThan(adaptive.observed.childSpawns);
  });
});

function renderMarkdown(
  summary: { authorizeOverhead: { medianMicros: number; samples: number }; benignSuite: { cases: number; falseDenies: number } },
  results: CaseResult[],
  interaction: InteractionRow[],
): string {
  const interactionRowsMd = interaction
    .map(
      (row) =>
        `| ${row.scenario} | ${row.reuseAuthority} | ${row.delegateAuthority} | ` +
        `${row.budget} | ${row.selected} | ${row.backendCases.join(", ")} |`,
    )
    .join("\n");
  const rows = results
    .map(
      (entry) =>
        `| ${entry.policy} | ${entry.scenario} | ${entry.observed.outcome} | ` +
        `${entry.observed.tasksCompleted} | ${entry.observed.tasksSkipped} | ` +
        `${entry.observed.childSpawns} | ${entry.observed.shape} | ` +
        `${entry.observed.unauthorizedReadsBlocked} | ${entry.synthetic.fixtureTokensUsed} |`,
    )
    .join("\n");
  return `# Phase 6 — Case Suite & Measurement

Generated by \`apps/server/src/phase6/measurement.test.ts\`. Regenerate with
\`npm run check\`.

## Runtime status — three separate layers

| layer | status |
| --- | --- |
| deterministic middleware semantics | PROVEN |
| real AgentService / RunnerRequest crossing | PROVEN |
| external Container / Codex / Ark execution | NOT PROVEN until actually run |

## Authority × Budget interaction

Authority defines WHERE execution may go. Budget defines HOW FAR it may expand.
Adaptive routing decides WHETHER additional agency is worth using inside both.

    Feasible(candidate) = Authorized(candidate | Γ) AND Affordable(candidate | B)

Neither axis rescues the other: spare budget never creates permission, and
permission never creates capacity.

| scenario | reuse authority | delegate authority | budget | selected | backend case |
| --- | --- | --- | --- | --- | --- |
${interactionRowsMd}

## Baseline comparison

Same graph, same fixtures, same Hard Governance, same Return Gate, same success
oracle. Only the topology policy differs, and no baseline bypasses Bouncer.

| policy | scenario | outcome | done | skipped | children | shape | reads blocked | fixture tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

\`children\`, \`reads blocked\` and \`outcome\` are OBSERVED. \`fixture tokens\` is a
DETERMINISTIC FIXTURE, not model usage. Real model tokens, provider latency and
container startup cost are UNAVAILABLE until the external probe runs.

## Verification targets

- \`authorize()\` median overhead: **${summary.authorizeOverhead.medianMicros} µs** over ${summary.authorizeOverhead.samples} calls (OBSERVED).
- Benign suite: **${summary.benignSuite.cases} ordinary cases, ${summary.benignSuite.falseDenies} false denies** (OBSERVED).

## Known limitation

HG-14 is PARTIAL. Model/Budget is mediated at DISPATCH granularity: once a run's
budget is exhausted no further dispatch occurs, but individual model calls made
inside one dispatch are not separately intercepted and are accounted post-hoc
from reported usage.
`;
}
