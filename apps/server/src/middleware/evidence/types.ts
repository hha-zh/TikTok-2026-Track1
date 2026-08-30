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
  | "grant_revoked";

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
