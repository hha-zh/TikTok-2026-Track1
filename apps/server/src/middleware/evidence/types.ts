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
    /** DECLARED hints, echoed for later explanation. Never measured. */
    declaredUtilityGain: number | null;
    declaredIncrementalCost: number | null;
    declaredIsolationPreference: string | null;
    /** DECLARED/STRUCTURAL. Zero unless isolation genuinely applies. */
    authorityIsolationGain: number | null;
    /** DERIVED. */
    delegationValue: number | null;
    delegationThreshold: number | null;
    runPressure: number | null;
    shape: string;
    wave: number | null;
    /**
     * Both axes for both placements.
     *
     * Enough that one routing decision can later be explained without
     * reconstructing it from unrelated events - and specifically enough to
     * distinguish "authorized but unaffordable" from "not authorized".
     * Resource and action IDS only; no values, no prompts, no content.
     */
    candidates: {
      placement: string;
      authorityLegal: boolean;
      authorityReason: string;
      budgetAffordable: boolean;
      budgetReason: string;
      structurallyNarrower: boolean;
      feasible: boolean;
      effectiveResources: string[];
      effectiveActions: string[];
      estimatedTokens: number;
      effectiveTokensRemaining: number;
      childSlotsRemaining: number;
      depthRemaining: number;
    }[];
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
