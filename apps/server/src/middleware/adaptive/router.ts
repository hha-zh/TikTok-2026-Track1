/**
 * Adaptive Router — decide how much agency is worth using, strictly inside the
 * legal space Hard Governance has already defined.
 *
 * The router never produces a verdict. Candidates arrive already marked legal
 * or illegal by `authorize()` / `deriveChildEnvelope()`; the router ranks the
 * legal ones and reports the rest verbatim. If this file ever needs to reason
 * about resources, actions or ancestry to decide whether something is
 * PERMITTED, that is a second authorization system appearing — stop and report.
 *
 * Two dimensions, kept independent:
 *
 *   WHO   REUSE_CURRENT | DELEGATE_SPECIALIST     executor strategy
 *   HOW   DIRECT | SERIAL | PARALLEL              execution mode
 *
 * HOW is not a consequence of WHO. Two independent delegations may still be
 * serialised when budget pressure makes concurrency unattractive, and a single
 * delegation is DIRECT rather than PARALLEL.
 */

import type { ReasonCode } from "../governance/types.js";
import type { Candidate, Placement } from "./candidates.js";
import type { TaskSpec } from "./task-graph.js";

export type Shape = "DIRECT" | "SERIAL" | "PARALLEL";

export type Disposition =
  /** Runs, as preferred. */
  | "RUN"
  /** Runs, but not as preferred — serialised where parallel was warranted. */
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
  /** Marginal-benefit score, when both placements were legal. */
  delegationValue: number | null;
  /** The bar that score had to clear, raised by budget pressure. */
  delegationThreshold: number | null;
}

export interface RoutingPlan {
  shape: Shape;
  assignments: Assignment[];
  /** Tokens the RUN and DEGRADE assignments are expected to consume. */
  plannedTokens: number;
  budgetRemaining: number;
  childSlotsRemaining: number;
  /** True when blocked on a required task it cannot execute. */
  blocked: boolean;
  /** Why this shape, in one line, for the Run Inspector. */
  shapeReason: string;
}

export interface RoutingInputs {
  entries: { node: TaskSpec; candidates: Candidate[] }[];
  /** min(grantCap - grantUsed, runCap - runUsed), computed by the caller. */
  budgetRemaining: number;
  /** The run ceiling, used only to scale budget pressure. */
  runCapTokens: number;
  /** envelope.maxChildren - grantState.childCount. */
  childSlotsRemaining: number;
}

/** Guards the divide when a task declares zero incremental cost. */
const EPSILON = 0.01;
/** Score a delegation must clear at zero budget pressure. */
const BASE_THRESHOLD = 1;
/** How much a fully consumed budget raises that bar. */
const PRESSURE_WEIGHT = 2;
/** Parallelism needs slack, not just permission. */
const PARALLEL_HEADROOM = 0.75;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * Marginal benefit of spending extra agency on this task.
 *
 *   Value(delegate) = expectedUtilityGain / (expectedIncrementalCost + ε)
 *
 * Cost is expressed as a fraction of what is actually left, so the same
 * declared cost weighs more heavily when the budget is nearly spent. Both
 * inputs are DECLARED by the graph author, never measured — nothing here is
 * telemetry and no claim should be made that it is.
 *
 * No hints means no evidence that extra agency is worthwhile, which scores 0
 * and resolves to REUSE_CURRENT.
 */
export function delegationValue(node: TaskSpec, budgetRemaining: number): number {
  const gain = node.hints?.expectedUtilityGain ?? 0;
  if (gain <= 0) return 0;
  const cost = node.hints?.expectedIncrementalCost ?? node.estimatedTokens;
  const costFraction = cost / Math.max(1, budgetRemaining);
  return gain / (costFraction + EPSILON);
}

/** Budget pressure raises the bar for spending extra agency. */
export function delegationThreshold(
  budgetRemaining: number,
  runCapTokens: number,
): number {
  const pressure =
    runCapTokens > 0 ? clamp01(1 - budgetRemaining / runCapTokens) : 1;
  return BASE_THRESHOLD * (1 + PRESSURE_WEIGHT * pressure);
}

function candidateFor(
  candidates: Candidate[],
  placement: Placement,
): Candidate | undefined {
  return candidates.find((candidate) => candidate.placement === placement);
}

/** The denial to report when nothing is legal: prefer the reuse path's reason. */
function reportableDenial(candidates: Candidate[]): Candidate | undefined {
  return candidateFor(candidates, "REUSE_CURRENT") ?? candidates[0];
}

export function route(inputs: RoutingInputs): RoutingPlan {
  const assignments: Assignment[] = [];
  let budget = inputs.budgetRemaining;
  let slots = inputs.childSlotsRemaining;
  let blocked = false;
  let runnable = 0;
  const delegated: string[] = [];

  for (const { node, candidates } of inputs.entries) {
    const reuse = candidateFor(candidates, "REUSE_CURRENT");
    const delegate = candidateFor(candidates, "DELEGATE_SPECIALIST");
    const reuseLegal = reuse?.legal === true;
    const delegateLegal = delegate?.legal === true;

    if (!reuseLegal && !delegateLegal) {
      const reason = reportableDenial(candidates)?.reason ?? "RESOURCE_NOT_GRANTED";
      const base = {
        nodeId: node.id,
        placement: null,
        estimatedTokens: node.estimatedTokens,
        governanceReason: reason,
        delegationValue: null,
        delegationThreshold: null,
      };
      if (node.optional) {
        assignments.push({
          ...base,
          disposition: "SKIP",
          note: "optional task dropped: no permitted placement",
        });
      } else {
        blocked = true;
        assignments.push({
          ...base,
          disposition: "BLOCKED",
          note: "required task has no permitted placement",
        });
      }
      continue;
    }

    // --- WHO. A real choice when both are legal, not a fallback. ---
    let placement: Placement;
    let note: string;
    let value: number | null = null;
    let threshold: number | null = null;

    if (reuseLegal && delegateLegal) {
      value = delegationValue(node, budget);
      threshold = delegationThreshold(budget, inputs.runCapTokens);
      if (node.hints?.specialistRequired) {
        placement = "DELEGATE_SPECIALIST";
        note = "specialist declared required and delegation is permitted";
      } else if (value >= threshold) {
        placement = "DELEGATE_SPECIALIST";
        note = `declared benefit ${value.toFixed(2)} clears threshold ${threshold.toFixed(2)}`;
      } else {
        placement = "REUSE_CURRENT";
        note =
          value > 0
            ? `declared benefit ${value.toFixed(2)} below threshold ${threshold.toFixed(2)}`
            : "no declared benefit to extra agency";
      }
    } else if (reuseLegal) {
      placement = "REUSE_CURRENT";
      note = "only the current principal may perform this";
    } else {
      placement = "DELEGATE_SPECIALIST";
      note = "the current principal may cause this but not perform it";
    }

    // Delegation needs a child slot. Without one, fall back to reuse when that
    // is also legal; otherwise the task waits rather than being dropped.
    if (placement === "DELEGATE_SPECIALIST" && slots <= 0) {
      if (!reuseLegal) {
        assignments.push({
          nodeId: node.id,
          disposition: "DEFER",
          placement: null,
          estimatedTokens: node.estimatedTokens,
          governanceReason: null,
          note: "no child slots remaining and reuse is not permitted",
          delegationValue: value,
          delegationThreshold: threshold,
        });
        continue;
      }
      placement = "REUSE_CURRENT";
      note = "delegation preferred but no child slots remain; reusing instead";
    }

    if (node.estimatedTokens > budget) {
      const base = {
        nodeId: node.id,
        placement: null,
        estimatedTokens: node.estimatedTokens,
        governanceReason: null,
        delegationValue: value,
        delegationThreshold: threshold,
      };
      if (node.optional) {
        assignments.push({
          ...base,
          disposition: "SKIP",
          note: `optional task dropped: needs ${node.estimatedTokens}, ${budget} left`,
        });
      } else {
        // Estimates are pessimistic, so a required task waits for real usage
        // rather than being declared impossible on an estimate alone.
        assignments.push({
          ...base,
          disposition: "DEFER",
          note: `insufficient budget: needs ${node.estimatedTokens}, ${budget} left`,
        });
      }
      continue;
    }

    budget -= node.estimatedTokens;
    runnable += 1;
    if (placement === "DELEGATE_SPECIALIST") {
      slots -= 1;
      delegated.push(node.id);
    }
    assignments.push({
      nodeId: node.id,
      disposition: "RUN",
      placement,
      estimatedTokens: node.estimatedTokens,
      governanceReason: null,
      note,
      delegationValue: value,
      delegationThreshold: threshold,
    });
  }

  // --- HOW. Decided on its own inputs, not inferred from WHO. ---
  const byId = new Map(inputs.entries.map((entry) => [entry.node.id, entry.node]));
  const independentDelegations = delegated.filter(
    (id) => byId.get(id)?.hints?.independent === true,
  );
  const plannedTokens = assignments
    .filter((item) => item.disposition === "RUN")
    .reduce((total, item) => total + item.estimatedTokens, 0);

  let shape: Shape = "DIRECT";
  let shapeReason = "a single unit of work this round";
  if (runnable > 1) {
    // Concurrency needs separate executors, declared independence, AND slack.
    const hasHeadroom = plannedTokens <= inputs.budgetRemaining * PARALLEL_HEADROOM;
    if (independentDelegations.length >= 2 && hasHeadroom) {
      shape = "PARALLEL";
      shapeReason = `${independentDelegations.length} independent delegations with budget headroom`;
    } else if (independentDelegations.length >= 2) {
      shape = "SERIAL";
      shapeReason = "independent delegations serialised: insufficient budget headroom";
      for (const assignment of assignments) {
        if (assignment.disposition === "RUN" && independentDelegations.includes(assignment.nodeId)) {
          assignment.disposition = "DEGRADE";
          assignment.note = "serialised: parallel was warranted but budget headroom was not";
        }
      }
    } else if (delegated.length >= 2) {
      shape = "SERIAL";
      shapeReason = "delegations not declared independent";
    } else {
      shape = "SERIAL";
      shapeReason = "one principal cannot run two units of work at once";
    }
  }

  return {
    shape,
    assignments,
    plannedTokens,
    budgetRemaining: budget,
    childSlotsRemaining: slots,
    blocked,
    shapeReason,
  };
}
