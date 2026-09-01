import { describe, expect, it } from "vitest";
import type { GovernanceEvent } from "./types.js";
import {
  applyGovernanceEvent,
  projectGovernanceEvents,
} from "./projections.js";

const context = {
  ts: "2026-01-01T00:00:00.000Z",
  runId: "run-1",
  grantId: "grant-1",
  principalId: "principal-1",
};

describe("governance projections", () => {
  it("projects consumed tokens into run and grant accounting", () => {
    const event: GovernanceEvent<"tokens_consumed"> = {
      ...context,
      seq: 1,
      kind: "tokens_consumed",
      payload: {
        inputTokens: 7,
        cachedInputTokens: 2,
        outputTokens: 3,
        totalTokens: 10,
      },
    };

    expect(
      projectGovernanceEvents([event], [
        { runId: "run-1", maxTokens: 1_200, tokensUsed: 0 },
      ]),
    ).toEqual({
      runStates: [{ runId: "run-1", maxTokens: 1_200, tokensUsed: 10 }],
      grantStates: [
        { grantId: "grant-1", revoked: false, tokensUsed: 10, childCount: 0 },
      ],
    });
  });

  it("does not invent a run cap while replaying token usage", () => {
    const event: GovernanceEvent<"tokens_consumed"> = {
      ...context,
      seq: 1,
      kind: "tokens_consumed",
      payload: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        totalTokens: 2,
      },
    };

    expect(() => projectGovernanceEvents([event], [])).toThrow(
      "RunState must exist before tokens are consumed",
    );
  });

  it("projects grant revocation", () => {
    const event: GovernanceEvent<"grant_revoked"> = {
      ...context,
      seq: 1,
      kind: "grant_revoked",
      payload: { reason: "MALFORMED_INPUT" },
    };

    expect(projectGovernanceEvents([event], []).grantStates).toEqual([
      { grantId: "grant-1", revoked: true, tokensUsed: 0, childCount: 0 },
    ]);
  });

  it("increments parent child count only on grant creation", () => {
    const projections = { runStates: [], grantStates: [] };
    const requested: GovernanceEvent<"delegation_requested"> = {
      ...context,
      seq: 1,
      kind: "delegation_requested",
      payload: {
        parentGrantId: "parent-grant",
        requestedResources: [],
        requestedActions: [],
      },
    };
    const principalCreated: GovernanceEvent<"principal_created"> = {
      ...context,
      seq: 2,
      kind: "principal_created",
      payload: { kind: "agent", parentPrincipalId: "principal-1" },
    };
    const grantCreated: GovernanceEvent<"grant_created"> = {
      ...context,
      seq: 3,
      grantId: "child-grant",
      kind: "grant_created",
      payload: { parentGrantId: "parent-grant", depth: 1 },
    };

    applyGovernanceEvent(projections, requested);
    applyGovernanceEvent(projections, principalCreated);
    expect(projections.grantStates).toEqual([]);
    applyGovernanceEvent(projections, grantCreated);
    expect(
      projections.grantStates.find((state) => state.grantId === "parent-grant")
        ?.childCount,
    ).toBe(1);
  });

  it("does not change budget projections for unrelated events", () => {
    const projections = {
      runStates: [{ runId: "run-1", maxTokens: 1_200, tokensUsed: 8 }],
      grantStates: [
        { grantId: "grant-1", revoked: false, tokensUsed: 8, childCount: 0 },
      ],
    };
    const event: GovernanceEvent<"authority_evaluated"> = {
      ...context,
      seq: 1,
      kind: "authority_evaluated",
      payload: { verdict: "ALLOW", reason: "ACTION_NOT_GRANTED" },
    };

    applyGovernanceEvent(projections, event);
    expect(projections).toEqual({
      runStates: [{ runId: "run-1", maxTokens: 1_200, tokensUsed: 8 }],
      grantStates: [
        { grantId: "grant-1", revoked: false, tokensUsed: 8, childCount: 0 },
      ],
    });
  });
});
