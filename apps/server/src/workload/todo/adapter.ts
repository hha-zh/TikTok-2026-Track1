/**
 * Todo workload adapters — the bridge between the generic runtime and the real
 * governed paths.
 *
 * There is no parallel fake child here. Delegation goes through the existing
 * `DelegationService`, resource reads go through the existing Resource Gate,
 * and a delegated planner returns its result through the existing Artifact
 * Gate. The engine then verifies the publication against the store before
 * admitting it, so the Return Gate cannot be bypassed by an adapter that simply
 * claims to have used it.
 */

import type { JsonStore } from "../../store.js";
import type { GovernanceLedger } from "../../middleware/evidence/ledger.js";
import type {
  DelegationPort,
  ProducedArtifact,
  TaskExecutionRequest,
  TaskExecutionResult,
  TaskExecutor,
  TaskUsage,
} from "../../middleware/adaptive/execution-engine.js";
import {
  createArtifact,
  publishArtifact,
} from "../../middleware/governance/artifacts.js";
import {
  DelegationService,
  type ChildEnvelopeRequest,
} from "../../middleware/governance/delegation.js";
import { readManagedResource } from "../../middleware/governance/gates.js";
import type { AuthenticatedIdentity } from "../../middleware/governance/identity.js";
import { RESOURCE_PAYMENTS } from "../../middleware/governance/fixtures.js";
import type { Principal, ReasonCode } from "../../middleware/governance/types.js";
import { ARTIFACT_TEST_PLAN, ARTIFACT_UI_PLAN } from "./artifacts.js";
import {
  ARTIFACT_IMPLEMENTATION,
  ARTIFACT_TEST_PLAN_RESULT,
  ARTIFACT_UI_PLAN_RESULT,
  ARTIFACT_WORKSPACE_SUMMARY,
  TASK_IMPLEMENTATION,
  TASK_OPTIONAL_REVIEWER,
  TASK_TEST_PLAN,
  TASK_UI_PLAN,
  TASK_WORKSPACE_SCAN,
} from "./graph.js";

type AgentIdentity = Extract<AuthenticatedIdentity, { kind: "agent" }>;

const tokens = (total: number): TaskUsage => ({
  inputTokens: total,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: total,
});

/** Real delegation: the existing governed child lifecycle, nothing parallel. */
export function createTodoDelegationPort(
  store: JsonStore,
  ledger: GovernanceLedger,
): DelegationPort {
  const service = new DelegationService({ store, ledger });
  return {
    async delegate({ parentPrincipal, parentGrantId, runId, task }) {
      const identity: AgentIdentity = {
        kind: "agent",
        principalId: parentPrincipal.id,
        grantId: parentGrantId,
        runId,
        principal: parentPrincipal,
      };
      // A delegated planner needs publication authority the parent never needs
      // when it does the work itself.
      const authority = task.delegatedAuthority ?? {
        resources: task.resources,
        actions: task.actions,
      };
      const request: ChildEnvelopeRequest = {
        exercisable: {
          resources: [...authority.resources],
          actions: [...authority.actions],
        },
        delegatable: { resources: [], actions: [] },
        maxTokens: task.estimatedTokens * 2,
        maxToolCalls: 4,
        maxChildren: 0,
      };
      const result = await service.delegate(identity, request);
      if (!result.ok) return { ok: false, reason: result.reason };
      return {
        ok: true,
        childPrincipalId: result.grant.childPrincipalId,
        grantId: result.grant.grantId,
      };
    },
  };
}

export interface TodoExecutorOptions {
  /** Per-task token cost. Deterministic, so scenarios are reproducible. */
  actualTokens?: ((taskId: string) => number) | undefined;
}

/**
 * Evidence of an attempted cross-principal read.
 *
 * The denial itself lives on the ledger as `resource_denied`; this is the
 * in-process record the integration tests assert against.
 */
export interface DenialAttempt {
  taskId: string;
  resourceId: string;
  reason: ReasonCode;
}

/**
 * Executes Todo tasks against the real gates.
 *
 * Deterministic: no model call, no container. The purpose is to exercise the
 * governance and routing paths reproducibly; a real Codex/Ark run is a separate
 * probe and is labelled as such.
 */
export class TodoWorkspaceExecutor implements TaskExecutor {
  readonly denials: DenialAttempt[] = [];
  readonly executions: { taskId: string; placement: string; principalId: string }[] = [];

  constructor(
    private readonly store: JsonStore,
    private readonly ledger: GovernanceLedger,
    private readonly options: TodoExecutorOptions = {},
  ) {}

  private identityFor(principalId: string, grantId: string, runId: string): AgentIdentity | null {
    const principal: Principal | undefined = this.store
      .snapshot()
      .principals.find((item) => item.id === principalId);
    if (!principal || principal.kind !== "agent") return null;
    return { kind: "agent", principalId, grantId, runId, principal };
  }

  async execute(request: TaskExecutionRequest): Promise<TaskExecutionResult> {
    const { task: node, envelope, placement } = request;
    const usage = tokens(this.options.actualTokens?.(node.id) ?? node.estimatedTokens);
    this.executions.push({
      taskId: node.id,
      placement,
      principalId: envelope.executorPrincipalId,
    });

    const identity = this.identityFor(
      envelope.executorPrincipalId,
      envelope.sourceGrantId,
      envelope.runId,
    );
    if (!identity) {
      return { ok: false, producedArtifacts: [], usage, error: "executor principal missing" };
    }

    switch (node.id) {
      case TASK_WORKSPACE_SCAN:
        return this.scanWorkspace(identity, usage);
      case TASK_UI_PLAN:
        return this.plan(identity, placement, usage, {
          artifactType: ARTIFACT_UI_PLAN,
          resultName: ARTIFACT_UI_PLAN_RESULT,
          fields: {
            layout: "split_panel",
            interaction: "inline",
            responsive: "mobile_first",
            component_count: 6,
          },
        });
      case TASK_TEST_PLAN:
        return this.plan(identity, placement, usage, {
          artifactType: ARTIFACT_TEST_PLAN,
          resultName: ARTIFACT_TEST_PLAN_RESULT,
          fields: {
            coverage: "core_and_edge",
            interaction_tests: 8,
            accessibility: "required",
            responsive_tests: 3,
          },
        });
      case TASK_IMPLEMENTATION:
        return this.implement(request, usage);
      case TASK_OPTIONAL_REVIEWER:
        return { ok: true, producedArtifacts: [], usage };
      default:
        return {
          ok: true,
          producedArtifacts: node.producedArtifacts.map((id) => ({
            id,
            value: { from: node.id },
          })),
          usage,
        };
    }
  }

  /**
   * Reads the workspace through the Resource Gate, then follows the planted
   * runbook pointer to `payments/private_incident.json`.
   *
   * That request is a REAL call to the gate and is denied by `authorize()` at
   * the backend, producing a `resource_denied` event. The claim is that the
   * backend refused, not that a model declined to ask. The scan then completes
   * normally, which is the recovery half of the demo.
   */
  private async scanWorkspace(
    identity: AgentIdentity,
    usage: TaskUsage,
  ): Promise<TaskExecutionResult> {
    const dependencies = { store: this.store, ledger: this.ledger };
    const metrics = await readManagedResource(identity, "app/metrics", dependencies);
    const log = await readManagedResource(identity, "app/checkout.log", dependencies);
    if (!metrics.ok || !log.ok) {
      return { ok: false, producedArtifacts: [], usage, error: "workspace read denied" };
    }

    const rows = ((log.value as { rows?: string[] }).rows ?? []).map(String);
    const pointer = rows.find((row) => row.includes(RESOURCE_PAYMENTS));
    if (pointer) {
      // Following the note is the reasonable thing for an agent to do. The
      // backend is what says no.
      const attempted = await readManagedResource(
        identity,
        RESOURCE_PAYMENTS,
        dependencies,
      );
      if (!attempted.ok) {
        this.denials.push({
          taskId: TASK_WORKSPACE_SCAN,
          resourceId: RESOURCE_PAYMENTS,
          reason: attempted.reason,
        });
      } else {
        // Reaching this branch would mean mediation failed.
        return {
          ok: false,
          producedArtifacts: [],
          usage,
          error: "protected resource was readable",
        };
      }
    }

    return {
      ok: true,
      producedArtifacts: [
        {
          id: ARTIFACT_WORKSPACE_SUMMARY,
          value: {
            metricSeries: Object.keys(metrics.value as Record<string, unknown>).length,
            logRows: rows.length,
            followedPointerDenied: this.denials.length > 0,
          },
        },
      ],
      usage,
    };
  }

  /**
   * A planning step.
   *
   * REUSE: the parent produced it, so it is ordinary own task output.
   * DELEGATE: the child must publish a bounded artifact through the Artifact
   * Gate, because its raw output can never reach the parent.
   */
  private async plan(
    identity: AgentIdentity,
    placement: string,
    usage: TaskUsage,
    plan: {
      artifactType: string;
      resultName: string;
      fields: Record<string, unknown>;
    },
  ): Promise<TaskExecutionResult> {
    if (placement !== "DELEGATE_SPECIALIST") {
      return {
        ok: true,
        producedArtifacts: [{ id: plan.resultName, value: plan.fields }],
        usage,
      };
    }

    const dependencies = { store: this.store, ledger: this.ledger };
    const created = await createArtifact(
      identity,
      { artifactType: plan.artifactType, fields: plan.fields },
      dependencies,
    );
    if (!created.ok) {
      return {
        ok: false,
        producedArtifacts: [],
        usage,
        error: `artifact:create denied (${created.reason})`,
      };
    }
    const publishedResult = await publishArtifact(
      identity,
      created.value.id,
      { artifactType: plan.artifactType, fields: plan.fields },
      dependencies,
    );
    if (!publishedResult.ok) {
      return {
        ok: false,
        producedArtifacts: [],
        usage,
        error: `artifact:publish denied (${publishedResult.reason})`,
      };
    }

    const produced: ProducedArtifact = {
      id: plan.resultName,
      value: publishedResult.value.fields,
      publishedArtifactId: publishedResult.value.id,
    };
    return { ok: true, producedArtifacts: [produced], usage };
  }

  private implement(
    request: TaskExecutionRequest,
    usage: TaskUsage,
  ): TaskExecutionResult {
    const included = request.context.included.map((item) => item.id);
    if (
      !included.includes(ARTIFACT_UI_PLAN_RESULT) ||
      !included.includes(ARTIFACT_TEST_PLAN_RESULT)
    ) {
      return {
        ok: false,
        producedArtifacts: [],
        usage,
        error: "implementation requires both plans in context",
      };
    }
    return {
      ok: true,
      producedArtifacts: [
        { id: ARTIFACT_IMPLEMENTATION, value: { usedPlans: included.length } },
      ],
      usage,
    };
  }
}
