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
import type { Decision, GovernanceState, Principal, ReasonCode } from "../governance/types.js";
import { deriveExecutionEnvelope, type ExecutionEnvelope, type ExecutionPolicy } from "./execution-envelope.js";
import type { TaskSpec } from "./task-graph.js";

/** Where the work runs. */
export type Placement = "REUSE_CURRENT" | "DELEGATE_SPECIALIST";

export interface Candidate {
  nodeId: string;
  placement: Placement;
  estimatedTokens: number;
  legal: boolean;
  /** ALLOW when legal; otherwise the untouched reason from Hard Governance. */
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
  /** Optional run-level narrowing folded into the invocation envelope. */
  policy?: ExecutionPolicy | undefined;
  childGrantId?: string | undefined;
  childPrincipalId?: string | undefined;
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
  return {
    nodeId: node.id,
    placement: "REUSE_CURRENT",
    estimatedTokens: node.estimatedTokens,
    legal: denial === undefined,
    reason: denial ? denial.reason : "AUTHORIZED",
    ...(denial?.detail ? { detail: denial.detail } : {}),
    // Γ_i = Γ_principal ∩ Γ_task ∩ Γ_policy, built whether or not the candidate
    // is legal: the Run Inspector should be able to show what the task would
    // have been scoped to.
    executionEnvelope: deriveExecutionEnvelope({
      state: context.state,
      task: node,
      policy: context.policy,
    }),
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
  const capacity = authorize(context.principal, "delegate", null, context.state);
  if (capacity.verdict === "DENY") {
    return {
      nodeId: node.id,
      placement: "DELEGATE_SPECIALIST",
      estimatedTokens: node.estimatedTokens,
      legal: false,
      reason: capacity.reason,
      ...(capacity.detail ? { detail: capacity.detail } : {}),
    };
  }

  const derivation = deriveChildEnvelope(
    context.state.envelope,
    {
      exercisable: { resources: [...node.resources], actions: [...node.actions] },
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

  return {
    nodeId: node.id,
    placement: "DELEGATE_SPECIALIST",
    estimatedTokens: node.estimatedTokens,
    legal: derivation.ok,
    reason: derivation.ok ? "AUTHORIZED" : derivation.reason,
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
