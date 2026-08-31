export interface Principal {
  id: string;
  kind: "human" | "agent";
  ownerId?: string;
  parentPrincipalId?: string;
}

export interface Envelope {
  id: string;
  principalId: string;
  exercisable: {
    resources: string[];
    actions: string[];
  };
  delegatable: {
    resources: string[];
    actions: string[];
  };
  depth: number;
  maxTokens: number;
  maxToolCalls: number;
  maxChildren: number;
  runId: string;
  parentGrantId?: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface RunState {
  runId: string;
  // Independent shared run cap; Envelope.maxTokens remains the per-grant cap.
  maxTokens: number;
  tokensUsed: number;
  /** Durable, domain-neutral key used by application composition to resolve safe UI metadata. */
  workloadDescriptor?: {
    workloadId: string;
    descriptorVersion: string;
  };
}

export interface GrantState {
  grantId: string;
  revoked: boolean;
  tokensUsed: number;
  childCount: number;
}

export interface GovernanceState {
  envelope: Envelope;
  ancestry: Array<{
    grantId: string;
    revoked: boolean;
    expired: boolean;
  }>;
  grantState: GrantState;
  runState: RunState;
  now: string;
}

export type ReasonCode =
  | "AUTHORIZED"
  | "INVALID_TOKEN"
  | "PRINCIPAL_NOT_FOUND"
  | "GRANT_NOT_FOUND"
  | "PARENT_GRANT_REVOKED"
  | "PARENT_GRANT_EXPIRED"
  | "RESOURCE_NOT_GRANTED"
  | "NOT_EXERCISABLE_DELEGATE_ONLY"
  | "ACTION_NOT_GRANTED"
  | "BUDGET_EXCEEDED"
  | "DELEGATION_CEILING_REACHED"
  | "MAX_CHILDREN_EXCEEDED"
  | "CHILD_EXCEEDS_PARENT"
  | "ARTIFACT_TYPE_NOT_GRANTED"
  | "ARTIFACT_SCHEMA_VIOLATION"
  | "ARTIFACT_NOT_PUBLISHED"
  | "ARTIFACT_NOT_RECIPIENT"
  | "MALFORMED_INPUT";

export interface Decision {
  verdict: "ALLOW" | "DENY";
  reason: ReasonCode;
  detail?: string;
}

export interface ChildHandle {
  childPrincipalId: string;
  childAgentId: string;
  grantId: string;
  status: string;
}

export interface MockResource {
  id: string;
  ownerId: string;
  domain: string;
  body: unknown;
}

export interface Artifact {
  id: string;
  ownerPrincipalId: string;
  type: string;
  fields: Record<string, unknown>;
  published: boolean;
  recipients: string[];
}

export interface ArtifactSchema {
  artifactType: string;
  version: number;
  maxFieldCount: number;
  maxSerializedBytes: number;
  allowedFieldNames: string[];
}
