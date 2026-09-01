import type { TaskGraph, TaskSpec } from "../adaptive/task-graph.js";
import type { ReasonCode } from "../governance/types.js";
import type { JsonStore } from "../../store.js";

export type EvidenceQuality = "OBSERVED" | "DECLARED" | "DERIVED" | "UNAVAILABLE";

/**
 * Any field the Ledger did not observe. `DECLARED` values are authored workload
 * contract supplied by the caller's descriptor; they are never runtime truth.
 * `UNAVAILABLE` means the backend has nothing to say — a UI must render it as
 * unknown, never as a default. This exists because the descriptor-less
 * production path previously synthesized task nodes from bare event taskIds and
 * emitted invented `required` / `dependencies` / `producedArtifacts` defaults
 * in the same unlabelled shape as ledger-derived fields.
 */
export interface QualifiedEvidence<T> {
  value: T | null;
  quality: EvidenceQuality;
  source: "WORKLOAD_DESCRIPTOR" | "LEDGER" | "NONE";
}

export interface GovernedRunDescriptor {
  workload: { id: string; scenario: string; graph: TaskGraph };
  domain?: { summary: Record<string, unknown>; oracle?: Record<string, boolean> };
  governanceOracle?: Record<string, boolean>;
  adaptiveOracle?: Record<string, boolean>;
  lifecycleOracle?: Record<string, boolean>;
  executionProvenance?: string;
}

export interface SafeGovernanceEventView {
  eventId: string;
  sequence: number;
  timestamp: string;
  category: "ALLOW" | "DENY" | "DELEGATE" | "RETURN" | "USAGE" | "ADAPT" | "COMPLETE" | "REVOKE" | "LIFECYCLE";
  kind: string;
  principalId: string;
  grantId: string;
  taskId?: string;
  decisionId?: string;
  action?: string;
  resourceId?: string;
  verdict?: "ALLOW" | "DENY";
  reasonCode?: ReasonCode;
  artifactId?: string;
  artifactType?: string;
  usageDelta?: { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
}

export interface GovernedRunView {
  contractVersion: "1";
  run: {
    runId: string;
    workload: { id: string; scenario: string; quality: "DECLARED" } | null;
    status: string;
    createdAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    root: { principalId: string; grantId: string; kind: "runtime_agent" };
  };
  tasks: Array<{
    /** OBSERVED: the taskId appeared in a ledger event for this run. */
    taskId: string;
    /** DERIVED: computed from ordered task lifecycle events. */
    status: string;
    statusQuality: "DERIVED";
    label: QualifiedEvidence<string>;
    required: QualifiedEvidence<boolean>;
    dependencies: QualifiedEvidence<{ tasks: string[]; artifacts: string[] }>;
    producedArtifacts: QualifiedEvidence<Array<{ id: string; type: string | null }>>;
    executionProvenance: { value: string | null; quality: EvidenceQuality };
  }>;
  routingDecisions: Array<{
    decisionId: string; sequence: number; timestamp: string; taskId: string;
    who: string | null; how: string; disposition: string; wave: number | null;
    explanation: { value: null; quality: "UNAVAILABLE" };
    candidates: Array<{
      who: string; constraintAxis: string; hardEligible: boolean;
      planningFit: string; routableNow: boolean; structurallyNarrower: boolean;
      authorityReason: string;
    }>;
    horizon: {
      effectiveTokensRemaining: number; runTokensRemaining: number; runPressure: number;
      childSlotsRemaining: number; depthRemaining: number; parallelCapacity: number;
      quality: "OBSERVED";
    };
  }>;
  authority: {
    dimensions: "PARALLEL_WITH_BUDGET_HORIZON";
    root: { exercisable: { resources: string[]; actions: string[] }; delegatable: { resources: string[]; actions: string[] } };
  };
  runtimeState: {
    budgetHorizon: {
      runTokens: { used: number; cap: number; remaining: number };
      rootGrantTokens: { used: number; cap: number; remaining: number };
      children: { used: number; cap: number };
      depth: number;
      maxToolCalls: { configured: number; enforced: false };
    };
  };
  delegations: Array<{
    taskId: string | null;
    parent: { principalId: string; grantId: string };
    child: { principalId: string; grantId: string; kind: "runtime_delegated_agent"; lifecycle: "ACTIVE" | "REVOKED" };
    attenuation: {
      retained: { resources: string[]; actions: string[]; maxChildren: number; depth: number };
      removed: { resources: string[]; actions: string[]; childDelegation: boolean };
    };
  }>;
  contextProjections: Array<{
    sequence: number; taskId: string; invocationId: string;
    includedArtifactIds: string[]; withheld: Array<{ id: string; reason: string }>;
  }>;
  artifacts: Array<{
    artifactId: string; type: string; ownerPrincipalId: string; taskId: string | null;
    lifecycle: { created: boolean; published: boolean; recipients: string[] };
    boundedFields: Record<string, unknown>;
  }>;
  finalResult: {
    type: string;
    quality: "OBSERVED";
    boundedFields: Record<string, unknown>;
  } | null;
  governanceEvents: SafeGovernanceEventView[];
  usageFeedback: {
    provenance: { value: string | null; quality: EvidenceQuality };
    deltas: Array<{ sequence: number; principalId: string; grantId: string; totalTokens: number }>;
    projectedRunTokensUsed: number;
    /** DERIVED from event ordering and agreement between every post-usage
     *  decision budget snapshot and cumulative prior recorded usage. */
    laterDecisionsReferenceProjectedState: { value: boolean; quality: "DERIVED" };
  };
  outcome: {
    /** DERIVED from the run_outcome ledger event. */
    runtime: { status: string; completedTasks: number; failedTasks: number; quality: "DERIVED"; source: "LEDGER" };
    /** DECLARED by the workload. These are the run's verdict on ITSELF and are
     *  not ledger evidence; a UI must not present them as observed facts. */
    domain: QualifiedEvidence<{ summary: Record<string, unknown>; oracle: Record<string, boolean> }> | null;
    governanceOracle: QualifiedEvidence<Record<string, boolean>> | null;
    adaptiveOracle: QualifiedEvidence<Record<string, boolean>> | null;
    lifecycleOracle: QualifiedEvidence<Record<string, boolean>> | null;
  };
}

const category = (kind: string, payload: Record<string, unknown>): SafeGovernanceEventView["category"] => {
  if (kind === "resource_allowed" || kind === "tool_allowed" || (kind === "authority_evaluated" && payload.verdict === "ALLOW")) return "ALLOW";
  if (kind === "resource_denied" || kind === "tool_denied" || kind === "artifact_rejected" || (kind === "authority_evaluated" && payload.verdict === "DENY")) return "DENY";
  if (kind === "delegation_requested" || kind === "grant_created" || kind === "principal_created") return "DELEGATE";
  if (kind === "artifact_created" || kind === "artifact_published") return "RETURN";
  if (kind === "tokens_consumed") return "USAGE";
  if (kind === "routing_decision" || kind === "runtime_degraded") return "ADAPT";
  if (kind === "task_completed" || kind === "run_outcome") return "COMPLETE";
  if (kind === "grant_revoked") return "REVOKE";
  return "LIFECYCLE";
};

export function buildGovernedRunView(store: JsonStore, runId: string, descriptor?: GovernedRunDescriptor): GovernedRunView | null {
  const database = store.snapshot();
  const events = database.governanceEvents.filter((event) => event.runId === runId).sort((a, b) => a.seq - b.seq);
  const envelopes = database.envelopes.filter((item) => item.runId === runId);
  const rootEnvelope = envelopes.find((item) => item.parentGrantId === undefined);
  const runState = database.runStates.find((item) => item.runId === runId);
  if (!rootEnvelope || !runState || events.length === 0) return null;
  const rootPrincipal = database.principals.find((item) => item.id === rootEnvelope.principalId);
  if (!rootPrincipal) return null;
  const rootGrantState = database.grantStates.find((item) => item.grantId === rootEnvelope.id);
  const completed = new Set(events.filter((event) => event.kind === "task_completed").map((event) => (event.payload as { taskId: string }).taskId));
  const failed = new Set(events.filter((event) => event.kind === "task_failed").map((event) => (event.payload as { taskId: string }).taskId));
  const skipped = new Set(events.filter((event) => event.kind === "task_skipped").map((event) => (event.payload as { taskId: string }).taskId));
  const ready = new Set(events.filter((event) => event.kind === "task_ready").map((event) => (event.payload as { taskId: string }).taskId));
  const taskIds = [...new Set(events.flatMap((event) => "taskId" in event.payload ? [(event.payload as { taskId: string }).taskId] : []))];
  const nodes: TaskSpec[] = descriptor?.workload.graph.nodes ?? taskIds.map((id) => ({
    id, description: id, resources: [], actions: [], dependsOn: [], requiredArtifacts: [], producedArtifacts: [], estimatedTokens: 0,
  }));
  const artifactType = (node: typeof nodes[number], id: string) => node.producedArtifactTypes?.[id] ?? null;
  // Graph shape is authored workload contract, never observed runtime truth.
  // Without a descriptor the backend has NOTHING to say about it, so it must
  // say exactly that rather than emit a synthesized default.
  const hasDescriptor = descriptor !== undefined;
  const fromDescriptor = <T>(compute: () => T): QualifiedEvidence<T> => hasDescriptor
    ? { value: compute(), quality: "DECLARED", source: "WORKLOAD_DESCRIPTOR" }
    : { value: null, quality: "UNAVAILABLE", source: "NONE" };
  const routing = events.filter((event) => event.kind === "routing_decision");
  const invocations = events.filter((event) => event.kind === "invocation_started");
  const delegatedGrantIds = new Set(
    envelopes.filter((envelope) => envelope.parentGrantId !== undefined).map((envelope) => envelope.id),
  );
  const taskByInvocationGrant = new Map<string, string | null>();
  for (const invocation of invocations) {
    const payload = invocation.payload as { sourceGrantId: string; taskId: string };
    if (!delegatedGrantIds.has(payload.sourceGrantId)) continue;
    const existing = taskByInvocationGrant.get(payload.sourceGrantId);
    taskByInvocationGrant.set(
      payload.sourceGrantId,
      existing === undefined || existing === payload.taskId ? payload.taskId : null,
    );
  }
  const safeEvents: SafeGovernanceEventView[] = events.map((event) => {
    const payload = event.payload as Record<string, unknown>;
    const correlatedTaskId = typeof payload.taskId === "string"
      ? payload.taskId
      : taskByInvocationGrant.get(event.grantId) ?? undefined;
    const artifactId = typeof payload.artifactId === "string" ? payload.artifactId : undefined;
    const artifact = artifactId ? database.artifacts.find((item) => item.id === artifactId) : undefined;
    return {
      eventId: `${runId}:${event.seq}`, sequence: event.seq, timestamp: event.ts,
      category: category(event.kind, payload), kind: event.kind,
      principalId: event.principalId, grantId: event.grantId,
      ...(correlatedTaskId ? { taskId: correlatedTaskId } : {}),
      ...(typeof payload.decisionId === "string" ? { decisionId: payload.decisionId } : {}),
      ...(typeof payload.action === "string" ? { action: payload.action } : {}),
      ...(typeof payload.resourceId === "string" ? { resourceId: payload.resourceId } : {}),
      ...(payload.verdict === "ALLOW" || payload.verdict === "DENY" ? { verdict: payload.verdict } : {}),
      ...(event.kind === "resource_allowed" ? { verdict: "ALLOW" as const } : {}),
      ...(event.kind === "resource_denied" ? { verdict: "DENY" as const } : {}),
      ...(typeof payload.reason === "string" ? { reasonCode: payload.reason as ReasonCode } : {}),
      ...(artifactId ? { artifactId } : {}),
      ...(typeof payload.artifactType === "string" ? { artifactType: payload.artifactType } : artifact ? { artifactType: artifact.type } : {}),
      ...(event.kind === "tokens_consumed" ? { usageDelta: {
        totalTokens: payload.totalTokens as number, inputTokens: payload.inputTokens as number,
        cachedInputTokens: payload.cachedInputTokens as number, outputTokens: payload.outputTokens as number,
      } } : {}),
    };
  });
  const createdIds = new Set(events.filter((event) => event.kind === "artifact_created").map((event) => (event.payload as { artifactId: string }).artifactId));
  const publishedIds = new Set(events.filter((event) => event.kind === "artifact_published").map((event) => (event.payload as { artifactId: string }).artifactId));
  const visibleArtifacts = database.artifacts.filter((artifact) => artifact.published && artifact.recipients.includes(rootPrincipal.id)
    && (createdIds.has(artifact.id) || publishedIds.has(artifact.id)));
  const outcomeEvent = [...events].reverse().find((event) => event.kind === "run_outcome");
  const outcomePayload = outcomeEvent?.payload as undefined | { outcome: string; completed: number; failed: number };
  const firstTs = events[0]?.ts ?? null;
  const lastTs = outcomeEvent?.ts ?? null;
  const usage = events.filter((event) => event.kind === "tokens_consumed");
  const decisionsAfterUsage = routing.filter((decision) =>
    usage.some((event) => event.seq < decision.seq));
  const laterDecisionsReferenceProjectedState = decisionsAfterUsage.length > 0
    && decisionsAfterUsage.every((decision) => {
    const priorUsage = usage.filter((event) => event.seq < decision.seq);
    const projectedTokensUsed = priorUsage.reduce(
      (sum, event) => sum + (event.payload as { totalTokens: number }).totalTokens,
      0,
    );
    const payload = decision.payload as { budget?: { runTokensRemaining?: number } };
    return payload.budget?.runTokensRemaining
      === Math.max(0, runState.maxTokens - projectedTokensUsed);
    });
  return {
    contractVersion: "1",
    run: {
      runId, workload: descriptor ? {
        id: descriptor.workload.id,
        scenario: descriptor.workload.scenario,
        quality: "DECLARED",
      } : null,
      status: outcomePayload?.outcome ?? "RUNNING", createdAt: rootEnvelope.createdAt,
      startedAt: firstTs, completedAt: lastTs,
      durationMs: firstTs && lastTs ? Math.max(0, Date.parse(lastTs) - Date.parse(firstTs)) : null,
      root: { principalId: rootPrincipal.id, grantId: rootEnvelope.id, kind: "runtime_agent" },
    },
    tasks: nodes.map((node) => ({
      taskId: node.id,
      status: completed.has(node.id) ? "COMPLETED" : failed.has(node.id) ? "FAILED" : skipped.has(node.id) ? "SKIPPED" : ready.has(node.id) ? "READY" : "PENDING",
      statusQuality: "DERIVED",
      label: fromDescriptor(() => node.description),
      required: fromDescriptor(() => !node.optional),
      dependencies: fromDescriptor(() => ({ tasks: [...node.dependsOn], artifacts: [...node.requiredArtifacts] })),
      producedArtifacts: fromDescriptor(() => node.producedArtifacts.map((id) => ({ id, type: artifactType(node, id) }))),
      executionProvenance: descriptor?.executionProvenance
        ? { value: descriptor.executionProvenance, quality: "DECLARED" }
        : { value: null, quality: "UNAVAILABLE" },
    })),
    routingDecisions: routing.map((event) => {
      const payload = event.payload as Extract<typeof event.payload, { taskId: string }> & Record<string, any>;
      return {
        decisionId: payload.decisionId, sequence: event.seq, timestamp: event.ts, taskId: payload.taskId,
        who: payload.placement, how: payload.shape, disposition: payload.disposition, wave: payload.wave,
        explanation: { value: null, quality: "UNAVAILABLE" },
        candidates: payload.candidates.map((candidate: Record<string, any>) => ({
          who: candidate.placement, constraintAxis: candidate.constraintAxis,
          hardEligible: candidate.hardEligible, planningFit: candidate.planningFit,
          routableNow: candidate.routableNow, structurallyNarrower: candidate.structurallyNarrower,
          authorityReason: candidate.authorityReason,
        })),
        horizon: { ...payload.budget, quality: "OBSERVED" },
      };
    }),
    authority: { dimensions: "PARALLEL_WITH_BUDGET_HORIZON", root: {
      exercisable: structuredClone(rootEnvelope.exercisable), delegatable: structuredClone(rootEnvelope.delegatable),
    } },
    runtimeState: { budgetHorizon: {
      runTokens: { used: runState.tokensUsed, cap: runState.maxTokens, remaining: Math.max(0, runState.maxTokens - runState.tokensUsed) },
      rootGrantTokens: { used: rootGrantState?.tokensUsed ?? 0, cap: rootEnvelope.maxTokens, remaining: Math.max(0, rootEnvelope.maxTokens - (rootGrantState?.tokensUsed ?? 0)) },
      children: { used: rootGrantState?.childCount ?? 0, cap: rootEnvelope.maxChildren }, depth: rootEnvelope.depth,
      maxToolCalls: { configured: rootEnvelope.maxToolCalls, enforced: false },
    } },
    delegations: envelopes.filter((item) => item.parentGrantId).map((child) => {
      const parent = envelopes.find((item) => item.id === child.parentGrantId)!;
      const invocation = invocations.find((event) => (event.payload as { sourceGrantId: string }).sourceGrantId === child.id);
      const taskId = invocation ? (invocation.payload as { taskId: string }).taskId : null;
      const state = database.grantStates.find((item) => item.grantId === child.id);
      return {
        taskId, parent: { principalId: parent.principalId, grantId: parent.id },
        child: { principalId: child.principalId, grantId: child.id, kind: "runtime_delegated_agent" as const, lifecycle: state?.revoked ? "REVOKED" as const : "ACTIVE" as const },
        attenuation: {
          retained: { resources: [...child.exercisable.resources], actions: [...child.exercisable.actions], maxChildren: child.maxChildren, depth: child.depth },
          removed: {
            resources: parent.delegatable.resources.filter((item) => !child.exercisable.resources.includes(item)),
            actions: parent.delegatable.actions.filter((item) => !child.exercisable.actions.includes(item)),
            childDelegation: child.maxChildren === 0 && child.depth === 0,
          },
        },
      };
    }),
    contextProjections: events.filter((event) => event.kind === "context_projected").map((event) => {
      const payload = event.payload as { taskId: string; invocationId: string; includedArtifactIds: string[]; withheldArtifactIds: Array<{ id: string; reason: string }> };
      return { sequence: event.seq, taskId: payload.taskId, invocationId: payload.invocationId,
        includedArtifactIds: [...payload.includedArtifactIds], withheld: structuredClone(payload.withheldArtifactIds) };
    }),
    artifacts: visibleArtifacts.map((artifact) => ({
      artifactId: artifact.id, type: artifact.type, ownerPrincipalId: artifact.ownerPrincipalId,
      taskId: (() => {
        const artifactEvents = events.filter((event) =>
          (event.kind === "artifact_created" || event.kind === "artifact_published")
          && (event.payload as { artifactId: string }).artifactId === artifact.id);
        const taskIds = new Set(artifactEvents.flatMap((event) => {
          const taskId = taskByInvocationGrant.get(event.grantId);
          return taskId ? [taskId] : [];
        }));
        return taskIds.size === 1 ? [...taskIds][0]! : null;
      })(),
      lifecycle: { created: createdIds.has(artifact.id), published: publishedIds.has(artifact.id), recipients: [...artifact.recipients] },
      boundedFields: structuredClone(artifact.fields),
    })),
    finalResult: runState.finalResult ? structuredClone(runState.finalResult) : null,
    governanceEvents: safeEvents,
    usageFeedback: {
      provenance: descriptor?.executionProvenance ? { value: descriptor.executionProvenance, quality: "DECLARED" } : { value: null, quality: "UNAVAILABLE" },
      deltas: usage.map((event) => ({ sequence: event.seq, principalId: event.principalId, grantId: event.grantId,
        totalTokens: (event.payload as { totalTokens: number }).totalTokens })),
      projectedRunTokensUsed: runState.tokensUsed,
      laterDecisionsReferenceProjectedState: {
        value: laterDecisionsReferenceProjectedState,
        quality: "DERIVED",
      },
    },
    outcome: {
      runtime: { status: outcomePayload?.outcome ?? "RUNNING", completedTasks: outcomePayload?.completed ?? completed.size,
        failedTasks: outcomePayload?.failed ?? failed.size, quality: "DERIVED", source: "LEDGER" },
      domain: descriptor?.domain
        ? { value: { summary: structuredClone(descriptor.domain.summary), oracle: structuredClone(descriptor.domain.oracle ?? {}) },
            quality: "DECLARED", source: "WORKLOAD_DESCRIPTOR" }
        : null,
      governanceOracle: descriptor?.governanceOracle
        ? { value: structuredClone(descriptor.governanceOracle), quality: "DECLARED", source: "WORKLOAD_DESCRIPTOR" } : null,
      adaptiveOracle: descriptor?.adaptiveOracle
        ? { value: structuredClone(descriptor.adaptiveOracle), quality: "DECLARED", source: "WORKLOAD_DESCRIPTOR" } : null,
      lifecycleOracle: descriptor?.lifecycleOracle
        ? { value: structuredClone(descriptor.lifecycleOracle), quality: "DECLARED", source: "WORKLOAD_DESCRIPTOR" } : null,
    },
  };
}
