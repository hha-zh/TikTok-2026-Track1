import type { JsonStore } from "../../store.js";
import type { Principal, ReasonCode } from "./types.js";
import {
  RunTokenService,
  RunTokenVerificationError,
} from "./run-token.js";

export interface IdentityCredentials {
  authorizationHeader?: string;
  principalHeader?: string;
}

export type AuthenticatedIdentity =
  | {
      kind: "human";
      principalId: string;
      principal: Principal;
    }
  | {
      kind: "agent";
      principalId: string;
      grantId: string;
      runId: string;
      principal: Principal;
    };

export type IdentityResult =
  | { ok: true; identity: AuthenticatedIdentity }
  | { ok: false; reason: Extract<ReasonCode, "INVALID_TOKEN" | "PRINCIPAL_NOT_FOUND"> };

export interface IdentityDependencies {
  store: JsonStore;
  runTokens: RunTokenService;
}

export function verifyIdentity(
  credentials: IdentityCredentials,
  dependencies: IdentityDependencies,
  nowEpochSeconds?: number,
): IdentityResult {
  const bearer = credentials.authorizationHeader?.startsWith("Bearer ")
    ? credentials.authorizationHeader.slice(7)
    : undefined;

  if (bearer && RunTokenService.hasTokenMarker(bearer)) {
    try {
      const claims = dependencies.runTokens.verify(bearer, nowEpochSeconds);
      const principal = dependencies.store
        .snapshot()
        .principals.find((item) => item.id === claims.principalId);
      if (!principal || principal.kind !== "agent") {
        return { ok: false, reason: "PRINCIPAL_NOT_FOUND" };
      }
      return {
        ok: true,
        identity: {
          kind: "agent",
          principalId: principal.id,
          grantId: claims.grantId,
          runId: claims.runId,
          principal,
        },
      };
    } catch (error) {
      if (error instanceof RunTokenVerificationError) {
        return { ok: false, reason: "INVALID_TOKEN" };
      }
      return { ok: false, reason: "INVALID_TOKEN" };
    }
  }

  const principal = dependencies.store
    .snapshot()
    .principals.find((item) => item.id === credentials.principalHeader);
  if (!principal || principal.kind !== "human") {
    return { ok: false, reason: "PRINCIPAL_NOT_FOUND" };
  }
  return {
    ok: true,
    identity: { kind: "human", principalId: principal.id, principal },
  };
}
