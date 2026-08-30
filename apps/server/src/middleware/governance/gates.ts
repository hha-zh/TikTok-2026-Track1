import type { GovernanceLedger } from "../evidence/ledger.js";
import type { JsonStore } from "../../store.js";
import type { AuthenticatedIdentity } from "./identity.js";
import { authorize } from "./authorize.js";
import { resolveGrant } from "./grant-resolver.js";
import type { Decision, MockResource, ReasonCode } from "./types.js";

type AgentIdentity = Extract<AuthenticatedIdentity, { kind: "agent" }>;

export interface GateDependencies {
  store: JsonStore;
  ledger: GovernanceLedger;
  now?: () => string;
}

export type GateResult<T> =
  | { ok: true; value: T }
  | { ok: false; statusCode: 400 | 403 | 404; reason: ReasonCode };

function resolve(identity: AgentIdentity, dependencies: GateDependencies) {
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

function context(identity: AgentIdentity) {
  return {
    principalId: identity.principalId,
    grantId: identity.grantId,
    runId: identity.runId,
  };
}

export async function readManagedResource(
  identity: AgentIdentity,
  resourceId: string,
  dependencies: GateDependencies,
): Promise<GateResult<MockResource["body"]>> {
  const resolution = resolve(identity, dependencies);
  if (!resolution.ok) {
    return {
      ok: false,
      statusCode: resolution.reason === "MALFORMED_INPUT" ? 400 : 403,
      reason: resolution.reason,
    };
  }
  const resource = dependencies.store
    .snapshot()
    .mockResources.find((item) => item.id === resourceId);
  if (!resource) {
    return { ok: false, statusCode: 404, reason: "MALFORMED_INPUT" };
  }
  const decision = authorize(identity.principal, "read", resourceId, resolution.state);
  await appendResourceDecision(dependencies.ledger, identity, resourceId, decision);
  if (decision.verdict === "DENY") {
    return { ok: false, statusCode: 403, reason: decision.reason };
  }
  return { ok: true, value: resource.body };
}

async function appendResourceDecision(
  ledger: GovernanceLedger,
  identity: AgentIdentity,
  resourceId: string,
  decision: Decision,
): Promise<void> {
  if (decision.verdict === "ALLOW") {
    await ledger.appendEvent(
      "resource_allowed",
      { resourceId, action: "read" },
      context(identity),
    );
  } else {
    await ledger.appendEvent(
      "resource_denied",
      { resourceId, action: "read", reason: decision.reason },
      context(identity),
    );
  }
}

const trustedTools = {
  inspect_metrics: () => ({ tool: "inspect_metrics", status: "healthy" }),
  summarize_release: () => ({ tool: "summarize_release", summary: "ready" }),
  apply_production_patch: () => ({ tool: "apply_production_patch", applied: false }),
} as const;

export async function invokeTrustedTool(
  identity: AgentIdentity,
  toolName: string,
  dependencies: GateDependencies,
): Promise<GateResult<unknown>> {
  const tool = trustedTools[toolName as keyof typeof trustedTools];
  if (!tool) return { ok: false, statusCode: 404, reason: "MALFORMED_INPUT" };
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
    `tool:${toolName}`,
    null,
    resolution.state,
  );
  if (decision.verdict === "ALLOW") {
    await dependencies.ledger.appendEvent(
      "tool_allowed",
      { toolName },
      context(identity),
    );
    return { ok: true, value: tool() };
  }
  await dependencies.ledger.appendEvent(
    "tool_denied",
    { toolName, reason: decision.reason },
    context(identity),
  );
  return { ok: false, statusCode: 403, reason: decision.reason };
}
