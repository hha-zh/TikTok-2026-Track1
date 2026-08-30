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
import type { DelegatedAgentLauncher } from "../../middleware/runtime/delegated-agent-launcher.js";
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

  const delegation: DelegationPort = {
    async delegate({ parentPrincipal, parentGrantId, runId, task }) {
      const identity: AgentIdentity = {
        kind: "agent",
        principalId: parentPrincipal.id,
        grantId: parentGrantId,
        runId,
        principal: parentPrincipal,
      };
      const authority = task.delegatedAuthority ?? {
        resources: task.resources,
        actions: task.actions,
      };
      const result = await dependencies.launcher.launch(
        identity,
        {
          exercisable: {
            resources: [...authority.resources],
            actions: [...authority.actions],
          },
          delegatable: { resources: [], actions: [] },
          maxTokens: task.estimatedTokens * 2,
          maxToolCalls: 4,
          maxChildren: 0,
        },
        taskPrompt(task.id, task.description),
      );
      if (!result.ok) return { ok: false, reason: result.reason };
      launched.push({
        taskId: task.id,
        childAgentId: result.handle.childAgentId,
        childPrincipalId: result.handle.childPrincipalId,
        grantId: result.handle.grantId,
      });
      return {
        ok: true,
        childPrincipalId: result.handle.childPrincipalId,
        grantId: result.handle.grantId,
      };
    },
  };

  const executor: TaskExecutor = {
    async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
      const { task: node, envelope, placement } = request;
      const usage = tokens(
        dependencies.actualTokens?.(node.id) ?? node.estimatedTokens,
      );

      if (placement === "REUSE_CURRENT") {
        // The current principal's own Agent, with the PARENT token.
        await dependencies.agents.sendGovernedMessage(
          dependencies.parentAgentId,
          taskPrompt(node.id, node.description),
          { runtimeRunToken: dependencies.parentRunToken },
        );
        await dependencies.agents.drainActiveExecutions();
        return {
          ok: true,
          producedArtifacts: producedFor(node.id, request),
          usage,
        };
      }

      // Delegated: the launcher already started the child's run.
      const child = launched.find((item) => item.taskId === node.id);
      if (!child) {
        return { ok: false, producedArtifacts: [], usage, error: "no launched child" };
      }
      await dependencies.agents.drainActiveExecutions();

      // Look for what the child PUBLISHED. Its message is never consulted.
      const expectedType = node.producedArtifactTypes?.[node.producedArtifacts[0] ?? ""];
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
          error: "child produced no published artifact",
        };
      }
      const name = node.producedArtifacts[0];
      if (name === undefined) {
        return { ok: false, producedArtifacts: [], usage, error: "task declares no output" };
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
