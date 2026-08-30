import type { Decision, GovernanceState, Principal } from "./types.js";

function deny(reason: Decision["reason"]): Decision {
  return { verdict: "DENY", reason };
}

function matchesResource(resource: string, granted: readonly string[]): boolean {
  return granted.some((scope) => {
    if (scope === resource) return true;
    if (!scope.endsWith("/*")) return false;
    const prefix = scope.slice(0, -1);
    return resource.length > prefix.length && resource.startsWith(prefix);
  });
}

function hasBudget(state: GovernanceState): boolean {
  const values = [
    state.envelope.maxTokens,
    state.grantState.tokensUsed,
    state.runState.maxTokens,
    state.runState.tokensUsed,
  ];
  if (!values.every(Number.isFinite)) return false;
  const grantRemaining = state.envelope.maxTokens - state.grantState.tokensUsed;
  const runRemaining = state.runState.maxTokens - state.runState.tokensUsed;
  return Math.min(grantRemaining, runRemaining) > 0;
}

function lifecycleDecision(state: GovernanceState): Decision | null {
  if (
    state.grantState.revoked ||
    state.envelope.revokedAt !== undefined ||
    state.ancestry.some((ancestor) => ancestor.revoked)
  ) {
    return deny("PARENT_GRANT_REVOKED");
  }

  const now = Date.parse(state.now);
  const expiresAt =
    state.envelope.expiresAt === undefined
      ? null
      : Date.parse(state.envelope.expiresAt);
  if (
    !Number.isFinite(now) ||
    (expiresAt !== null && (!Number.isFinite(expiresAt) || now >= expiresAt)) ||
    state.ancestry.some((ancestor) => ancestor.expired)
  ) {
    return deny("PARENT_GRANT_EXPIRED");
  }
  return null;
}

export function authorize(
  _principal: Principal,
  action: string,
  resource: string | null | undefined,
  state: GovernanceState,
): Decision {
  const lifecycle = lifecycleDecision(state);
  if (lifecycle) return lifecycle;

  if (action === "delegate") {
    if (resource !== null && resource !== undefined) {
      return deny("MALFORMED_INPUT");
    }
    if (!state.envelope.exercisable.actions.includes(action)) {
      return deny("ACTION_NOT_GRANTED");
    }
    if (state.envelope.depth <= 0) {
      return deny("DELEGATION_CEILING_REACHED");
    }
    if (state.grantState.childCount >= state.envelope.maxChildren) {
      return deny("MAX_CHILDREN_EXCEEDED");
    }
    if (!hasBudget(state)) return deny("BUDGET_EXCEEDED");
    return { verdict: "ALLOW", reason: "AUTHORIZED" };
  }

  if (resource !== null && resource !== undefined) {
    if (!matchesResource(resource, state.envelope.exercisable.resources)) {
      if (matchesResource(resource, state.envelope.delegatable.resources)) {
        return deny("NOT_EXERCISABLE_DELEGATE_ONLY");
      }
      return deny("RESOURCE_NOT_GRANTED");
    }
  }

  if (!state.envelope.exercisable.actions.includes(action)) {
    return deny("ACTION_NOT_GRANTED");
  }
  if (!hasBudget(state)) return deny("BUDGET_EXCEEDED");
  return { verdict: "ALLOW", reason: "AUTHORIZED" };
}
