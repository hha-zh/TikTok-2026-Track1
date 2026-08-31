import { T1_TRANSPORT, T2_ACCOMMODATION } from "./graph.js";

export interface LiveTopologyEvidence {
  taskId: string;
  who: string | null;
  how: string;
}

export interface BoundedReturnEvidence {
  published?: boolean;
  parentReadStatus?: number | null;
  parentReceivedBoundedArtifact?: boolean;
}

export function deriveNoRawChildHandoff(
  rawChildOutputAbsentFromParentView: boolean,
  boundedReturn: BoundedReturnEvidence | null | undefined,
): boolean {
  return rawChildOutputAbsentFromParentView === true
    && boundedReturn?.published === true
    && boundedReturn.parentReadStatus === 200
    && boundedReturn.parentReceivedBoundedArtifact === true;
}

export function deriveEarlyRouterTopology(
  topology: readonly LiveTopologyEvidence[],
): boolean {
  return [T1_TRANSPORT, T2_ACCOMMODATION].every((taskId) =>
    topology.some((item) => item.taskId === taskId
      && item.who === "DELEGATE_SPECIALIST"
      && item.how === "PARALLEL"));
}

export function deriveOraclePassed(
  groups: readonly Readonly<Record<string, boolean>>[],
): boolean {
  return groups.every((group) => Object.values(group).every((claim) => claim === true));
}

export function deriveLiveProofStatus(
  failure: string | null,
  oraclePassed: boolean,
  claims: Readonly<Record<string, boolean>>,
): "PROVEN" | "FAILED" {
  return failure === null && oraclePassed === true
    && Object.values(claims).every((claim) => claim === true)
    ? "PROVEN"
    : "FAILED";
}

/**
 * Stage 7D.4 strengthened live-proof predicates.
 *
 * These previously lived inline in scripts/stage7d-travel-proof.mjs as
 * existence-only checks that reused the frozen deterministic oracle's key
 * names while asserting far less than those names imply. They are pure and
 * exported so they carry persistent regression tests rather than relying on
 * the script being reviewed by hand.
 */
export interface RoutingDecisionEvidence {
  taskId: string;
  decisionId: string;
  placement: string | null;
  delegationValue: number | null;
  delegationThreshold: number | null;
  budget?: { runPressure: number };
  candidates?: readonly unknown[];
}

/** Every recorded decision must carry actual candidate evidence, not merely exist. */
export function deriveRealCandidateSnapshot(
  decisions: readonly RoutingDecisionEvidence[],
): boolean {
  return decisions.length > 0
    && decisions.every((decision) =>
      Array.isArray(decision.candidates) && decision.candidates.length > 0);
}

/**
 * The later decision must be taken against fresher, more pressured projected
 * state at an unchanged intrinsic value, and must actually change WHO.
 * Mirrors the frozen predicate in oracle.ts.
 */
export function deriveFreshStateChangesWho(
  early: RoutingDecisionEvidence | undefined,
  later: RoutingDecisionEvidence | undefined,
): boolean {
  if (!early || !later) return false;
  return early.delegationValue === later.delegationValue
    && (early.delegationThreshold ?? Infinity) < (later.delegationThreshold ?? -Infinity)
    && (early.budget?.runPressure ?? 1) < (later.budget?.runPressure ?? 0)
    && early.placement === "DELEGATE_SPECIALIST"
    && later.placement === "REUSE_CURRENT";
}

/**
 * Every routing decision must correlate to an invocation that actually reached
 * the dispatch boundary. A terminal run_outcome is written for FAILED runs too
 * and therefore proves nothing on its own.
 */
export function deriveEvidenceCorrelated(
  decisions: readonly RoutingDecisionEvidence[],
  invocationDecisionIds: ReadonlySet<string>,
): boolean {
  return decisions.length > 0
    && decisions.every((decision) => invocationDecisionIds.has(decision.decisionId));
}

export interface ParentVisibleArtifactEvidence {
  type: string;
  boundedFields?: Record<string, unknown>;
}

/**
 * A realistic parent-visible boundary: every artifact the parent can see must
 * expose only its registered field names with bounded scalar values. Raw model
 * prose admitted as an artifact field fails on the name or on the length.
 */
export function deriveParentVisibleArtifactsBounded(
  artifacts: readonly ParentVisibleArtifactEvidence[] | undefined,
  allowedFieldsByType: ReadonlyMap<string, readonly string[]>,
  // The longest legitimate Travel field value is a 25-character ISO timestamp,
  // so 64 leaves ample headroom while still rejecting model prose.
  maxStringLength = 64,
): boolean {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return false;
  return artifacts.every((artifact) => {
    const allowed = allowedFieldsByType.get(artifact.type);
    if (!allowed) return false;
    return Object.entries(artifact.boundedFields ?? {}).every(([name, value]) =>
      allowed.includes(name)
      && (typeof value !== "string" || value.length <= maxStringLength));
  });
}
