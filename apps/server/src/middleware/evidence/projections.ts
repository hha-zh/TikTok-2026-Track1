import type { Database } from "../../types.js";
import type { RunState } from "../governance/types.js";
import type { GovernanceEvent } from "./types.js";

type ProjectionCollections = Pick<Database, "runStates" | "grantStates">;

function requireRunState(database: ProjectionCollections, runId: string) {
  const state = database.runStates.find((item) => item.runId === runId);
  if (!state) {
    throw new Error("RunState must exist before tokens are consumed");
  }
  return state;
}

function ensureGrantState(database: ProjectionCollections, grantId: string) {
  let state = database.grantStates.find((item) => item.grantId === grantId);
  if (!state) {
    state = { grantId, revoked: false, tokensUsed: 0, childCount: 0 };
    database.grantStates.push(state);
  }
  return state;
}

export function applyGovernanceEvent(
  database: ProjectionCollections,
  event: GovernanceEvent,
): void {
  switch (event.kind) {
    case "tokens_consumed": {
      const payload = event.payload as GovernanceEvent<"tokens_consumed">["payload"];
      requireRunState(database, event.runId).tokensUsed += payload.totalTokens;
      ensureGrantState(database, event.grantId).tokensUsed += payload.totalTokens;
      return;
    }
    case "grant_created": {
      const payload = event.payload as GovernanceEvent<"grant_created">["payload"];
      ensureGrantState(database, event.grantId);
      // grant_created is the sole authoritative child-count transition.
      if (payload.parentGrantId) {
        ensureGrantState(database, payload.parentGrantId).childCount += 1;
      }
      return;
    }
    case "grant_revoked":
      ensureGrantState(database, event.grantId).revoked = true;
      return;
    default:
      return;
  }
}

export function projectGovernanceEvents(
  events: readonly GovernanceEvent[],
  initialRunStates: readonly RunState[],
): ProjectionCollections {
  // The event log has usage events but no run-cap event, so callers must supply
  // the configured run states rather than replay inventing maxTokens values.
  const projections: ProjectionCollections = {
    runStates: structuredClone([...initialRunStates]),
    grantStates: [],
  };
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    applyGovernanceEvent(projections, event);
  }
  return projections;
}
