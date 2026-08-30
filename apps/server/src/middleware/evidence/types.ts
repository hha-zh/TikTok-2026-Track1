import type {
  Principal,
  ReasonCode,
} from "../governance/types.js";

export type GovernanceEventKind =
  | "delegation_requested"
  | "authority_evaluated"
  | "grant_created"
  | "principal_created"
  | "resource_allowed"
  | "resource_denied"
  | "tool_allowed"
  | "tool_denied"
  | "artifact_created"
  | "artifact_published"
  | "artifact_rejected"
  | "tokens_consumed"
  | "grant_revoked"
  // --- Adaptive Runtime evidence -------------------------------------------
  // Runtime facts, NOT authorization verdicts. authorize() remains the only
  // source of security ALLOW/DENY; nothing below decides anything.
  | "task_ready"
  | "task_deferred"
  | "routing_decision"
  | "invocation_started"
  | "context_projected"
  | "task_completed"
  | "task_failed"
  | "task_skipped"
  | "runtime_degraded"
  | "run_outcome";

export interface GovernanceEventPayloadMap {
  delegation_requested: {
    parentGrantId: string;
    requestedResources: string[];
    requestedActions: string[];
  };
  authority_evaluated: {
    verdict: "ALLOW" | "DENY";
    reason: ReasonCode;
  };
  grant_created: {
    parentGrantId?: string;
    depth: number;
  };
  principal_created: {
    kind: Principal["kind"];
    parentPrincipalId?: string;
  };
  resource_allowed: {
    resourceId: string;
    action: string;
  };
  resource_denied: {
    resourceId: string;
    action: string;
    reason: ReasonCode;
  };
  tool_allowed: {
    toolName: string;
  };
  tool_denied: {
    toolName: string;
    reason: ReasonCode;
  };
  artifact_created: {
    artifactId: string;
    artifactType: string;
  };
  artifact_published: {
    artifactId: string;
    recipientCount: number;
  };
  artifact_rejected: {
    artifactId?: string;
    artifactType: string;
    reason: ReasonCode;
  };
  tokens_consumed: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  grant_revoked: {
    reason: ReasonCode;
  };

  // --- Adaptive Runtime evidence -------------------------------------------
  //
  // Deliberately absent from every payload below: raw prompts, raw protected
  // contents, raw child output, provider credentials and model tokens. These
  // record WHAT the runtime decided and WHICH artifacts moved, never their
  // contents.

  task_ready: { taskId: string };
  task_deferred: { taskId: string; deferCount: number; note: string };
  routing_decision: {
    taskId: string;
    disposition: string;
    placement: string | null;
    /** Author-declared hints, echoed for the Inspector. Never measured. */
    declaredUtilityGain: number | null;
    declaredIncrementalCost: number | null;
    delegationValue: number | null;
    delegationThreshold: number | null;
    shape: string;
    wave: number | null;
  };
  invocation_started: {
    invocationId: string;
    taskId: string;
    executorPrincipalId: string;
    sourceGrantId: string;
    /** Narrowed scope summary: the ids, never the resource bodies. */
    effectiveResources: string[];
    effectiveActions: string[];
  };
  context_projected: {
    invocationId: string;
    taskId: string;
    /** Artifact NAMES only. Values never reach the ledger. */
    includedArtifactIds: string[];
    withheldArtifactIds: { id: string; reason: string }[];
  };
  task_completed: { taskId: string; invocationId: string; placement: string };
  task_failed: { taskId: string; reason: string };
  task_skipped: { taskId: string; reason: string };
  runtime_degraded: { taskId: string; from: string; to: string; note: string };
  run_outcome: {
    outcome: string;
    completed: number;
    skipped: number;
    failed: number;
    rounds: number;
  };
}

export interface GovernanceEvent<
  K extends GovernanceEventKind = GovernanceEventKind,
> {
  seq: number;
  ts: string;
  runId: string;
  grantId: string;
  principalId: string;
  kind: K;
  payload: GovernanceEventPayloadMap[K];
}
