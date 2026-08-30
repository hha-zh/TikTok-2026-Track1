/**
 * Adaptive Router — choose how to execute the ready nodes, strictly inside the
 * legal space Hard Governance has already defined.
 *
 * The router never produces a verdict. Every input candidate arrives already
 * marked legal or illegal by `authorize()` / `deriveChildEnvelope()`, and the
 * router only ranks the legal ones and reports the rest verbatim. If this file
 * ever needs to reason about resources, actions or ancestry to decide whether
 * something is permitted, that is the signal a second authorization system is
 * being introduced — stop and report instead.
 *
 * What the router does own: preference between legal placements, batch shape,
 * and what to do when the budget or the child ceiling will not stretch.
 */

import type { ReasonCode } from "../governance/types.js";
import type { Candidate, Placement } from "./candidates.js";
import type { TaskNode } from "./task-graph.js";

export type Shape = "DIRECT" | "SERIAL" | "PARALLEL";

export type Disposition =
  /** Runs, as preferred. */
  | "RUN"
  /** Runs, but not as preferred — serialised where parallel was possible. */
  | "DEGRADE"
  /** Not this round. Dependencies or budget may allow it later. */
  | "DEFER"
  /** Dropped. Optional, and either unaffordable or not permitted. */
  | "SKIP"
  /** Required and impossible. The plan cannot honestly proceed. */
  | "BLOCKED";

export interface Assignment {
  nodeId: string;
  disposition: Disposition;
  placement: Placement | null;
  estimatedTokens: number;
  /** Present only when the disposition came from a governance denial. */
  governanceReason: ReasonCode | null;
  /** Adaptive rationale, always present. */
  note: string;
}

export interface RoutingPlan {
  shape: Shape;
  assignments: Assignment[];
  /** Tokens the RUN and DEGRADE assignments are expected to consume. */
  plannedTokens: number;
  budgetRemaining: number;
  childSlotsRemaining: number;
  /** True when the plan is blocked on a required node it cannot execute. */
  blocked: boolean;
}

export interface RoutingInputs {
  /** Ready nodes paired with the candidates built for them. */
  entries: { node: TaskNode; candidates: Candidate[] }[];
  /** min(grantCap - grantUsed, runCap - runUsed), computed by the caller. */
  budgetRemaining: number;
  /** envelope.maxChildren - grantState.childCount. */
  childSlotsRemaining: number;
}

/**
 * REUSE_CURRENT first when it is legal: it adds no principal, no grant and no
 * delegation round-trip. Delegation is the answer to "I am not allowed to do
 * this myself", not a default.
 */
function preferred(candidates: Candidate[]): Candidate | undefined {
  const legal = candidates.filter((candidate) => candidate.legal);
  return (
    legal.find((candidate) => candidate.placement === "REUSE_CURRENT") ?? legal[0]
  );
}

/** The denial to report when nothing is legal: prefer the reuse path's reason. */
function reportableDenial(candidates: Candidate[]): Candidate | undefined {
  return (
    candidates.find((candidate) => candidate.placement === "REUSE_CURRENT") ??
    candidates[0]
  );
}

export function route(inputs: RoutingInputs): RoutingPlan {
  const assignments: Assignment[] = [];
  let budget = inputs.budgetRemaining;
  let slots = inputs.childSlotsRemaining;
  let blocked = false;
  let delegations = 0;
  let runnable = 0;

  for (const { node, candidates } of inputs.entries) {
    const choice = preferred(candidates);

    if (!choice) {
      const denial = reportableDenial(candidates);
      const reason = denial?.reason ?? "RESOURCE_NOT_GRANTED";
      if (node.optional) {
        assignments.push({
          nodeId: node.id,
          disposition: "SKIP",
          placement: null,
          estimatedTokens: node.estimatedTokens,
          governanceReason: reason,
          note: "optional node dropped: no permitted placement",
        });
      } else {
        blocked = true;
        assignments.push({
          nodeId: node.id,
          disposition: "BLOCKED",
          placement: null,
          estimatedTokens: node.estimatedTokens,
          governanceReason: reason,
          note: "required node has no permitted placement",
        });
      }
      continue;
    }

    // Delegation needs a child slot. Without one, fall back to reuse if that is
    // also legal; otherwise the node waits rather than being dropped.
    let placement = choice.placement;
    if (placement === "DELEGATE_SPECIALIST" && slots <= 0) {
      const reuse = candidates.find(
        (candidate) => candidate.placement === "REUSE_CURRENT" && candidate.legal,
      );
      if (!reuse) {
        assignments.push({
          nodeId: node.id,
          disposition: "DEFER",
          placement: null,
          estimatedTokens: node.estimatedTokens,
          governanceReason: null,
          note: "no child slots remaining and reuse is not permitted",
        });
        continue;
      }
      placement = "REUSE_CURRENT";
    }

    if (node.estimatedTokens > budget) {
      if (node.optional) {
        assignments.push({
          nodeId: node.id,
          disposition: "SKIP",
          placement: null,
          estimatedTokens: node.estimatedTokens,
          governanceReason: null,
          note: `optional node dropped: needs ${node.estimatedTokens}, ${budget} left`,
        });
      } else {
        // Estimates are pessimistic, so a required node waits for real usage
        // rather than being declared impossible on an estimate alone.
        assignments.push({
          nodeId: node.id,
          disposition: "DEFER",
          placement: null,
          estimatedTokens: node.estimatedTokens,
          governanceReason: null,
          note: `insufficient budget: needs ${node.estimatedTokens}, ${budget} left`,
        });
      }
      continue;
    }

    budget -= node.estimatedTokens;
    runnable += 1;
    if (placement === "DELEGATE_SPECIALIST") {
      slots -= 1;
      delegations += 1;
    }
    assignments.push({
      nodeId: node.id,
      disposition: "RUN",
      placement,
      estimatedTokens: node.estimatedTokens,
      governanceReason: null,
      note:
        placement === "REUSE_CURRENT"
          ? "current principal is permitted to do this itself"
          : "delegated: the current principal may cause this but not perform it",
    });
  }

  // Shape follows from what was actually assigned. One principal cannot run two
  // things at once, so only delegated work can be parallel.
  let shape: Shape = "DIRECT";
  if (runnable > 1) {
    shape = delegations >= 2 ? "PARALLEL" : "SERIAL";
  }

  // Anything delegated beyond the parallel width still runs, but serialised.
  if (shape === "SERIAL" && delegations >= 2) {
    for (const assignment of assignments) {
      if (assignment.disposition === "RUN" && assignment.placement === "DELEGATE_SPECIALIST") {
        assignment.disposition = "DEGRADE";
        assignment.note = "serialised: parallel width unavailable";
      }
    }
  }

  const plannedTokens = assignments
    .filter(
      (assignment) =>
        assignment.disposition === "RUN" || assignment.disposition === "DEGRADE",
    )
    .reduce((total, assignment) => total + assignment.estimatedTokens, 0);

  return {
    shape,
    assignments,
    plannedTokens,
    budgetRemaining: budget,
    childSlotsRemaining: slots,
    blocked,
  };
}
