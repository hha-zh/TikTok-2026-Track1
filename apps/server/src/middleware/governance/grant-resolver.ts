import type { JsonStore } from "../../store.js";
import type { GovernanceState, ReasonCode } from "./types.js";

const MAX_ANCESTRY_DEPTH = 128;

export interface GrantResolutionInput {
  principalId: string;
  grantId: string;
  runId: string;
}

type GrantResolutionReason = Extract<ReasonCode, "GRANT_NOT_FOUND" | "MALFORMED_INPUT">;

export type GrantResolutionResult =
  | { ok: true; state: GovernanceState }
  | { ok: false; reason: GrantResolutionReason; detail: string };

function failure(
  reason: GrantResolutionReason,
  detail: string,
): GrantResolutionResult {
  return { ok: false, reason, detail };
}

export function resolveGrant(
  input: GrantResolutionInput,
  store: JsonStore,
  now = new Date().toISOString(),
): GrantResolutionResult {
  const nowMillis = Date.parse(now);
  if (!Number.isFinite(nowMillis)) {
    return failure("MALFORMED_INPUT", "Resolution time is invalid");
  }

  const database = store.snapshot();
  const envelope = database.envelopes.find((item) => item.id === input.grantId);
  if (!envelope) return failure("GRANT_NOT_FOUND", "Grant does not exist");
  if (envelope.principalId !== input.principalId) {
    return failure("MALFORMED_INPUT", "Grant principal does not match identity");
  }
  if (envelope.runId !== input.runId) {
    return failure("MALFORMED_INPUT", "Grant run does not match identity");
  }

  const grantState = database.grantStates.find(
    (state) => state.grantId === envelope.id,
  );
  const runState = database.runStates.find(
    (state) => state.runId === envelope.runId,
  );
  if (!grantState || !runState) {
    return failure("MALFORMED_INPUT", "Grant accounting state is incomplete");
  }

  const ancestry: GovernanceState["ancestry"] = [];
  const visited = new Set<string>([envelope.id]);
  let parentGrantId = envelope.parentGrantId;

  while (parentGrantId) {
    if (ancestry.length >= MAX_ANCESTRY_DEPTH || visited.has(parentGrantId)) {
      return failure("MALFORMED_INPUT", "Grant ancestry is cyclic or too deep");
    }
    visited.add(parentGrantId);

    const parent = database.envelopes.find((item) => item.id === parentGrantId);
    if (!parent || parent.runId !== envelope.runId) {
      return failure("MALFORMED_INPUT", "Grant ancestry is incomplete");
    }
    const parentState = database.grantStates.find(
      (state) => state.grantId === parent.id,
    );
    if (!parentState) {
      return failure("MALFORMED_INPUT", "Grant ancestry state is incomplete");
    }

    let expired = false;
    if (parent.expiresAt !== undefined) {
      const expiryMillis = Date.parse(parent.expiresAt);
      if (!Number.isFinite(expiryMillis)) {
        return failure("MALFORMED_INPUT", "Grant ancestry expiry is invalid");
      }
      expired = nowMillis >= expiryMillis;
    }
    ancestry.push({
      grantId: parent.id,
      revoked: parentState.revoked || parent.revokedAt !== undefined,
      expired,
    });
    parentGrantId = parent.parentGrantId;
  }

  return {
    ok: true,
    state: { envelope, ancestry, grantState, runState, now },
  };
}
