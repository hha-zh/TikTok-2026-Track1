import { randomUUID } from "node:crypto";
import type { GovernanceLedger } from "../evidence/ledger.js";
import type { JsonStore } from "../../store.js";
import { authorize } from "./authorize.js";
import { resolveGrant } from "./grant-resolver.js";
import type { AuthenticatedIdentity } from "./identity.js";
import { isResourceScopeSubset } from "./scope.js";
import type {
  Decision,
  Envelope,
  GovernanceState,
  Principal,
  ReasonCode,
} from "./types.js";

const derivedEnvelopeBrand: unique symbol = Symbol("DerivedEnvelope");

export type DerivedEnvelope = Envelope & {
  readonly [derivedEnvelopeBrand]: true;
};

export interface ChildEnvelopeRequest {
  exercisable: { resources: string[]; actions: string[] };
  delegatable?: { resources: string[]; actions: string[] };
  maxTokens: number;
  maxToolCalls: number;
  maxChildren: number;
  expiresAt?: string;
}

export interface ChildEnvelopeConstruction {
  id: string;
  principalId: string;
  createdAt: string;
  maxTokensCeiling?: number;
}

export type DerivationResult =
  | { ok: true; envelope: DerivedEnvelope }
  | {
      ok: false;
      reason: Extract<
        ReasonCode,
        "CHILD_EXCEEDS_PARENT" | "DELEGATION_CEILING_REACHED" | "MALFORMED_INPUT"
      >;
    };

function validBound(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function actionsAreSubset(requested: readonly string[], parent: readonly string[]) {
  return requested.every((action) => parent.includes(action));
}

function resourcesAreSubset(requested: readonly string[], parent: readonly string[]) {
  return requested.every((scope) => isResourceScopeSubset(scope, parent));
}

function earlierExpiry(
  requested: string | undefined,
  parent: string | undefined,
): string | undefined | null {
  const requestedTime = requested === undefined ? null : Date.parse(requested);
  const parentTime = parent === undefined ? null : Date.parse(parent);
  if (
    (requestedTime !== null && !Number.isFinite(requestedTime)) ||
    (parentTime !== null && !Number.isFinite(parentTime))
  ) return null;
  if (requestedTime === null) return parent;
  if (parentTime === null) return requested;
  return requestedTime <= parentTime ? requested : parent;
}

export function deriveChildEnvelope(
  parent: Envelope,
  request: ChildEnvelopeRequest,
  construction: ChildEnvelopeConstruction,
): DerivationResult {
  if (parent.depth <= 0) return { ok: false, reason: "DELEGATION_CEILING_REACHED" };
  if (
    !construction.id ||
    !construction.principalId ||
    !Number.isFinite(Date.parse(construction.createdAt)) ||
    !validBound(request.maxTokens) ||
    !validBound(request.maxToolCalls) ||
    !validBound(request.maxChildren)
  ) {
    return { ok: false, reason: "MALFORMED_INPUT" };
  }

  const childDelegatable = request.delegatable ?? { resources: [], actions: [] };
  const setAuthorityValid =
    resourcesAreSubset(request.exercisable.resources, parent.delegatable.resources) &&
    actionsAreSubset(request.exercisable.actions, parent.delegatable.actions) &&
    resourcesAreSubset(childDelegatable.resources, parent.delegatable.resources) &&
    actionsAreSubset(childDelegatable.actions, parent.delegatable.actions) &&
    resourcesAreSubset(childDelegatable.resources, request.exercisable.resources) &&
    actionsAreSubset(childDelegatable.actions, request.exercisable.actions);
  if (!setAuthorityValid) return { ok: false, reason: "CHILD_EXCEEDS_PARENT" };

  const expiry = earlierExpiry(request.expiresAt, parent.expiresAt);
  if (expiry === null) return { ok: false, reason: "MALFORMED_INPUT" };
  const requestedCeiling = construction.maxTokensCeiling ?? parent.maxTokens;
  if (!Number.isFinite(requestedCeiling)) {
    return { ok: false, reason: "MALFORMED_INPUT" };
  }

  const envelope: Envelope = {
    id: construction.id,
    principalId: construction.principalId,
    exercisable: structuredClone(request.exercisable),
    delegatable: structuredClone(childDelegatable),
    depth: parent.depth - 1,
    maxTokens: Math.max(0, Math.min(request.maxTokens, parent.maxTokens, requestedCeiling)),
    maxToolCalls: Math.min(request.maxToolCalls, parent.maxToolCalls),
    maxChildren: Math.min(request.maxChildren, parent.maxChildren),
    runId: parent.runId,
    parentGrantId: parent.id,
    createdAt: construction.createdAt,
    ...(expiry === undefined ? {} : { expiresAt: expiry }),
  };
  return { ok: true, envelope: envelope as DerivedEnvelope };
}

type AgentIdentity = Extract<AuthenticatedIdentity, { kind: "agent" }>;

export interface DelegationGrant {
  childPrincipalId: string;
  grantId: string;
  status: "grant_created";
}

export type DelegationResult =
  | { ok: true; grant: DelegationGrant }
  | { ok: false; statusCode: 400 | 403; reason: ReasonCode };

export interface DelegationDependencies {
  store: JsonStore;
  ledger: GovernanceLedger;
  now?: () => string;
  id?: () => string;
}

export class DelegationService {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: DelegationDependencies) {}

  delegate(
    identity: AgentIdentity,
    request: ChildEnvelopeRequest,
  ): Promise<DelegationResult> {
    const operation = this.queue.then(() => this.delegateSerialized(identity, request));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async delegateSerialized(
    identity: AgentIdentity,
    request: ChildEnvelopeRequest,
  ): Promise<DelegationResult> {
    const now = this.dependencies.now?.() ?? new Date().toISOString();
    const resolution = resolveGrant(
      { principalId: identity.principalId, grantId: identity.grantId, runId: identity.runId },
      this.dependencies.store,
      now,
    );
    if (!resolution.ok) {
      return {
        ok: false,
        statusCode: resolution.reason === "MALFORMED_INPUT" ? 400 : 403,
        reason: resolution.reason,
      };
    }

    const capacity = authorize(identity.principal, "delegate", undefined, resolution.state);
    if (capacity.verdict === "DENY") {
      await this.appendEvaluation(identity, capacity);
      return { ok: false, statusCode: 403, reason: capacity.reason };
    }

    await this.dependencies.ledger.appendEvent(
      "delegation_requested",
      {
        parentGrantId: identity.grantId,
        requestedResources: [...request.exercisable.resources],
        requestedActions: [...request.exercisable.actions],
      },
      this.context(identity),
    );

    const childPrincipalId = (this.dependencies.id ?? randomUUID)();
    const childGrantId = (this.dependencies.id ?? randomUUID)();
    const remaining = Math.min(
      resolution.state.envelope.maxTokens - resolution.state.grantState.tokensUsed,
      resolution.state.runState.maxTokens - resolution.state.runState.tokensUsed,
    );
    const derivation = deriveChildEnvelope(resolution.state.envelope, request, {
      id: childGrantId,
      principalId: childPrincipalId,
      createdAt: now,
      maxTokensCeiling: remaining,
    });
    if (!derivation.ok) {
      await this.appendEvaluation(identity, {
        verdict: "DENY",
        reason: derivation.reason,
      });
      return {
        ok: false,
        statusCode: derivation.reason === "CHILD_EXCEEDS_PARENT" ? 400 : 403,
        reason: derivation.reason,
      };
    }
    await this.appendEvaluation(identity, { verdict: "ALLOW", reason: "AUTHORIZED" });

    const childPrincipal: Principal = {
      id: childPrincipalId,
      kind: "agent",
      ...(identity.principal.ownerId ? { ownerId: identity.principal.ownerId } : {}),
      parentPrincipalId: identity.principal.id,
    };
    await this.persistChild(childPrincipal, derivation.envelope);
    await this.dependencies.ledger.appendEvent(
      "principal_created",
      { kind: "agent", parentPrincipalId: identity.principal.id },
      { ...this.context(identity), principalId: childPrincipal.id },
    );
    await this.dependencies.ledger.appendEvent(
      "grant_created",
      { parentGrantId: identity.grantId, depth: derivation.envelope.depth },
      {
        runId: identity.runId,
        grantId: derivation.envelope.id,
        principalId: childPrincipal.id,
      },
    );
    return {
      ok: true,
      grant: { childPrincipalId, grantId: childGrantId, status: "grant_created" },
    };
  }

  private context(identity: AgentIdentity) {
    return {
      runId: identity.runId,
      grantId: identity.grantId,
      principalId: identity.principalId,
    };
  }

  private appendEvaluation(identity: AgentIdentity, decision: Decision) {
    return this.dependencies.ledger.appendEvent(
      "authority_evaluated",
      { verdict: decision.verdict, reason: decision.reason },
      this.context(identity),
    );
  }

  private persistChild(principal: Principal, envelope: DerivedEnvelope) {
    return this.dependencies.store.mutate((database) => {
      database.principals.push(principal);
      database.envelopes.push(envelope);
    });
  }
}
