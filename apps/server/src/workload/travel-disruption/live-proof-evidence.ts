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
