import { describe, expect, it } from "vitest";
import { authorize } from "./authorize.js";
import type { GovernanceState, Principal } from "./types.js";

const principal: Principal = { id: "agent-parent", kind: "agent", ownerId: "wtan" };

function state(overrides: Partial<GovernanceState> = {}): GovernanceState {
  return {
    envelope: {
      id: "grant-parent",
      principalId: principal.id,
      exercisable: {
        resources: ["app/*"],
        actions: ["read", "tool:inspect_metrics", "delegate"],
      },
      delegatable: { resources: ["sec/INC-42"], actions: ["read"] },
      depth: 1,
      maxTokens: 800,
      maxToolCalls: 10,
      maxChildren: 2,
      runId: "run-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    ancestry: [],
    grantState: { grantId: "grant-parent", revoked: false, tokensUsed: 100, childCount: 0 },
    runState: { runId: "run-1", maxTokens: 1200, tokensUsed: 200 },
    now: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

const reason = (
  action: string,
  resource: string | null | undefined,
  governanceState = state(),
) => authorize(principal, action, resource, governanceState).reason;

describe("authorize", () => {
  it("allows an exercisable resource", () => expect(reason("read", "app/metrics")).toBe("AUTHORIZED"));
  it("denies a resource outside both scopes", () => expect(reason("read", "payments/private")).toBe("RESOURCE_NOT_GRANTED"));
  it("denies a delegatable-only resource", () => expect(reason("read", "sec/INC-42")).toBe("NOT_EXERCISABLE_DELEGATE_ONLY"));
  it("denies a missing action", () => expect(reason("write", "app/metrics")).toBe("ACTION_NOT_GRANTED"));
  it("checks current revocation first", () => expect(reason("read", "missing", state({ grantState: { grantId: "grant-parent", revoked: true, tokensUsed: 900, childCount: 0 } }))).toBe("PARENT_GRANT_REVOKED"));
  it("checks ancestor revocation", () => expect(reason("read", "app/metrics", state({ ancestry: [{ grantId: "root", revoked: true, expired: false }] }))).toBe("PARENT_GRANT_REVOKED"));
  it("checks current expiry at the inclusive boundary", () => expect(reason("read", "app/metrics", state({ envelope: { ...state().envelope, expiresAt: state().now } }))).toBe("PARENT_GRANT_EXPIRED"));
  it("checks ancestor expiry", () => expect(reason("read", "app/metrics", state({ ancestry: [{ grantId: "root", revoked: false, expired: true }] }))).toBe("PARENT_GRANT_EXPIRED"));
  it("denies an exhausted grant budget", () => expect(reason("read", "app/metrics", state({ grantState: { grantId: "grant-parent", revoked: false, tokensUsed: 800, childCount: 0 } }))).toBe("BUDGET_EXCEEDED"));
  it("denies an exhausted run budget while grant remains", () => expect(reason("read", "app/metrics", state({ runState: { runId: "run-1", maxTokens: 1200, tokensUsed: 1200 } }))).toBe("BUDGET_EXCEEDED"));
  it("allows when both budgets remain", () => expect(reason("read", "app/metrics")).toBe("AUTHORIZED"));
  it("allows delegation with live capacity", () => expect(reason("delegate", null)).toBe("AUTHORIZED"));
  it("denies delegation at depth zero", () => expect(reason("delegate", null, state({ envelope: { ...state().envelope, depth: 0 } }))).toBe("DELEGATION_CEILING_REACHED"));
  it("denies delegation at max children", () => expect(reason("delegate", null, state({ grantState: { grantId: "grant-parent", revoked: false, tokensUsed: 100, childCount: 2 } }))).toBe("MAX_CHILDREN_EXCEEDED"));
  it("denies delegation with exhausted budget", () => expect(reason("delegate", null, state({ runState: { runId: "run-1", maxTokens: 200, tokensUsed: 200 } }))).toBe("BUDGET_EXCEEDED"));
  it("does not accept child requested scope as delegate input", () => expect(reason("delegate", "app/metrics")).toBe("MALFORMED_INPUT"));
  it("keeps namespace wildcard matching slash-safe", () => {
    expect(reason("read", "application/foo")).toBe("RESOURCE_NOT_GRANTED");
    expect(reason("read", "app2/foo")).toBe("RESOURCE_NOT_GRANTED");
    expect(reason("read", "app/")).toBe("RESOURCE_NOT_GRANTED");
  });
  it("does not mutate inputs", () => {
    const input = state();
    const before = structuredClone(input);
    authorize(principal, "read", "app/metrics", input);
    expect(input).toEqual(before);
  });
  it("keeps run and grant budgets independent", () => {
    expect(reason("read", "app/metrics", state({ grantState: { grantId: "grant-parent", revoked: false, tokensUsed: 799, childCount: 0 }, runState: { runId: "run-1", maxTokens: 1200, tokensUsed: 1199 } }))).toBe("AUTHORIZED");
    expect(reason("read", "app/metrics", state({ grantState: { grantId: "grant-parent", revoked: false, tokensUsed: 800, childCount: 0 }, runState: { runId: "run-1", maxTokens: 1200, tokensUsed: 0 } }))).toBe("BUDGET_EXCEEDED");
  });
});
