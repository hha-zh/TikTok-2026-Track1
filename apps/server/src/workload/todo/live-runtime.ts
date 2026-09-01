/**
 * Live runtime adapters — the Adaptive Runtime driving the REAL Starter Kit
 * Agent path.
 *
 * The deterministic `TodoWorkspaceExecutor` stays; it is the reproducible one.
 * This is the second adapter, and the difference is what it proves:
 *
 *   deterministic adapter   real governed child Principal / Grant
 *                           + in-process execution
 *   live adapter (this)     real Starter Kit child AGENT, real workspace,
 *                           real RunnerRequest, real child RUN_TOKEN handoff
 *
 * It orchestrates the existing implementation rather than duplicating it:
 * `DelegatedAgentLauncher` owns the child lifecycle, `AgentService` owns
 * execution, and the Artifact Gate owns publication. Nothing here re-creates
 * any of them.
 *
 * The Return-Gate boundary is unchanged and is NOT solved by reading the
 * child's assistant message. A delegated planner publishes a bounded artifact
 * under its own identity and the engine admits that; the message is never
 * looked at.
 */

import type { AgentService } from "../../agent-service.js";
import type { GovernanceLedger } from "../../middleware/evidence/ledger.js";
import type { JsonStore } from "../../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../types.js";
import type { ProjectedContext } from "../../middleware/adaptive/context-broker.js";
import type {
  DelegationPort,
  TaskExecutionRequest,
  TaskExecutionResult,
  TaskExecutor,
  TaskUsage,
} from "../../middleware/adaptive/execution-engine.js";
import {
  createArtifact,
  publishArtifact,
} from "../../middleware/governance/artifacts.js";
import { readManagedResource } from "../../middleware/governance/gates.js";
import type { AuthenticatedIdentity } from "../../middleware/governance/identity.js";
import type { RunTokenService } from "../../middleware/governance/run-token.js";
import { RESOURCE_PAYMENTS } from "../../middleware/governance/fixtures.js";
import type {
  DelegatedAgentLauncher,
  PreparedChild,
} from "../../middleware/runtime/delegated-agent-launcher.js";
import type { Principal } from "../../middleware/governance/types.js";
import { ARTIFACT_TEST_PLAN, ARTIFACT_UI_PLAN } from "./artifacts.js";
import {
  ARTIFACT_IMPLEMENTATION,
  ARTIFACT_TEST_PLAN_RESULT,
  ARTIFACT_UI_PLAN_RESULT,
  ARTIFACT_WORKSPACE_SUMMARY,
  TASK_IMPLEMENTATION,
  TASK_TEST_PLAN,
  TASK_UI_PLAN,
  TASK_WORKSPACE_SCAN,
} from "./graph.js";

type AgentIdentity = Extract<AuthenticatedIdentity, { kind: "agent" }>;

const TASK_MARKER = /\[bouncer-task:([a-z_]+)\]/;

/** The prompt an Agent receives. The task id is part of it, as it would be. */
export function taskPrompt(taskId: string, description: string): string {
  return `[bouncer-task:${taskId}] ${description}`;
}

/**
 * The bounded packet an Agent actually receives.
 *
 * Built from `context.included` ONLY. Withheld artifacts are not summarised,
 * not named and not hinted at — if the ContextBroker withheld something, the
 * Agent input must contain no trace of it, or least-context would be a
 * property of the engine and not of what the model sees.
 */
export function contextPacket(
  taskId: string,
  description: string,
  context: ProjectedContext,
): string {
  const included = context.included.map((item) => ({
    id: item.id,
    value: item.value,
  }));
  return (
    taskPrompt(taskId, description) +
    "\n\nCONTEXT:\n" +
    JSON.stringify({ artifacts: included })
  );
}

const tokens = (total: number): TaskUsage => ({
  inputTokens: total,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: total,
});

const PLAN_FIELDS: Record<string, { type: string; fields: Record<string, unknown> }> = {
  [TASK_UI_PLAN]: {
    type: ARTIFACT_UI_PLAN,
    fields: {
      layout: "split_panel",
      interaction: "inline",
      responsive: "mobile_first",
      component_count: 6,
    },
  },
  [TASK_TEST_PLAN]: {
    type: ARTIFACT_TEST_PLAN,
    fields: {
      coverage: "core_and_edge",
      interaction_tests: 8,
      accessibility: "required",
      responsive_tests: 3,
    },
  },
};

/**
 * A deterministic stand-in for Codex, injected as the real `AgentRunner`.
 *
 * It behaves like the real thing in the way that matters for governance: it
 * receives a `RunnerRequest`, reads the `RUN_TOKEN` it was handed, verifies it,
 * and then acts ONLY as the principal that token names — calling the same
 * Resource Gate and Artifact Gate over the same code paths a container would
 * reach over HTTP.
 *
 * This is what lets the integration be proven without Docker or Ark. It is a
 * substitute for the model, never for the governance path.
 */
export class GovernedProbeRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];
  readonly denials: { taskId: string; resourceId: string; reason: string }[] = [];

  constructor(
    private readonly store: JsonStore,
    private readonly ledger: GovernanceLedger,
    private readonly runTokens: RunTokenService,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    const taskId = TASK_MARKER.exec(request.prompt)?.[1] ?? "unknown";

    // No token means no governed identity, so no gate may be crossed.
    if (!request.runtimeRunToken) {
      return { output: `[${taskId}] ungoverned`, threadId: "thread", usage: null };
    }
    const claims = this.runTokens.verify(request.runtimeRunToken);
    const principal = this.store
      .snapshot()
      .principals.find((item) => item.id === claims.principalId);
    if (!principal || principal.kind !== "agent") {
      return { output: `[${taskId}] unknown principal`, threadId: "thread", usage: null };
    }
    const identity: AgentIdentity = {
      kind: "agent",
      principalId: claims.principalId,
      grantId: claims.grantId,
      runId: claims.runId,
      principal: principal as Principal,
    };
    const dependencies = { store: this.store, ledger: this.ledger };

    if (taskId === TASK_WORKSPACE_SCAN) {
      await readManagedResource(identity, "app/metrics", dependencies);
      const log = await readManagedResource(identity, "app/checkout.log", dependencies);
      if (log.ok) {
        const rows = ((log.value as { rows?: string[] }).rows ?? []).map(String);
        if (rows.some((row) => row.includes(RESOURCE_PAYMENTS))) {
          // Follow the runbook note. The backend is what refuses.
          const attempted = await readManagedResource(
            identity,
            RESOURCE_PAYMENTS,
            dependencies,
          );
          if (!attempted.ok) {
            this.denials.push({
              taskId,
              resourceId: RESOURCE_PAYMENTS,
              reason: attempted.reason,
            });
          }
        }
      }
      return { output: `[${taskId}] scanned`, threadId: "thread", usage: null };
    }

    const plan = PLAN_FIELDS[taskId];
    if (plan) {
      // The child publishes through the real Artifact Gate under its OWN
      // identity. Its assistant output is never the channel.
      const created = await createArtifact(
        identity,
        { artifactType: plan.type, fields: plan.fields },
        dependencies,
      );
      if (!created.ok) {
        return { output: `[${taskId}] create denied`, threadId: "thread", usage: null };
      }
      const published = await publishArtifact(
        identity,
        created.value.id,
        { artifactType: plan.type, fields: plan.fields },
        dependencies,
      );
      return {
        output: `[${taskId}] ${published.ok ? "published" : "publish denied"}`,
        threadId: "thread",
        usage: null,
      };
    }

    return { output: `[${taskId}] done`, threadId: "thread", usage: null };
  }
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** Handle for a child the launcher created, kept so the executor can await it. */
export interface LaunchedChild {
  taskId: string;
  childAgentId: string;
  childPrincipalId: string;
  grantId: string;
  /** Held only until dispatch. Never persisted. */
  prepared: PreparedChild;
  dispatched: boolean;
}

export interface LiveTodoRuntime {
  delegation: DelegationPort;
  executor: TaskExecutor;
  launched: LaunchedChild[];
}

export interface LiveTodoRuntimeDependencies {
  store: JsonStore;
  ledger: GovernanceLedger;
  agents: AgentService;
  launcher: DelegatedAgentLauncher;
  /** The root Agent the current principal executes under. */
  parentAgentId: string;
  /** The root RUN_TOKEN, minted where the governed run was started. */
  parentRunToken: string;
  actualTokens?: ((taskId: string) => number) | undefined;
}

/**
 * Delegation through the real launcher.
 *
 * `launch()` owns the whole child lifecycle - grant, Agent, workspace, child
 * RUN_TOKEN, `sendGovernedMessage` - so this does not re-implement any of it.
 * The child's run is already in flight when this returns; the executor waits
 * for it.
 */
export function createLiveTodoRuntime(
  dependencies: LiveTodoRuntimeDependencies,
): LiveTodoRuntime {
  const launched: LaunchedChild[] = [];
  const parentIdentities = new Map<string, AgentIdentity>();
  const parentIdentityFor = (taskId: string) => parentIdentities.get(taskId);

  const delegation: DelegationPort = {
    async delegate({ parentPrincipal, parentGrantId, runId, task }) {
      const identity: AgentIdentity = {
        kind: "agent",
        principalId: parentPrincipal.id,
        grantId: parentGrantId,
        runId,
        principal: parentPrincipal,
      };
      parentIdentities.set(task.id, identity);
      const authority = task.delegatedAuthority ?? {
        resources: task.resources,
        actions: task.actions,
      };
      // PREPARE only. The child must not begin work before the engine has
      // derived its invocation envelope and projected its context.
      const result = await dependencies.launcher.prepare(identity, {
        exercisable: {
          resources: [...authority.resources],
          actions: [...authority.actions],
        },
        delegatable: { resources: [], actions: [] },
        maxTokens: task.estimatedTokens * 2,
        maxToolCalls: 4,
        maxChildren: 0,
      });
      if (!result.ok) return { ok: false, reason: result.reason };
      launched.push({
        taskId: task.id,
        childAgentId: result.prepared.childAgentId,
        childPrincipalId: result.prepared.childPrincipalId,
        grantId: result.prepared.grantId,
        prepared: result.prepared,
        dispatched: false,
      });
      return {
        ok: true,
        childPrincipalId: result.prepared.childPrincipalId,
        grantId: result.prepared.grantId,
      };
    },
  };

  const executor: TaskExecutor = {
    async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
      const { task: node, envelope, placement, context } = request;
      const usage = tokens(
        dependencies.actualTokens?.(node.id) ?? node.estimatedTokens,
      );
      // Built from context.included only. Withheld artifacts leave no trace.
      const packet = contextPacket(node.id, node.description, context);

      if (placement === "REUSE_CURRENT") {
        await dependencies.agents.sendGovernedMessage(
          dependencies.parentAgentId,
          packet,
          { runtimeRunToken: dependencies.parentRunToken },
        );
        await dependencies.agents.drainActiveExecutions();
        if (!runCompleted(dependencies.store, dependencies.parentAgentId)) {
          return { ok: false, producedArtifacts: [], usage, error: "run did not complete" };
        }
        const evidence = requiredEvidence(
          dependencies.store,
          node.id,
          envelope.executorPrincipalId,
        );
        if (!evidence.ok) {
          return { ok: false, producedArtifacts: [], usage, error: evidence.error };
        }
        return { ok: true, producedArtifacts: producedFor(node.id, request), usage };
      }

      // Delegated. The child was PREPARED, not started: dispatch it now, with
      // the projected context, using its own RUN_TOKEN.
      const child = launched.find((item) => item.taskId === node.id);
      if (!child) {
        return { ok: false, producedArtifacts: [], usage, error: "no prepared child" };
      }
      const parentIdentity = parentIdentityFor(child.taskId);
      if (!parentIdentity) {
        return { ok: false, producedArtifacts: [], usage, error: "no parent identity" };
      }
      const dispatched = await dependencies.launcher.dispatch(
        parentIdentity,
        child.prepared,
        packet,
      );
      child.dispatched = true;
      if (!dispatched.ok) {
        return { ok: false, producedArtifacts: [], usage, error: "child dispatch refused" };
      }
      await dependencies.agents.drainActiveExecutions();

      // Success must be backed by evidence, not by the fact that a message was
      // scheduled. The child's assistant output is never consulted; only what
      // it PUBLISHED through the Return Gate counts.
      const name = node.producedArtifacts[0];
      if (name === undefined) {
        return { ok: false, producedArtifacts: [], usage, error: "task declares no output" };
      }
      const expectedType = node.producedArtifactTypes?.[name];
      const published = dependencies.store
        .snapshot()
        .artifacts.find(
          (item) =>
            item.ownerPrincipalId === child.childPrincipalId &&
            item.published &&
            (expectedType === undefined || item.type === expectedType),
        );
      if (!published) {
        return {
          ok: false,
          producedArtifacts: [],
          usage,
          error: "child published no artifact of the contracted type",
        };
      }
      return {
        ok: true,
        producedArtifacts: [
          { id: name, value: published.fields, publishedArtifactId: published.id },
        ],
        usage,
      };
    },
  };

  return { delegation, executor, launched };
}

/** The most recent run for an Agent reached a terminal success. */
function runCompleted(store: JsonStore, agentId: string): boolean {
  const runs = store.snapshot().runs.filter((run) => run.agentId === agentId);
  return runs.at(-1)?.status === "completed";
}

/**
 * Mediated evidence a task must actually have produced.
 *
 * The live adapter must not claim success merely because a message was
 * scheduled and the queue drained. Each task is backed by the evidence its
 * work is supposed to leave on the ledger.
 */
function requiredEvidence(
  store: JsonStore,
  taskId: string,
  principalId: string,
): { ok: true } | { ok: false; error: string } {
  if (taskId !== TASK_WORKSPACE_SCAN) return { ok: true };
  const events = store.snapshot().governanceEvents;
  const allowed = events.some(
    (event) =>
      event.kind === "resource_allowed" &&
      event.principalId === principalId &&
      (event.payload as { resourceId?: string }).resourceId === "app/metrics",
  );
  return allowed
    ? { ok: true }
    : { ok: false, error: "workspace scan left no resource gate evidence" };
}

/** Own task output for the reuse path; nothing crosses a principal boundary. */
function producedFor(taskId: string, request: TaskExecutionRequest) {
  switch (taskId) {
    case TASK_WORKSPACE_SCAN:
      return [{ id: ARTIFACT_WORKSPACE_SUMMARY, value: { scanned: true } }];
    case TASK_IMPLEMENTATION:
      return [
        {
          id: ARTIFACT_IMPLEMENTATION,
          value: { usedPlans: request.context.included.length },
        },
      ];
    case TASK_UI_PLAN:
      return [{ id: ARTIFACT_UI_PLAN_RESULT, value: PLAN_FIELDS[TASK_UI_PLAN]?.fields }];
    case TASK_TEST_PLAN:
      return [
        { id: ARTIFACT_TEST_PLAN_RESULT, value: PLAN_FIELDS[TASK_TEST_PLAN]?.fields },
      ];
    default:
      return request.task.producedArtifacts.map((id) => ({ id, value: { from: taskId } }));
  }
}
