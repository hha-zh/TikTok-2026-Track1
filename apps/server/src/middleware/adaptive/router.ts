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
 */

import type { ReasonCode } from "../governance/types.js";
import type { Candidate, Placement } from "./candidates.js";
import type { TaskSpec } from "./task-graph.js";

export type Shape = "DIRECT" | "SERIAL" | "PARALLEL";

export type Disposition =
  | "RUN"
  /** Runs, but serialised where parallel was warranted. */
  | "DEGRADE"
  | "DEFER"
  | "SKIP"
  | "BLOCKED";

/**
 * Heuristic policy constants.
 *
 * DECLARED starting values, not learned or measured. They are injectable so a
 * deterministic scenario matrix can tune them later without touching routing
 * logic; nothing here is fitted to observed data and no claim should be made
 * that it is.
 */
export interface RouterPolicy {
  /** Score a delegation must clear at zero run-budget pressure. */
  baseThreshold: number;
  /** How much a fully consumed RUN budget raises that bar. */
  pressureWeight: number;
  /** Fraction of the effective budget a parallel wave may plan to spend. */
  parallelHeadroom: number;
  /** Guards the divide when a task declares zero incremental cost. */
  epsilon: number;
  /**
   * Weight added to the delegation score when a task DECLARES an isolation
   * preference AND the delegated scope is structurally narrower AND delegation
   * is already hard-legal. Zero in every other case.
   */
  isolationBonus: number;
}

export const DEFAULT_ROUTER_POLICY: RouterPolicy = {
  baseThreshold: 1,
  pressureWeight: 2,
  parallelHeadroom: 0.75,
  epsilon: 0.01,
  isolationBonus: 0.25,
};

export interface Assignment {
  nodeId: string;
  disposition: Disposition;
  placement: Placement | null;
  estimatedTokens: number;
  /** Present only when the disposition came from a governance denial. */
  governanceReason: ReasonCode | null;
  /** Adaptive rationale, always present. */
  note: string;
  delegationValue: number | null;
  delegationThreshold: number | null;
  /** DECLARED hint contribution. Zero unless isolation genuinely applies. */
  authorityIsolationGain: number | null;
  /**
   * Both axes for both placements, so a refusal is never flattened into
   * "unavailable" and an operator does not have to reconstruct why from
   * unrelated events.
   */
  candidateViews: CandidateAxes[];
  /** Index of the wave this task runs in. Null unless it runs. */
  wave: number | null;
}

/** One placement's two-axis summary, for evidence and later explanation. */
export interface CandidateAxes {
  placement: Placement;
  authorityLegal: boolean;
  authorityReason: ReasonCode;
  budgetAffordable: boolean;
  budgetReason: string;
  structurallyNarrower: boolean;
  feasible: boolean;
}

export interface RoutingWave {
  index: number;
  nodeIds: string[];
  /** True when this wave runs more than one task concurrently. */
  parallel: boolean;
}

export interface RoutingPlan {
  shape: Shape;
  assignments: Assignment[];
  /**
   * The unambiguous schedule. `shape` is a summary; the engine executes waves
   * in order and the tasks within a wave concurrently.
   */
  waves: RoutingWave[];
  plannedTokens: number;
  /** Effective budget left after this round's planned work. */
  effectiveBudgetRemaining: number;
  childSlotsRemaining: number;
  blocked: boolean;
  shapeReason: string;
}

export interface RoutingInputs {
  entries: { node: TaskSpec; candidates: Candidate[] }[];
  /**
   * min(grantRemaining, runRemaining). Feasibility and cost planning only —
   * this is what the work can actually draw on.
   */
  effectiveBudgetRemaining: number;
  /**
   * runCap - runUsed. Used ONLY to scale delegation pressure. Kept separate
   * because a nearly exhausted per-grant cap says nothing about how much room
   * the RUN has, and conflating them would raise the delegation bar for the
   * wrong reason.
   */
  runBudgetRemaining: number;
  runCapTokens: number;
  /** envelope.maxChildren - grantState.childCount. */
  childSlotsRemaining: number;
  /** Concurrent invocations the runtime will actually start. */
  parallelCapacity: number;
  policy?: Partial<RouterPolicy> | undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * Marginal benefit of spending extra agency on this task.
 *
 *   Value(delegate) = expectedUtilityGain / (cost fraction + epsilon)
 *
 * Cost is a fraction of the EFFECTIVE budget — what the work can really draw
 * on. Both inputs are declared by the graph author, never measured.
 */
export function authorityIsolationGain(
  node: TaskSpec,
  delegateCandidate: Candidate | undefined,
  policy: RouterPolicy = DEFAULT_ROUTER_POLICY,
): number {
  // All three must hold. A declared preference alone buys nothing, and this
  // can never make an illegal candidate attractive.
  if (node.hints?.isolationPreference !== "preferred") return 0;
  if (delegateCandidate?.authority.legal !== true) return 0;
  if (delegateCandidate.authority.structurallyNarrower !== true) return 0;
  return policy.isolationBonus;
}

export function delegationValue(
  node: TaskSpec,
  effectiveBudgetRemaining: number,
  policy: RouterPolicy = DEFAULT_ROUTER_POLICY,
  delegateCandidate?: Candidate | undefined,
): number {
  const declaredGain = node.hints?.expectedUtilityGain ?? 0;
  const isolationGain = authorityIsolationGain(node, delegateCandidate, policy);
  const gain = declaredGain + isolationGain;
  if (gain <= 0) return 0;
  const cost = node.hints?.expectedIncrementalCost ?? node.estimatedTokens;
  const costFraction = cost / Math.max(1, effectiveBudgetRemaining);
  return gain / (costFraction + policy.epsilon);
}

/**
 * The bar a delegation must clear, raised by RUN-budget pressure.
 *
 * Pressure is measured against the run, not the effective budget: delegating
 * spends the run's shared ceiling, so that is the scarcity that should make the
 * runtime reluctant to spawn another principal.
 */
export function delegationThreshold(
  runBudgetRemaining: number,
  runCapTokens: number,
  policy: RouterPolicy = DEFAULT_ROUTER_POLICY,
): number {
  const runPressure =
    runCapTokens > 0 ? clamp01(1 - runBudgetRemaining / runCapTokens) : 1;
  return policy.baseThreshold * (1 + policy.pressureWeight * runPressure);
}

function candidateFor(
  candidates: Candidate[],
  placement: Placement,
): Candidate | undefined {
  return candidates.find((candidate) => candidate.placement === placement);
}

function reportableDenial(candidates: Candidate[]): Candidate | undefined {
  return candidateFor(candidates, "REUSE_CURRENT") ?? candidates[0];
}

/** Both axes for both placements, carried on every assignment. */
function axesOf(candidates: Candidate[]): CandidateAxes[] {
  return candidates.map((candidate) => ({
    placement: candidate.placement,
    authorityLegal: candidate.authority.legal,
    authorityReason: candidate.authority.reason,
    budgetAffordable: candidate.budget.affordable,
    budgetReason: candidate.budget.reason,
    structurallyNarrower: candidate.authority.structurallyNarrower,
    feasible: candidate.feasible,
  }));
}

/**
 * Why nothing could run, on both axes.
 *
 * A candidate that is legal but unaffordable and one that is affordable but
 * illegal are different situations, and flattening them into "unavailable"
 * throws away exactly the information an operator needs.
 */
function infeasibilityNote(candidates: Candidate[]): string {
  return candidates
    .map(
      (candidate) =>
        `${candidate.placement}: authority ${
          candidate.authority.legal ? "legal" : candidate.authority.reason
        }, budget ${
          candidate.budget.affordable ? "affordable" : candidate.budget.reason
        }`,
    )
    .join("; ");
}

interface RunItem {
  nodeId: string;
  placement: Placement;
  independent: boolean;
  estimatedTokens: number;
}

/**
 * Pack runnable work into waves.
 *
 * Two tasks may share a wave only if they have DISTINCT executors and both are
 * declared independent. A delegated task gets its own child principal, so any
 * number are distinct; every REUSE task runs on the one current principal, so
 * at most one REUSE fits in a wave. That is why a REUSE and a DELEGATE can be
 * parallel while two REUSEs cannot.
 */
function packWaves(items: RunItem[], capacity: number): RunItem[][] {
  const waves: RunItem[][] = [];
  let current: RunItem[] = [];
  for (const item of items) {
    const canJoin =
      current.length > 0 &&
      current.length < Math.max(1, capacity) &&
      item.independent &&
      current.every((existing) => existing.independent) &&
      !(
        item.placement === "REUSE_CURRENT" &&
        current.some((existing) => existing.placement === "REUSE_CURRENT")
      );
    if (canJoin) {
      current.push(item);
    } else {
      if (current.length > 0) waves.push(current);
      current = [item];
    }
  }
  if (current.length > 0) waves.push(current);
  return waves;
}

export function route(inputs: RoutingInputs): RoutingPlan {
  const policy: RouterPolicy = { ...DEFAULT_ROUTER_POLICY, ...inputs.policy };
  const assignments: Assignment[] = [];
  let budget = inputs.effectiveBudgetRemaining;
  let slots = inputs.childSlotsRemaining;
  let blocked = false;
  const runItems: RunItem[] = [];

  for (const { node, candidates } of inputs.entries) {
    const reuse = candidateFor(candidates, "REUSE_CURRENT");
    const delegate = candidateFor(candidates, "DELEGATE_SPECIALIST");
    const views = axesOf(candidates);
    const isolationGain = authorityIsolationGain(node, delegate, policy);
    // Feasible = Authorized AND Affordable. Only feasible candidates may be
    // soft-ranked: spare budget never creates permission, and permission never
    // creates capacity.
    const reuseFeasible = reuse?.feasible === true;
    const delegateFeasible = delegate?.feasible === true;

    if (!reuseFeasible && !delegateFeasible) {
      const anyLegal = candidates.some((candidate) => candidate.authority.legal);
      const reason = reportableDenial(candidates)?.reason ?? "RESOURCE_NOT_GRANTED";
      const base = {
        nodeId: node.id,
        placement: null,
        estimatedTokens: node.estimatedTokens,
        // Only a genuine authority denial carries a hard ReasonCode. When the
        // authority axis was fine, this stays null and the note carries the
        // capacity explanation as typed runtime metadata.
        governanceReason: anyLegal ? null : reason,
        delegationValue: null,
        delegationThreshold: null,
        authorityIsolationGain: isolationGain,
        candidateViews: views,
        wave: null,
      };
      // Token affordability is an ESTIMATE; expansion capacity is a fact.
      // When every authority was legal and the only obstacle is a pessimistic
      // token estimate, the task waits for real usage under the engine's defer
      // ceiling. A spent child slot or delegation depth cannot change, so that
      // blocks immediately.
      const onlyTokenEstimate =
        anyLegal &&
        candidates.every(
          (candidate) =>
            !candidate.authority.legal ||
            candidate.budget.reason === "TOKENS_EXHAUSTED",
        );
      const note =
        (anyLegal
          ? onlyTokenEstimate
            ? "authorized, but the estimate does not fit the remaining budget"
            : "no feasible placement: authorized but expansion capacity is exhausted"
          : "no feasible placement: not authorized") +
        " — " +
        infeasibilityNote(candidates);
      if (node.optional) {
        assignments.push({ ...base, disposition: "SKIP", note });
      } else if (onlyTokenEstimate) {
        assignments.push({ ...base, disposition: "DEFER", note });
      } else {
        blocked = true;
        assignments.push({ ...base, disposition: "BLOCKED", note });
      }
      continue;
    }

    // --- WHO. A real choice when both are legal, not a fallback. ---
    let placement: Placement;
    let note: string;
    let value: number | null = null;
    let threshold: number | null = null;

    if (reuseFeasible && delegateFeasible) {
      value = delegationValue(node, budget, policy, delegate);
      threshold = delegationThreshold(
        inputs.runBudgetRemaining,
        inputs.runCapTokens,
        policy,
      );
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
    } else if (reuseFeasible) {
      placement = "REUSE_CURRENT";
      note =
        delegate?.authority.legal === true
          ? "delegation was authorized but not affordable"
          : "only the current principal may perform this";
    } else {
      placement = "DELEGATE_SPECIALIST";
      note =
        reuse?.authority.legal === true
          ? "reuse was authorized but not affordable"
          : "the current principal may cause this but not perform it";
    }

    if (placement === "DELEGATE_SPECIALIST" && slots <= 0) {
      if (!reuseFeasible) {
        assignments.push({
          nodeId: node.id,
          disposition: "DEFER",
          placement: null,
          estimatedTokens: node.estimatedTokens,
          governanceReason: null,
          note: "no child slots remaining and reuse is not feasible",
          delegationValue: value,
          delegationThreshold: threshold,
          authorityIsolationGain: isolationGain,
          candidateViews: views,
          wave: null,
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
        authorityIsolationGain: isolationGain,
        candidateViews: views,
        wave: null,
      };
      if (node.optional) {
        assignments.push({
          ...base,
          disposition: "SKIP",
          note: `optional task dropped: needs ${node.estimatedTokens}, ${budget} left`,
        });
      } else {
        // Estimates are pessimistic; a required task waits for real usage
        // rather than being declared impossible on an estimate alone. The
        // engine bounds how often this may repeat.
        assignments.push({
          ...base,
          disposition: "DEFER",
          note: `insufficient budget: needs ${node.estimatedTokens}, ${budget} left`,
        });
      }
      continue;
    }

    budget -= node.estimatedTokens;
    if (placement === "DELEGATE_SPECIALIST") slots -= 1;
    runItems.push({
      nodeId: node.id,
      placement,
      independent: node.hints?.independent === true,
      estimatedTokens: node.estimatedTokens,
    });
    assignments.push({
      nodeId: node.id,
      disposition: "RUN",
      placement,
      estimatedTokens: node.estimatedTokens,
      governanceReason: null,
      note,
      delegationValue: value,
      delegationThreshold: threshold,
      authorityIsolationGain: isolationGain,
      candidateViews: views,
      wave: null,
    });
  }

  // --- HOW. Decided on its own inputs, not inferred from WHO. ---
  const plannedTokens = runItems.reduce((total, item) => total + item.estimatedTokens, 0);
  const hasHeadroom =
    plannedTokens <= inputs.effectiveBudgetRemaining * policy.parallelHeadroom;

  // What the schedule would be with unlimited capacity and headroom.
  const idealWaves = packWaves(runItems, Number.POSITIVE_INFINITY);
  // What it is with the real limits. Without headroom, concurrency is withheld
  // entirely rather than half-applied.
  const waves = hasHeadroom
    ? packWaves(runItems, inputs.parallelCapacity)
    : runItems.map((item) => [item]);

  const idealWaveSize = new Map<string, number>();
  for (const wave of idealWaves) {
    for (const item of wave) idealWaveSize.set(item.nodeId, wave.length);
  }

  const byNodeId = new Map(assignments.map((assignment) => [assignment.nodeId, assignment]));
  waves.forEach((wave, index) => {
    for (const item of wave) {
      const assignment = byNodeId.get(item.nodeId);
      if (!assignment) continue;
      assignment.wave = index;
      // Work that could have shared a wave but did not is preserved and
      // serialised — never dropped.
      if (wave.length < (idealWaveSize.get(item.nodeId) ?? 1)) {
        assignment.disposition = "DEGRADE";
        assignment.note = hasHeadroom
          ? "serialised: parallel capacity exhausted"
          : "serialised: parallel was warranted but budget headroom was not";
      }
    }
  });

  const widest = waves.reduce((max, wave) => Math.max(max, wave.length), 0);
  let shape: Shape;
  let shapeReason: string;
  if (runItems.length <= 1) {
    shape = "DIRECT";
    shapeReason = "a single unit of work this round";
  } else if (widest > 1) {
    shape = "PARALLEL";
    shapeReason = `${waves.length} wave(s), widest ${widest}, distinct executors and declared independent`;
  } else {
    shape = "SERIAL";
    shapeReason = !hasHeadroom
      ? "serialised: insufficient budget headroom for concurrency"
      : inputs.parallelCapacity <= 1
        ? "serialised: parallel capacity is 1"
        : "serialised: no two tasks have distinct executors and declared independence";
  }

  return {
    shape,
    assignments,
    waves: waves.map((wave, index) => ({
      index,
      nodeIds: wave.map((item) => item.nodeId),
      parallel: wave.length > 1,
    })),
    plannedTokens,
    effectiveBudgetRemaining: budget,
    childSlotsRemaining: slots,
    blocked,
    shapeReason,
  };
}
