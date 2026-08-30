import type { JsonStore } from "../../store.js";
import type { GovernanceEventKind } from "./types.js";

export interface BudgetView {
  runId: string;
  grantId: string;
  runTokensUsed: number;
  grantTokensUsed: number;
}

export interface ProvenanceEntry {
  seq: number;
  ts: string;
  grantId: string;
  principalId: string;
  kind: GovernanceEventKind;
}

export function budgetView(
  store: JsonStore,
  runId: string,
  grantId: string,
): BudgetView {
  const database = store.snapshot();
  return {
    runId,
    grantId,
    runTokensUsed:
      database.runStates.find((state) => state.runId === runId)?.tokensUsed ?? 0,
    grantTokensUsed:
      database.grantStates.find((state) => state.grantId === grantId)?.tokensUsed ??
      0,
  };
}

export function eventView(store: JsonStore, runId: string) {
  return store
    .snapshot()
    .governanceEvents.filter((event) => event.runId === runId)
    .sort((left, right) => left.seq - right.seq);
}

export function provenanceView(
  store: JsonStore,
  runId: string,
): ProvenanceEntry[] {
  return eventView(store, runId).map((event) => ({
    seq: event.seq,
    ts: event.ts,
    grantId: event.grantId,
    principalId: event.principalId,
    kind: event.kind,
  }));
}
