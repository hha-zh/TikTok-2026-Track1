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
    /** Correlates this decision with the invocation and outcome it produced. */
    decisionId: string;
    taskId: string;
    disposition: string;
    placement: string | null;
    shape: string;
    wave: number | null;
    /** DECLARED hints, echoed for later explanation. Never measured. */
    declaredUtilityGain: number | null;
    declaredIncrementalCost: number | null;
    declaredIsolationPreference: string | null;
    /** DECLARED estimate for the task, weighed against every placement. */
    estimatedTokens: number | null;
    /** DECLARED/STRUCTURAL. Zero unless isolation genuinely applies. */
    authorityIsolationGain: number | null;
    /** DERIVED. Intrinsic: does not vary with remaining budget. */
    delegationValue: number | null;
    /** DERIVED. Rises with run pressure. */
    delegationThreshold: number | null;
    /**
     * Runtime state at the moment of the decision, recorded ONCE rather than
     * repeated per candidate. OBSERVED/DERIVED from ledger projections.
     */
    budget: {
      effectiveTokensRemaining: number;
      runTokensRemaining: number;
      runPressure: number;
      childSlotsRemaining: number;
      depthRemaining: number;
      parallelCapacity: number;
    };
    /**
     * The EXACT candidates that were ranked - one snapshot, built once and
     * shared by the router and this record, so evidence cannot describe a
     * different set from the one that decided.
     *
     * Resource and action IDS only; no values, prompts or content.
     */
    candidates: {
      placement: string;
      authorityLegal: boolean;
      /** The untouched hard ReasonCode. */
      authorityReason: string;
      /** DERIVED explanation. Never a verdict. */
      constraintAxis: string;
      /** Hard-permitted with real capacity; no declared estimate involved. */
      hardEligible: boolean;
      /** Whether the DECLARED estimate fits. */
      planningFit: string;
      budgetReason: string;
      structurallyNarrower: boolean;
      routableNow: boolean;
      effectiveResources: string[];
      effectiveActions: string[];
    }[];
  };
  invocation_started: {
    /** Same id as the routing_decision this invocation came from. */
    decisionId: string | null;
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
