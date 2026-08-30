/**
 * Artifact store and Return Gate — Design §6; Brief item 13.
 *
 * The Return Gate is an explicit declassification checkpoint, not a field
 * filter. Raw protected values never leave the child's context; what crosses is
 * a bounded, schema-constrained projection released by a trusted endpoint after
 * a policy check.
 *
 * Publish routes through the FULL pipeline — verifyIdentity -> resolveGrant ->
 * authorize -> validatePublication. That is deliberate rather than incidental:
 * `authorize` re-walks ancestry, so a child whose parent was revoked *after*
 * dispatch cannot publish. It shrinks the in-flight revocation window at no
 * extra cost, which is why the authorize step must not be shortcut.
 *
 * Two distinct denials that are easy to conflate:
 *   ARTIFACT_TYPE_NOT_GRANTED  the type has no registered schema
 *   RESOURCE_NOT_GRANTED       the type is registered but outside your envelope
 */

import { randomUUID } from "node:crypto";
import type { GovernanceLedger } from "../evidence/ledger.js";
import type { JsonStore } from "../../store.js";
import { authorize } from "./authorize.js";
import { resolveGrant } from "./grant-resolver.js";
import type { AuthenticatedIdentity } from "./identity.js";
import type { Artifact, ArtifactSchema, ReasonCode } from "./types.js";

type AgentIdentity = Extract<AuthenticatedIdentity, { kind: "agent" }>;

export interface ArtifactDependencies {
  store: JsonStore;
  ledger: GovernanceLedger;
  now?: () => string;
  id?: () => string;
}

export type ArtifactResult<T> =
  | { ok: true; value: T }
  | { ok: false; statusCode: 400 | 403 | 404; reason: ReasonCode; detail?: string };

/**
 * Per-field value rules. `ArtifactSchema` carries the count, byte ceiling and
 * permitted names; these carry the shapes.
 *
 * There is deliberately no free-text kind. "Reject raw records, identifiers and
 * free text" therefore holds because the spec language cannot express a field
 * that would admit them — not because a validation branch remembers to say no.
 */
export type FieldSpec =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "int"; min: number; max: number }
  | { kind: "window" };

const FIELD_SPECS: Record<string, Record<string, FieldSpec>> = {
  SecurityFinding: {
    actor_class: { kind: "enum", values: ["human", "pipeline", "service"] },
    action_count: { kind: "int", min: 0, max: 10_000 },
    time_window: { kind: "window" },
    verdict: { kind: "enum", values: ["expected", "anomalous", "inconclusive"] },
  },
};

/**
 * Register the field shapes for an artifact type.
 *
 * A workload registers its own bounded types here rather than governance
 * knowing about any particular workload. The spec language still has no
 * free-text kind, so a registration cannot open a prose channel however it is
 * written - that property belongs to the language, not to who calls this.
 *
 * Idempotent, so seeding twice is safe.
 */
export function registerArtifactFieldSpecs(
  artifactType: string,
  specs: Record<string, FieldSpec>,
): void {
  FIELD_SPECS[artifactType] = { ...specs };
}

function isBoundedInt(value: unknown, min: number, max: number): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}

function matchesSpec(spec: FieldSpec, value: unknown): boolean {
  switch (spec.kind) {
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
    case "int":
      return isBoundedInt(value, spec.min, spec.max);
    case "window": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length !== 2) return false;
      const window = value as { start?: unknown; end?: unknown };
      return (
        isBoundedInt(window.start, 0, Number.MAX_SAFE_INTEGER) &&
        isBoundedInt(window.end, 0, Number.MAX_SAFE_INTEGER)
      );
    }
    default:
      return false;
  }
}

export type PublicationValidation =
  | { ok: true }
  | { ok: false; reason: ReasonCode; detail: string };

/**
 * Applies the §6 schema. Fails closed: an unknown type, an unexpected field, a
 * value of the wrong shape or an oversized payload are all refusals.
 */
export function validatePublication(
  schema: ArtifactSchema | undefined,
  artifactType: string,
  fields: Record<string, unknown>,
): PublicationValidation {
  if (!schema || schema.artifactType !== artifactType) {
    return {
      ok: false,
      reason: "ARTIFACT_TYPE_NOT_GRANTED",
      detail: "no registered schema for " + artifactType,
    };
  }
  const specs = FIELD_SPECS[artifactType];
  if (!specs) {
    return {
      ok: false,
      reason: "ARTIFACT_TYPE_NOT_GRANTED",
      detail: "no field specification for " + artifactType,
    };
  }

  const names = Object.keys(fields);
  if (names.length > schema.maxFieldCount) {
    return {
      ok: false,
      reason: "ARTIFACT_SCHEMA_VIOLATION",
      detail: `${names.length} fields exceeds ${schema.maxFieldCount}`,
    };
  }
  for (const name of names) {
    if (!schema.allowedFieldNames.includes(name)) {
      return {
        ok: false,
        reason: "ARTIFACT_SCHEMA_VIOLATION",
        detail: "field not permitted: " + name,
      };
    }
    const spec = specs[name];
    if (!spec || !matchesSpec(spec, fields[name])) {
      return {
        ok: false,
        reason: "ARTIFACT_SCHEMA_VIOLATION",
        detail: "field failed its specification: " + name,
      };
    }
  }
  const bytes = Buffer.byteLength(JSON.stringify(fields), "utf8");
  if (bytes > schema.maxSerializedBytes) {
    return {
      ok: false,
      reason: "ARTIFACT_SCHEMA_VIOLATION",
      detail: `${bytes} bytes exceeds ${schema.maxSerializedBytes}`,
    };
  }
  return { ok: true };
}

function context(identity: AgentIdentity) {
  return {
    runId: identity.runId,
    grantId: identity.grantId,
    principalId: identity.principalId,
  };
}

function resolve(identity: AgentIdentity, dependencies: ArtifactDependencies) {
  return resolveGrant(
    {
      principalId: identity.principalId,
      grantId: identity.grantId,
      runId: identity.runId,
    },
    dependencies.store,
    dependencies.now?.(),
  );
}

/** Principals in this principal's own ancestry chain, nearest parent first. */
export function ancestorPrincipalIds(
  store: JsonStore,
  grantId: string,
): string[] {
  const database = store.snapshot();
  const ids: string[] = [];
  const seen = new Set<string>();
  let current = database.envelopes.find((item) => item.id === grantId);
  while (current?.parentGrantId) {
    const parentId: string = current.parentGrantId;
    if (seen.has(parentId)) break; // cyclic data must terminate, not hang
    seen.add(parentId);
    const parent = database.envelopes.find((item) => item.id === parentId);
    if (!parent) break;
    ids.push(parent.principalId);
    current = parent;
  }
  return ids;
}

export async function createArtifact(
  identity: AgentIdentity,
  input: { artifactType: string; fields: Record<string, unknown> },
  dependencies: ArtifactDependencies,
): Promise<ArtifactResult<Artifact>> {
  const resolution = resolve(identity, dependencies);
  if (!resolution.ok) {
    return {
      ok: false,
      statusCode: resolution.reason === "MALFORMED_INPUT" ? 400 : 403,
      reason: resolution.reason,
    };
  }
  const decision = authorize(
    identity.principal,
    "artifact:create",
    input.artifactType,
    resolution.state,
  );
  if (decision.verdict === "DENY") {
    await dependencies.ledger.appendEvent(
      "artifact_rejected",
      { artifactType: input.artifactType, reason: decision.reason },
      context(identity),
    );
    return { ok: false, statusCode: 403, reason: decision.reason };
  }

  const artifact: Artifact = {
    id: (dependencies.id ?? randomUUID)(),
    ownerPrincipalId: identity.principalId,
    type: input.artifactType,
    fields: structuredClone(input.fields),
    published: false,
    recipients: [],
  };
  await dependencies.store.mutate((database) => {
    database.artifacts.push(artifact);
  });
  await dependencies.ledger.appendEvent(
    "artifact_created",
    { artifactId: artifact.id, artifactType: artifact.type },
    context(identity),
  );
  return { ok: true, value: artifact };
}

export async function publishArtifact(
  identity: AgentIdentity,
  artifactId: string,
  input: {
    artifactType: string;
    fields: Record<string, unknown>;
    recipients?: string[] | undefined;
  },
  dependencies: ArtifactDependencies,
): Promise<ArtifactResult<Artifact>> {
  const existing = dependencies.store
    .snapshot()
    .artifacts.find((item) => item.id === artifactId);
  if (!existing) {
    return { ok: false, statusCode: 404, reason: "MALFORMED_INPUT" };
  }
  if (existing.ownerPrincipalId !== identity.principalId) {
    return { ok: false, statusCode: 403, reason: "ARTIFACT_NOT_RECIPIENT" };
  }

  // Full pipeline. authorize re-walks ancestry here, so a child dispatched
  // before its parent was revoked still cannot publish afterwards.
  const resolution = resolve(identity, dependencies);
  if (!resolution.ok) {
    return {
      ok: false,
      statusCode: resolution.reason === "MALFORMED_INPUT" ? 400 : 403,
      reason: resolution.reason,
    };
  }
  const decision = authorize(
    identity.principal,
    "artifact:publish",
    input.artifactType,
    resolution.state,
  );
  if (decision.verdict === "DENY") {
    await dependencies.ledger.appendEvent(
      "artifact_rejected",
      { artifactId, artifactType: input.artifactType, reason: decision.reason },
      context(identity),
    );
    return { ok: false, statusCode: 403, reason: decision.reason };
  }

  const schema = dependencies.store
    .snapshot()
    .artifactSchemas.find((item) => item.artifactType === input.artifactType);
  const validation = validatePublication(schema, input.artifactType, input.fields);
  if (!validation.ok) {
    await dependencies.ledger.appendEvent(
      "artifact_rejected",
      { artifactId, artifactType: input.artifactType, reason: validation.reason },
      context(identity),
    );
    return {
      ok: false,
      statusCode: 400,
      reason: validation.reason,
      detail: validation.detail,
    };
  }

  // Publication is directed: default to the parent principal only. A child may
  // not name anyone outside its own ancestry, or "published" would quietly
  // become world-readable to siblings.
  const ancestors = ancestorPrincipalIds(dependencies.store, identity.grantId);
  const requested = input.recipients ?? ancestors.slice(0, 1);
  const outside = requested.filter((id) => !ancestors.includes(id));
  if (outside.length > 0) {
    await dependencies.ledger.appendEvent(
      "artifact_rejected",
      { artifactId, artifactType: input.artifactType, reason: "ARTIFACT_NOT_RECIPIENT" },
      context(identity),
    );
    return {
      ok: false,
      statusCode: 403,
      reason: "ARTIFACT_NOT_RECIPIENT",
      detail: "recipient outside the publisher's ancestry: " + outside.join(", "),
    };
  }

  const published = await dependencies.store.mutate((database) => {
    const stored = database.artifacts.find((item) => item.id === artifactId);
    if (!stored) return null;
    stored.fields = structuredClone(input.fields);
    stored.type = input.artifactType;
    stored.published = true;
    stored.recipients = [...requested];
    return structuredClone(stored);
  });
  if (!published) {
    return { ok: false, statusCode: 404, reason: "MALFORMED_INPUT" };
  }
  await dependencies.ledger.appendEvent(
    "artifact_published",
    { artifactId, recipientCount: published.recipients.length },
    context(identity),
  );
  return { ok: true, value: published };
}

export function readArtifact(
  identity: AgentIdentity,
  artifactId: string,
  dependencies: ArtifactDependencies,
): ArtifactResult<Artifact> {
  const artifact = dependencies.store
    .snapshot()
    .artifacts.find((item) => item.id === artifactId);
  if (!artifact) {
    return { ok: false, statusCode: 404, reason: "MALFORMED_INPUT" };
  }
  if (artifact.ownerPrincipalId === identity.principalId) {
    return { ok: true, value: artifact };
  }
  if (!artifact.published) {
    return { ok: false, statusCode: 403, reason: "ARTIFACT_NOT_PUBLISHED" };
  }
  if (!artifact.recipients.includes(identity.principalId)) {
    return { ok: false, statusCode: 403, reason: "ARTIFACT_NOT_RECIPIENT" };
  }
  return { ok: true, value: artifact };
}
