/**
 * ContextBroker — assemble the least context a task actually needs.
 *
 * NOT an authorization layer. Nothing here returns ALLOW or DENY; `authorize()`
 * against the grant remains the only verdict. This decides what to *show* a
 * task that has already been permitted to run.
 *
 * It includes an artifact only when all three hold:
 *
 *   1. the task actually requires it
 *   2. it has actually been committed
 *   3. it is visible through this invocation's context boundary
 *
 * Deliberately NOT built here: a memory system, run-transcript injection, or
 * any copying of protected backend resources. Protected resources are fetched
 * through the Resource Gate at execution time so every read crosses a gate and
 * lands on the ledger; staging them in context would route around that.
 *
 * ── The boundary that matters ──────────────────────────────────────────────
 *
 *   child raw output
 *         X                 never a parent ContextArtifact
 *         |
 *   Return Gate / published bounded artifact
 *         ↓
 *   ContextBroker
 *         ↓
 *   downstream task
 *
 * Runtime task artifacts and Bouncer Return-Gate artifacts are NOT the same
 * thing. A child's own task output carries the child's principal id, and own
 * output flows only DOWNWARD — to its producer and that producer's
 * descendants. A raw child result therefore cannot reach its parent by
 * construction; the only upward path is a published artifact naming the
 * recipient.
 *
 * Direction is the whole distinction:
 *
 *   parent -> child     briefing. The parent already holds the value and the
 *                       child is strictly narrower, so nothing is declassified.
 *   child -> parent     declassification. Requires the Return Gate.
 *   sibling -> sibling  neither is in the other's ancestry, so never.
 */

import type { ExecutionEnvelope } from "./execution-envelope.js";
import type { TaskSpec } from "./task-graph.js";

export type ContextArtifactOrigin =
  /** Produced by a task the executor itself ran. */
  | "own_task_output"
  /** Crossed the Return Gate as a bounded, schema-validated artifact. */
  | "published_finding";

export interface ContextArtifact {
  /** The artifact NAME used by the task graph. */
  id: string;
  origin: ContextArtifactOrigin;
  producedByPrincipalId: string;
  /** Return Gate recipients. Meaningful for `published_finding` only. */
  recipients?: string[] | undefined;
  /** Registered artifact type, for `published_finding`. Kept for evidence. */
  artifactType?: string | undefined;
  value: unknown;
}

export type WithheldReason =
  /** Available and visible, but this task does not require it. */
  | "NOT_REQUIRED"
  /** Required, but never committed. */
  | "NOT_AVAILABLE"
  /** Another principal's own task output. Never crosses directly. */
  | "NOT_VISIBLE_TO_EXECUTOR"
  /** Published, but this executor is not a declared recipient. */
  | "NOT_PUBLISHED_TO_EXECUTOR";

export interface IncludedArtifact {
  id: string;
  origin: ContextArtifactOrigin;
  value: unknown;
}

export interface WithheldArtifact {
  id: string;
  reason: WithheldReason;
  detail: string;
}

export interface ProjectedContext {
  taskId: string;
  executorPrincipalId: string;
  sourceGrantId: string;
  included: IncludedArtifact[];
  /** Everything considered and not included, with why. Evidence, not noise. */
  withheld: WithheldArtifact[];
  /**
   * Required artifacts the task cannot run without.
   *
   * Non-empty means the engine must not dispatch: the task would run against
   * inputs that do not exist, or that it is not entitled to see.
   */
  missingRequired: string[];
}

type Visibility =
  | { visible: true }
  | { visible: false; reason: WithheldReason; detail: string };

/**
 * Can this executor see this artifact?
 *
 * Own task output is visible to its producer and to that producer's
 * DESCENDANTS. A child may read what the parent that spawned it produced —
 * that is briefing, and the child is strictly narrower — but nothing flows the
 * other way, because a parent is never in its child's ancestry. Siblings see
 * neither the other's output for the same reason.
 */
function visibilityFor(
  artifact: ContextArtifact,
  executorPrincipalId: string,
  executorAncestry: readonly string[],
): Visibility {
  if (artifact.origin === "own_task_output") {
    if (
      artifact.producedByPrincipalId === executorPrincipalId ||
      executorAncestry.includes(artifact.producedByPrincipalId)
    ) {
      return { visible: true };
    }
    return {
      visible: false,
      reason: "NOT_VISIBLE_TO_EXECUTOR",
      detail:
        "raw task output belongs to " +
        artifact.producedByPrincipalId +
        ", which is not this executor or an ancestor of it; a value reaches a " +
        "principal outside that line only through the Return Gate",
    };
  }

  const recipients = artifact.recipients ?? [];
  if (recipients.includes(executorPrincipalId)) return { visible: true };
  return {
    visible: false,
    reason: "NOT_PUBLISHED_TO_EXECUTOR",
    detail:
      "published artifact does not name " + executorPrincipalId + " as a recipient",
  };
}

/**
 * Project the context for one invocation.
 *
 * @param available every artifact the run has committed so far. Anything not
 *   required by this task is withheld as NOT_REQUIRED rather than passed along,
 *   so context stays least-privilege by default rather than by remembering.
 */
export function projectContext(
  task: TaskSpec,
  envelope: ExecutionEnvelope,
  available: readonly ContextArtifact[],
  /**
   * Principals above this executor, nearest first. Supplied by the engine from
   * the real grant chain. Empty means "no ancestors", which is the strict
   * default — a caller that forgets it gets less context, never more.
   */
  executorAncestry: readonly string[] = [],
): ProjectedContext {
  const executorPrincipalId = envelope.executorPrincipalId;
  const required = new Set(task.requiredArtifacts);
  const included: IncludedArtifact[] = [];
  const withheld: WithheldArtifact[] = [];
  const missingRequired: string[] = [];

  const byId = new Map<string, ContextArtifact>();
  for (const artifact of available) {
    // Later commits of the same name win; the engine commits once per name.
    byId.set(artifact.id, artifact);
  }

  for (const artifactId of task.requiredArtifacts) {
    const artifact = byId.get(artifactId);
    if (!artifact) {
      missingRequired.push(artifactId);
      withheld.push({
        id: artifactId,
        reason: "NOT_AVAILABLE",
        detail: "required but not committed",
      });
      continue;
    }
    const visibility = visibilityFor(artifact, executorPrincipalId, executorAncestry);
    if (visibility.visible) {
      included.push({
        id: artifact.id,
        origin: artifact.origin,
        value: artifact.value,
      });
    } else {
      missingRequired.push(artifactId);
      withheld.push({
        id: artifactId,
        reason: visibility.reason,
        detail: visibility.detail,
      });
    }
  }

  for (const artifact of byId.values()) {
    if (required.has(artifact.id)) continue;
    withheld.push({
      id: artifact.id,
      reason: "NOT_REQUIRED",
      detail: "committed, but this task does not require it",
    });
  }

  return {
    taskId: task.id,
    executorPrincipalId,
    sourceGrantId: envelope.sourceGrantId,
    included,
    withheld,
    missingRequired,
  };
}
