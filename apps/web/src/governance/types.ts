export type EvidenceQuality = "OBSERVED" | "DECLARED" | "DERIVED" | "UNAVAILABLE";

export interface QualifiedEvidence<T> {
  value: T | null;
  quality: EvidenceQuality;
  source: "WORKLOAD_DESCRIPTOR" | "LEDGER" | "NONE";
}

export interface GovernanceEvent {
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
  reasonCode?: string;
  artifactId?: string;
  artifactType?: string;
}

export interface GovernedTask {
  taskId: string;
  status: string;
  statusQuality: "DERIVED";
  label: QualifiedEvidence<string>;
  required: QualifiedEvidence<boolean>;
  dependencies: QualifiedEvidence<{ tasks: string[]; artifacts: string[] }>;
  producedArtifacts: QualifiedEvidence<Array<{ id: string; type: string | null }>>;
  executionProvenance: { value: string | null; quality: EvidenceQuality };
}

export interface RoutingDecision {
  decisionId: string;
  sequence: number;
  timestamp: string;
  taskId: string;
  who: string | null;
  how: string;
  disposition: string;
  wave: number | null;
  explanation: { value: null; quality: "UNAVAILABLE" };
  candidates: Array<{
    who: string;
    constraintAxis: string;
    hardEligible: boolean;
    planningFit: string;
    routableNow: boolean;
    structurallyNarrower: boolean;
    authorityReason: string;
  }>;
  horizon: {
    effectiveTokensRemaining: number;
    runTokensRemaining: number;
    runPressure: number;
    childSlotsRemaining: number;
    depthRemaining: number;
    parallelCapacity: number;
    quality: "OBSERVED";
  };
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
  tasks: GovernedTask[];
  routingDecisions: RoutingDecision[];
  authority: {
    dimensions: "PARALLEL_WITH_BUDGET_HORIZON";
    root: {
      exercisable: { resources: string[]; actions: string[] };
      delegatable: { resources: string[]; actions: string[] };
    };
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
    sequence: number;
    taskId: string;
    invocationId: string;
    includedArtifactIds: string[];
    withheld: Array<{ id: string; reason: string }>;
  }>;
  artifacts: Array<{
    artifactId: string;
    type: string;
    ownerPrincipalId: string;
    taskId: string | null;
    lifecycle: { created: boolean; published: boolean; recipients: string[] };
    boundedFields: Record<string, unknown>;
  }>;
  governanceEvents: GovernanceEvent[];
  usageFeedback: {
    provenance: { value: string | null; quality: EvidenceQuality };
    deltas: Array<{ sequence: number; principalId: string; grantId: string; totalTokens: number }>;
    projectedRunTokensUsed: number;
    laterDecisionsReferenceProjectedState: { value: boolean; quality: "DERIVED" };
  };
  outcome: {
    runtime: { status: string; completedTasks: number; failedTasks: number; quality: "DERIVED"; source: "LEDGER" };
    domain: QualifiedEvidence<{ summary: Record<string, unknown>; oracle: Record<string, boolean> }> | null;
    governanceOracle: QualifiedEvidence<Record<string, boolean>> | null;
    adaptiveOracle: QualifiedEvidence<Record<string, boolean>> | null;
    lifecycleOracle: QualifiedEvidence<Record<string, boolean>> | null;
  };
}
