/**
 * Invocation ExecutionEnvelope — the per-task effective view.
 *
 * Distinct from the Principal Grant, deliberately:
 *
 *   Envelope (governance)        authority SOURCE   — what a principal holds
 *   ExecutionEnvelope (this)     per-task VIEW      — what one task may use
 *
 *   Γ_i = Γ_principal ∩ Γ_task ∩ Γ_policy
 *
 * The point is that one principal can execute different tasks under different
 * narrowed scopes WITHOUT creating a child Agent. Collapsing this into the
 * grant would mean every task ran with the principal's full authority, and the
 * only way to narrow anything would be to spawn a child.
 *
 * TWO PROPERTIES THAT MUST HOLD:
 *
 *  1. It never expands. Every field is built by intersection, so the effective
 *     scope is a subset of the principal's exercisable scope by construction —
 *     not by a check that a future edit could skip.
 *
 *  2. It is NOT an authorization source. Nothing here returns ALLOW or DENY.
 *     `authorize()` remains the only verdict, and it is always asked against
 *     the grant, never against this view. This is a lens for planning and
 *     context scoping; it decides nothing.
 */

import { matchesResourceScope } from "../governance/scope.js";
import type { GovernanceState } from "../governance/types.js";
import type { TaskSpec } from "./task-graph.js";

/** Optional run-level narrowing applied on top of principal ∩ task. */
export interface ExecutionPolicy {
  resources?: string[] | undefined;
  actions?: string[] | undefined;
}

export interface EffectiveBudgetView {
  grantRemaining: number;
  runRemaining: number;
  /** min of the two. Mirrors Design §9; it does not re-decide it. */
  effectiveRemaining: number;
  /** 0 when untouched, 1 when exhausted. Drives adaptive pressure only. */
  pressure: number;
}

export interface ExecutionEnvelope {
  taskId: string;
  executorPrincipalId: string;
  /** The grant this view was narrowed FROM. Authority still lives there. */
  sourceGrantId: string;
  effective: {
    resources: string[];
    actions: string[];
  };
  budget: EffectiveBudgetView;
}

/** Task resources the principal scope actually permits, keeping the narrower id. */
function narrowResources(
  taskResources: readonly string[],
  principalScopes: readonly string[],
): string[] {
  return taskResources.filter((resource) =>
    principalScopes.some((scope) => matchesResourceScope(resource, scope)),
  );
}

function intersectActions(
  taskActions: readonly string[],
  principalActions: readonly string[],
): string[] {
  return taskActions.filter((action) => principalActions.includes(action));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/**
 * Build the per-task view for the CURRENT principal executing `task` itself.
 *
 * Delegated work does not use this: a child's authority comes from
 * `deriveChildEnvelope`, which is the governance path and mints a real grant.
 * This is the reuse-path lens.
 */
export function deriveExecutionEnvelope(input: {
  state: GovernanceState;
  task: TaskSpec;
  policy?: ExecutionPolicy | undefined;
}): ExecutionEnvelope {
  const { state, task, policy } = input;
  const principal = state.envelope.exercisable;

  // Γ_principal ∩ Γ_task, then ∩ Γ_policy when a policy narrows further.
  let resources = narrowResources(task.resources, principal.resources);
  let actions = intersectActions(task.actions, principal.actions);
  if (policy?.resources) {
    resources = narrowResources(resources, policy.resources);
  }
  if (policy?.actions) {
    actions = intersectActions(actions, policy.actions);
  }

  const grantRemaining = state.envelope.maxTokens - state.grantState.tokensUsed;
  const runRemaining = state.runState.maxTokens - state.runState.tokensUsed;
  const effectiveRemaining = Math.min(grantRemaining, runRemaining);
  const runCap = state.runState.maxTokens;

  return {
    taskId: task.id,
    executorPrincipalId: state.envelope.principalId,
    sourceGrantId: state.envelope.id,
    effective: { resources, actions },
    budget: {
      grantRemaining,
      runRemaining,
      effectiveRemaining,
      pressure: runCap > 0 ? clamp01(1 - effectiveRemaining / runCap) : 1,
    },
  };
}

/**
 * True when the view is a genuine subset of the grant it came from.
 *
 * Intersection already guarantees this; the assertion exists so that a future
 * edit which starts appending rather than filtering fails a test instead of
 * silently widening what a task may touch.
 */
export function isNarrowing(
  envelope: ExecutionEnvelope,
  state: GovernanceState,
): boolean {
  const principal = state.envelope.exercisable;
  const resourcesOk = envelope.effective.resources.every((resource) =>
    principal.resources.some((scope) => matchesResourceScope(resource, scope)),
  );
  const actionsOk = envelope.effective.actions.every((action) =>
    principal.actions.includes(action),
  );
  return resourcesOk && actionsOk;
}
