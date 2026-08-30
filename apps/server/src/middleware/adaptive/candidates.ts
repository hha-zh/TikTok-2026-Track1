/**
 * CandidateBuilder — enumerate the ways one node could be executed, and mark
 * each one legal or not.
 *
 * THIS FILE DECIDES NOTHING ABOUT AUTHORITY. Legality comes from the two
 * existing Hard Governance functions, used in their designed roles:
 *
 *   authorize()            capacity — may this principal do this at all
 *   deriveChildEnvelope()  scope    — is this particular scope within delegatable
 *
 * There is no second verdict path here and there must never be one. If a
 * candidate is illegal, the reason returned is verbatim the reason Hard
 * Governance gave; this module does not invent, soften or re-rank denials.
 */

import { authorize } from "../governance/authorize.js";
import { deriveChildEnvelope } from "../governance/delegation.js";
import { isResourceScopeSubset, matchesResourceScope } from "../governance/scope.js";
import type {
  Decision,
  Envelope,
  GovernanceState,
  Principal,
  ReasonCode,
} from "../governance/types.js";
import { deriveExecutionEnvelope, type ExecutionEnvelope, type ExecutionPolicy } from "./execution-envelope.js";
import type { TaskSpec } from "./task-graph.js";

/** Where the work runs. */
export type Placement = "REUSE_CURRENT" | "DELEGATE_SPECIALIST";

/**
 * Why a candidate is or is not permitted.
 *
 * DERIVED AND EXPLANATORY. Not an authority source: `legal` and `reason` are
 * copied verbatim from `authorize()` / `deriveChildEnvelope()` and nothing here
 * decides anything. Its purpose is that a denial can be explained on the
 * authority axis specifically, instead of collapsing into "unavailable".
 */
export interface AuthorityView {
  legal: boolean;
  /** The untouched hard ReasonCode when legality fails. */
  reason: ReasonCode;
  detail?: string | undefined;
  /** What the task needs. */
  requiredResources: string[];
  requiredActions: string[];
  /** Invocation-scoped effective authority. Never the whole parent grant. */
  effectiveResources: string[];
  effectiveActions: string[];
  /**
   * True when running this task through a delegated child would execute it
   * against a strictly smaller reachable surface. See `structurallyNarrower`.
   */
  structurallyNarrower: boolean;
}

/** Why a candidate can or cannot be afforded. Peer axis to authority. */
export interface BudgetView {
  grantTokensRemaining: number;
  runTokensRemaining: number;
  /** min of the two: what the work can actually draw on. */
  effectiveTokensRemaining: number;
  /** DECLARED planning estimate. Never reserved, never persisted as usage. */
  estimatedTokens: number;
  tokenAffordable: boolean;
  // Remaining execution horizon: how much further this run may expand.
  childSlotsRemaining: number;
  depthRemaining: number;
  parallelCapacity: number;
  /** 1 - runRemaining/runCap. RUN scarcity only, never derived from the min. */
  runPressure: number;
  affordable: boolean;
  /** Typed runtime metadata, deliberately NOT a hard ReasonCode. */
  reason: BudgetReason;
}

export type BudgetReason =
  | "AFFORDABLE"
  | "TOKENS_EXHAUSTED"
  | "CHILD_CAPACITY_EXHAUSTED"
  | "DEPTH_EXHAUSTED";

export interface Candidate {
  nodeId: string;
  placement: Placement;
  estimatedTokens: number;
  /**
   * Feasible = Authorized AND Affordable.
   *
   * The router may soft-rank feasible candidates only. Neither axis can rescue
   * the other: spare budget never creates permission, and permission never
   * creates capacity.
   */
  feasible: boolean;
  authority: AuthorityView;
  budget: BudgetView;
  /** Mirrors `authority.legal`. Kept so existing call sites read naturally. */
  legal: boolean;
  /** Mirrors `authority.reason`. */
  reason: ReasonCode;
  detail?: string | undefined;
  /**
   * The per-task narrowed view, present on the REUSE path only. Delegated work
   * gets a real child grant from `deriveChildEnvelope` instead.
   *
   * Carried for the ContextBroker and the engine. It is a view, not a verdict:
   * nothing downstream may treat it as permission.
   */
  executionEnvelope?: ExecutionEnvelope | undefined;
}

export interface CandidateContext {
  principal: Principal;
  state: GovernanceState;
  /** Injected so candidate building stays deterministic and testable. */
  now: string;
  /**
   * Concurrent invocations the runtime will actually start. Not derivable from
   * governance state, so the engine supplies it; defaults to 1.
   */
  parallelCapacity?: number | undefined;
  /** Optional run-level narrowing folded into the invocation envelope. */
  policy?: ExecutionPolicy | undefined;
  childGrantId?: string | undefined;
  childPrincipalId?: string | undefined;
}


// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

/**
 * Would delegating execute this task against a strictly smaller surface?
 *
 * Conservative, and built on the existing scope semantics rather than counting
 * array entries - `app/*` is one string and reaches far more than `UIPlan`.
 *
 * Requires BOTH:
 *   no escalation  every child resource and action already sits somewhere in
 *                  the parent's own authority (exercisable or delegatable), so
 *                  a child can never look "narrower" by gaining something new
 *   strictly less  the child cannot reach some resource the parent can
 *                  exercise, or cannot delegate onward while the parent can
 *
 * The child may legitimately hold an action the parent cannot EXERCISE - that
 * is the exercisable/delegatable design, and such an action is still
 * pre-authorized by the parent's delegatable set, so it is not escalation.
 */
export function isStructurallyNarrower(
  child: { resources: readonly string[]; actions: readonly string[] },
  parent: Envelope,
): boolean {
  const parentResources = [
    ...parent.exercisable.resources,
    ...parent.delegatable.resources,
  ];
  const parentActions = [...parent.exercisable.actions, ...parent.delegatable.actions];

  const noResourceEscalation = child.resources.every((resource) =>
    isResourceScopeSubset(resource, parentResources),
  );
  const noActionEscalation = child.actions.every((action) =>
    parentActions.includes(action),
  );
  if (!noResourceEscalation || !noActionEscalation) return false;

  const unreachableByChild = parent.exercisable.resources.some(
    (resource) =>
      !child.resources.some((scope) => matchesResourceScope(resource, scope)),
  );
  const losesOnwardDelegation =
    parent.depth > 0 && parent.delegatable.resources.length > 0;

  return unreachableByChild || losesOnwardDelegation;
}

/**
 * The remaining execution horizon for one candidate.
 *
 * Token numbers come from the existing truthful accounting; the capacity
 * numbers are the constraints the runtime already enforces. Exposing them here
 * moves no enforcement out of governance - it only makes "how much further may
 * this run expand?" answerable in one place.
 */
function budgetViewFor(
  node: TaskSpec,
  context: CandidateContext,
  placement: Placement,
): BudgetView {
  const { envelope, grantState, runState } = context.state;
  const grantTokensRemaining = envelope.maxTokens - grantState.tokensUsed;
  const runTokensRemaining = runState.maxTokens - runState.tokensUsed;
  const effectiveTokensRemaining = Math.min(grantTokensRemaining, runTokensRemaining);
  const childSlotsRemaining = envelope.maxChildren - grantState.childCount;
  const depthRemaining = envelope.depth;
  const parallelCapacity = context.parallelCapacity ?? 1;

  const tokenAffordable = node.estimatedTokens <= effectiveTokensRemaining;
  const needsExpansion = placement === "DELEGATE_SPECIALIST";
  const slotsOk = !needsExpansion || childSlotsRemaining > 0;
  const depthOk = !needsExpansion || depthRemaining > 0;

  const reason: BudgetReason = !tokenAffordable
    ? "TOKENS_EXHAUSTED"
    : !slotsOk
      ? "CHILD_CAPACITY_EXHAUSTED"
      : !depthOk
        ? "DEPTH_EXHAUSTED"
        : "AFFORDABLE";

  return {
    grantTokensRemaining,
    runTokensRemaining,
    effectiveTokensRemaining,
    estimatedTokens: node.estimatedTokens,
    tokenAffordable,
    childSlotsRemaining,
    depthRemaining,
    parallelCapacity,
    // RUN scarcity only. Never effectiveRemaining / runCap.
    runPressure:
      runState.maxTokens > 0
        ? Math.min(1, Math.max(0, 1 - runTokensRemaining / runState.maxTokens))
        : 1,
    affordable: tokenAffordable && slotsOk && depthOk,
    reason,
  };
}

function firstDenial(decisions: Decision[]): Decision | undefined {
  return decisions.find((decision) => decision.verdict === "DENY");
}

/**
 * Can the current principal do this itself? Every (action, resource) pair the
 * node needs has to pass, so a node that reads two resources is legal only if
 * both are exercisable.
 */
function reuseCurrent(node: TaskSpec, context: CandidateContext): Candidate {
  const decisions: Decision[] = [];
  for (const action of node.actions) {
    if (node.resources.length === 0) {
      decisions.push(authorize(context.principal, action, null, context.state));
      continue;
    }
    for (const resource of node.resources) {
      decisions.push(authorize(context.principal, action, resource, context.state));
    }
  }
  const denial = firstDenial(decisions);
  // Γ_i = Γ_principal ∩ Γ_task ∩ Γ_policy, built whether or not the candidate
  // is legal: an operator should be able to see what the task would have been
  // scoped to even when it was refused.
  const envelope = deriveExecutionEnvelope({
    state: context.state,
    task: node,
    policy: context.policy,
  });
  const authority: AuthorityView = {
    legal: denial === undefined,
    reason: denial ? denial.reason : "AUTHORIZED",
    ...(denial?.detail ? { detail: denial.detail } : {}),
    requiredResources: [...node.resources],
    requiredActions: [...node.actions],
    effectiveResources: [...envelope.effective.resources],
    effectiveActions: [...envelope.effective.actions],
    // The reuse option is the baseline being compared against, never narrower
    // than itself.
    structurallyNarrower: false,
  };
  const budget = budgetViewFor(node, context, "REUSE_CURRENT");
  return {
    nodeId: node.id,
    placement: "REUSE_CURRENT",
    estimatedTokens: node.estimatedTokens,
    feasible: authority.legal && budget.affordable,
    authority,
    budget,
    legal: authority.legal,
    reason: authority.reason,
    ...(authority.detail ? { detail: authority.detail } : {}),
    executionEnvelope: envelope,
  };
}

/**
 * Can the current principal cause a child to do it?
 *
 * Two questions, two functions, in that order — capacity before scope. Asking
 * them the other way round would report CHILD_EXCEEDS_PARENT for a principal
 * that had simply run out of delegation depth, which is a misleading denial.
 */
function delegateSpecialist(node: TaskSpec, context: CandidateContext): Candidate {
  // The scope a delegated executor would actually receive: possibly wider than
  // the task's own needs, because it has to publish its result back.
  const requested = node.delegatedAuthority ?? {
    resources: node.resources,
    actions: node.actions,
  };
  const budget = budgetViewFor(node, context, "DELEGATE_SPECIALIST");
  const narrower = isStructurallyNarrower(requested, context.state.envelope);
  const baseAuthority = {
    requiredResources: [...requested.resources],
    requiredActions: [...requested.actions],
    // A preview only. No principal, envelope, grant, agent, token, workspace
    // or artifact is created here; the real child comes from the live
    // delegation path at dispatch time.
    effectiveResources: [...requested.resources],
    effectiveActions: [...requested.actions],
    structurallyNarrower: narrower,
  };

  const capacity = authorize(context.principal, "delegate", null, context.state);
  if (capacity.verdict === "DENY") {
    const authority: AuthorityView = {
      ...baseAuthority,
      legal: false,
      reason: capacity.reason,
      ...(capacity.detail ? { detail: capacity.detail } : {}),
    };
    return {
      nodeId: node.id,
      placement: "DELEGATE_SPECIALIST",
      estimatedTokens: node.estimatedTokens,
      feasible: false,
      authority,
      budget,
      legal: false,
      reason: capacity.reason,
      ...(capacity.detail ? { detail: capacity.detail } : {}),
    };
  }

  const derivation = deriveChildEnvelope(
    context.state.envelope,
    {
      exercisable: { resources: [...requested.resources], actions: [...requested.actions] },
      delegatable: { resources: [], actions: [] },
      maxTokens: node.estimatedTokens,
      maxToolCalls: context.state.envelope.maxToolCalls,
      maxChildren: 0,
    },
    {
      // Probe ids: this derivation is a feasibility check, and the envelope it
      // produces is discarded. The real one is minted by the delegation
      // service at execution time.
      id: context.childGrantId ?? "candidate-probe-grant",
      principalId: context.childPrincipalId ?? "candidate-probe-principal",
      createdAt: context.now,
    },
  );

  const authority: AuthorityView = {
    ...baseAuthority,
    legal: derivation.ok,
    reason: derivation.ok ? "AUTHORIZED" : derivation.reason,
  };
  return {
    nodeId: node.id,
    placement: "DELEGATE_SPECIALIST",
    estimatedTokens: node.estimatedTokens,
    feasible: authority.legal && budget.affordable,
    authority,
    budget,
    legal: authority.legal,
    reason: authority.reason,
  };
}

/**
 * Both placements, each annotated with its verdict. Illegal candidates are
 * returned rather than filtered out: the Run Inspector should be able to show
 * *why* a route was not taken, and a denial that never reaches the ledger
 * produces an empty timeline on stage.
 */
export function buildCandidates(
  node: TaskSpec,
  context: CandidateContext,
): Candidate[] {
  return [reuseCurrent(node, context), delegateSpecialist(node, context)];
}

export function legalCandidates(candidates: Candidate[]): Candidate[] {
  return candidates.filter((candidate) => candidate.legal);
}

/** Feasible = Authorized AND Affordable. The only set the router may rank. */
export function feasibleCandidates(candidates: Candidate[]): Candidate[] {
  return candidates.filter((candidate) => candidate.feasible);
}
