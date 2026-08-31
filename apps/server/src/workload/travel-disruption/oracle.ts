import type { TravelLifecycleResult } from "./run.js";
import {
  A_FINAL, A_IDENTITY, T1_TRANSPORT, T2_ACCOMMODATION, T4_IDENTITY, T5_VALIDATE,
} from "./graph.js";
import { PASSPORT_LEAK_CANARY, RESOURCE_PASSPORT } from "./resources.js";

export interface TravelOracle {
  domain: Record<string, boolean>;
  governance: Record<string, boolean>;
  adaptive: Record<string, boolean>;
  lifecycle: Record<string, boolean>;
  passed: boolean;
}

export function evaluateTravelOracle(run: TravelLifecycleResult): TravelOracle {
  const snapshot = run.store.snapshot();
  const decisions = snapshot.governanceEvents.filter((event) => event.kind === "routing_decision");
  const decision = (taskId: string) => decisions.find((event) =>
    (event.payload as { taskId: string }).taskId === taskId)?.payload as undefined | {
      decisionId: string; placement: string | null; shape: string; delegationValue: number | null;
      delegationThreshold: number | null; budget: { runPressure: number };
      candidates: { placement: string; authorityLegal: boolean; structurallyNarrower: boolean }[];
    };
  const final = run.engine.artifacts.find((item) => item.id === A_FINAL)?.value as undefined | {
    transport_option_id: string; accommodation_option_id: string; route_option_id: string;
    final_arrival: string; total_additional_spend_sgd: number; approval_required: string;
  };
  const identity = run.engine.artifacts.find((item) => item.id === A_IDENTITY);
  const identityExecution = run.executor.executions.find((item) => item.taskId === T4_IDENTITY);
  const early = decision(T1_TRANSPORT);
  const later = decision(T5_VALIDATE);
  const evidenceText = JSON.stringify({
    events: snapshot.governanceEvents, storedArtifacts: snapshot.artifacts,
    runtimeArtifacts: run.engine.artifacts, contexts: run.executor.executions,
  });
  const childEnvelopes = run.delegation.records.map((record) =>
    snapshot.envelopes.find((item) => item.id === record.grantId));
  const invocationDecisionIds = new Set(snapshot.governanceEvents
    .filter((event) => event.kind === "invocation_started")
    .map((event) => (event.payload as { decisionId: string | null }).decisionId));

  const domain = {
    cancelledItineraryNotSelected: final?.transport_option_id !== "SQ638",
    arrivesBeforeDeadline: final !== undefined && Date.parse(final.final_arrival) <= Date.parse("2026-09-02T13:00:00+09:00"),
    spendWithinLimit: final !== undefined && final.total_additional_spend_sgd <= 700,
    combinationConsistent: final?.transport_option_id === "TR-ALT-02"
      && final.accommodation_option_id === "HT-03" && final.route_option_id === "RT-HND-01",
    approvalRequired: final?.total_additional_spend_sgd! > 300 && final?.approval_required === "yes",
  };
  const governance = {
    exactRootDenial: run.executor.denials.some((item) => item.resourceId === RESOURCE_PASSPORT
      && item.statusCode === 403 && item.reason === "NOT_EXERCISABLE_DELEGATE_ONLY"),
    legalIdentityDelegation: decision(T4_IDENTITY)?.placement === "DELEGATE_SPECIALIST",
    childrenAttenuated: childEnvelopes.every((envelope) => envelope !== undefined
      && envelope.parentGrantId === run.rootGrantId && envelope.depth === 0 && envelope.maxChildren === 0),
    passportBackendOnly: !evidenceText.includes(PASSPORT_LEAK_CANARY),
    identityContextMinimal: identityExecution?.included.length === 2
      && identityExecution.included.includes("travel_constraints") && identityExecution.included.includes("route_plan"),
    returnGateUsed: identity?.origin === "published_finding"
      && snapshot.governanceEvents.some((event) => event.kind === "artifact_published"),
    noRawChildHandoff: identity?.origin === "published_finding" && !evidenceText.includes("passportNumber"),
  };
  const adaptive = {
    realCandidateSnapshot: decisions.every((event) =>
      ((event.payload as { candidates: unknown[] }).candidates?.length ?? 0) > 0),
    earlyRouterTopology: decision(T1_TRANSPORT)?.placement === "DELEGATE_SPECIALIST"
      && decision(T2_ACCOMMODATION)?.placement === "DELEGATE_SPECIALIST"
      && decision(T1_TRANSPORT)?.shape === "PARALLEL",
    actualUsageProjected: snapshot.runStates.find((item) => item.runId === run.runId)?.tokensUsed === 9_400,
    freshStateChangesWho: early?.delegationValue === later?.delegationValue
      && (early?.delegationThreshold ?? Infinity) < (later?.delegationThreshold ?? -Infinity)
      && (early?.budget.runPressure ?? 1) < (later?.budget.runPressure ?? 0)
      && later?.placement === "REUSE_CURRENT",
  };
  const lifecycle = {
    requiredTasksComplete: run.engine.outcome === "COMPLETED" && run.engine.progress.completed.size === 7,
    boundedArtifactsCommitted: run.engine.artifacts.length === 7,
    childrenTerminal: run.revokedGrantIds.length === run.delegation.records.length
      && run.revokedGrantIds.every((grantId) => snapshot.grantStates.find((state) => state.grantId === grantId)?.revoked),
    evidenceCorrelated: decisions.every((event) =>
      invocationDecisionIds.has((event.payload as { decisionId: string }).decisionId)),
  };
  return {
    domain, governance, adaptive, lifecycle,
    passed: [...Object.values(domain), ...Object.values(governance), ...Object.values(adaptive), ...Object.values(lifecycle)].every(Boolean),
  };
}
