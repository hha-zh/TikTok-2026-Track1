/**
 * TaskGraph — the work an adaptive run has to get through.
 *
 * Pure data plus pure queries. It states what a task *needs*; whether that need
 * is permitted is answered by Hard Governance, never here.
 *
 *   Hard Governance defines the legal execution space.
 *   Adaptive Runtime chooses only inside that legal space.
 */

/**
 * Declared routing hints.
 *
 * These are DECLARED by whoever authored the graph, not observed telemetry. The
 * router treats them as an author's estimate and says so; nothing here is
 * measured, and no claim should be made that it is. Absent hints mean "no
 * evidence that extra agency is worth it", which resolves to REUSE_CURRENT.
 */
export interface TaskRoutingHints {
  /** Declared: this task wants a specialist context, not the generalist's. */
  specialistRequired?: boolean | undefined;
  /** Declared: safe to run concurrently with its sibling tasks. */
  independent?: boolean | undefined;
  /** Declared 0..1 estimate of what delegating would buy. Not measured. */
  expectedUtilityGain?: number | undefined;
  /** Declared token estimate of what delegating would cost. Not measured. */
  expectedIncrementalCost?: number | undefined;
}

export interface TaskSpec {
  id: string;
  description: string;
  /** Resources the task must read. Empty for pure reasoning steps. */
  resources: string[];
  /** Actions it must perform, e.g. "read", "model:invoke". */
  actions: string[];
  /** Task ids that must settle first. Ordering only. */
  dependsOn: string[];
  /**
   * Artifacts this task cannot run without. Unlike `dependsOn`, these are not
   * satisfied by a SKIPPED producer — a skipped task produces nothing.
   */
  requiredArtifacts: string[];
  /** Artifacts this task produces when it completes. */
  producedArtifacts: string[];
  /**
   * Expected Return-Gate type per produced artifact name, e.g.
   * `{ ui_plan: "UIPlan" }`.
   *
   * The trusted workload contract states this; the executor does not get to
   * redefine it. When a name appears here the engine requires the stored
   * artifact to be published AND of exactly this type, so an executor cannot
   * satisfy `ui_plan` by publishing something else it happens to be allowed to
   * publish.
   */
  producedArtifactTypes?: Record<string, string> | undefined;
  /** Planning estimate only. Never reservation, never accounting. */
  estimatedTokens: number;
  /**
   * A task the overall result can survive without. Optional tasks are dropped
   * when unaffordable or not permitted; required ones block instead, because
   * silently omitting one produces a confident partial answer.
   */
  optional?: boolean | undefined;
  hints?: TaskRoutingHints | undefined;
  /**
   * Authority a DELEGATED executor needs, when it differs from what the task
   * needs to run at all.
   *
   * Generic, not workload-specific: a delegated executor is a separate
   * principal, so returning a value to its parent costs publication authority
   * the parent never needs when it does the work itself. Without this the
   * delegate feasibility probe would test the wrong scope and a delegation
   * would look legal at planning time and fail at dispatch.
   */
  delegatedAuthority?: { resources: string[]; actions: string[] } | undefined;
}

export interface TaskGraph {
  id: string;
  nodes: TaskSpec[];
}

export type GraphProblem =
  | { kind: "duplicate_id"; nodeId: string }
  | { kind: "unknown_dependency"; nodeId: string; dependsOn: string }
  | { kind: "unproducible_artifact"; nodeId: string; artifact: string }
  | { kind: "duplicate_artifact_producer"; artifact: string; nodeIds: string[] }
  | { kind: "cycle"; nodeIds: string[] };

export type GraphValidation = { ok: true } | { ok: false; problems: GraphProblem[] };

/** Structural validation. A graph failing here cannot be scheduled at all. */
export function validateGraph(graph: TaskGraph): GraphValidation {
  const problems: GraphProblem[] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (seen.has(node.id)) problems.push({ kind: "duplicate_id", nodeId: node.id });
    seen.add(node.id);
  }

  // One producer per artifact name. Alternative producers would make the
  // ordering edges ambiguous - the cycle pass below treats every producer as a
  // dependency - so the MVP requires the mapping to be a function.
  const producersByArtifact = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const artifact of node.producedArtifacts) {
      producersByArtifact.set(artifact, [
        ...(producersByArtifact.get(artifact) ?? []),
        node.id,
      ]);
    }
  }
  for (const [artifact, nodeIds] of producersByArtifact) {
    if (nodeIds.length > 1) {
      problems.push({ kind: "duplicate_artifact_producer", artifact, nodeIds });
    }
  }

  const producible = new Set(producersByArtifact.keys());
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) {
      if (!seen.has(dependency)) {
        problems.push({ kind: "unknown_dependency", nodeId: node.id, dependsOn: dependency });
      }
    }
    for (const artifact of node.requiredArtifacts) {
      if (!producible.has(artifact)) {
        problems.push({ kind: "unproducible_artifact", nodeId: node.id, artifact });
      }
    }
  }

  // Cycle detection over BOTH edge kinds: an artifact requirement is as real an
  // ordering constraint as an explicit dependency.
  const producers = producersByArtifact;
  const remaining = new Map(
    graph.nodes.map((node) => [
      node.id,
      [
        ...node.dependsOn,
        ...node.requiredArtifacts.flatMap((artifact) => producers.get(artifact) ?? []),
      ],
    ]),
  );
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, edges] of remaining) {
      if (edges.every((edge) => !remaining.has(edge))) {
        remaining.delete(id);
        progressed = true;
      }
    }
  }
  if (remaining.size > 0) {
    problems.push({ kind: "cycle", nodeIds: [...remaining.keys()].sort() });
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

export interface GraphProgress {
  completed: ReadonlySet<string>;
  /** Dropped tasks. They settle the ordering edge but produce nothing. */
  skipped: ReadonlySet<string>;
  /**
   * Artifacts that ACTUALLY exist, committed by the engine after execution.
   *
   * The graph declares promises; this records reality. Deriving availability
   * from "the task says completed, so its declared outputs must exist" would
   * make the declaration its own evidence - a task could be marked complete
   * having produced nothing and everything downstream would proceed against
   * inputs that were never created.
   */
  artifacts: ReadonlySet<string>;
}

const EMPTY_PROGRESS: GraphProgress = {
  completed: new Set<string>(),
  skipped: new Set<string>(),
  artifacts: new Set<string>(),
};

/** Artifacts the engine has actually committed. */
export function availableArtifacts(
  _graph: TaskGraph,
  progress: GraphProgress = EMPTY_PROGRESS,
): Set<string> {
  return new Set(progress.artifacts);
}

/**
 * Promised artifacts a finished task did not actually produce.
 *
 * The engine must consult this BEFORE marking a task completed: execute ->
 * validate -> commit -> only then COMPLETED.
 */
export function missingPromisedArtifacts(
  node: TaskSpec,
  actuallyProduced: ReadonlySet<string>,
): string[] {
  return node.producedArtifacts.filter((artifact) => !actuallyProduced.has(artifact));
}

/**
 * Tasks that can run now.
 *
 * Two different edge semantics, deliberately:
 *
 *   dependsOn        settled by completion OR skip — it is ordering, so one
 *                    dropped optional task must not stall everything beneath it
 *   requiredArtifacts satisfied ONLY by completion — a skipped task produced
 *                    nothing, and pretending otherwise would run a downstream
 *                    task against an input that does not exist
 */
export function readyNodes(
  graph: TaskGraph,
  progress: GraphProgress = EMPTY_PROGRESS,
): TaskSpec[] {
  const settled = new Set<string>([...progress.completed, ...progress.skipped]);
  const available = availableArtifacts(graph, progress);
  return graph.nodes.filter(
    (node) =>
      !settled.has(node.id) &&
      node.dependsOn.every((dependency) => settled.has(dependency)) &&
      node.requiredArtifacts.every((artifact) => available.has(artifact)),
  );
}

/**
 * Tasks that can never become ready, because an artifact they require has no
 * remaining producer — its producer was skipped.
 *
 * The engine needs this: without it such a task simply never appears in the
 * ready set and the run looks stalled rather than blocked.
 */
export function unreachableNodes(
  graph: TaskGraph,
  progress: GraphProgress = EMPTY_PROGRESS,
): { node: TaskSpec; missingArtifacts: string[] }[] {
  const settled = new Set<string>([...progress.completed, ...progress.skipped]);
  const available = availableArtifacts(graph, progress);
  const stillProducible = new Set(
    graph.nodes
      .filter((node) => !settled.has(node.id))
      .flatMap((node) => node.producedArtifacts),
  );

  const unreachable: { node: TaskSpec; missingArtifacts: string[] }[] = [];
  for (const node of graph.nodes) {
    if (settled.has(node.id)) continue;
    const missing = node.requiredArtifacts.filter(
      (artifact) => !available.has(artifact) && !stillProducible.has(artifact),
    );
    if (missing.length > 0) unreachable.push({ node, missingArtifacts: missing });
  }
  return unreachable;
}

/** Outstanding tasks that are neither settled nor ready this round. */
export function pendingNodes(
  graph: TaskGraph,
  progress: GraphProgress = EMPTY_PROGRESS,
): TaskSpec[] {
  const settled = new Set<string>([...progress.completed, ...progress.skipped]);
  const ready = new Set(readyNodes(graph, progress).map((node) => node.id));
  return graph.nodes.filter((node) => !settled.has(node.id) && !ready.has(node.id));
}

export function isComplete(graph: TaskGraph, progress: GraphProgress): boolean {
  return graph.nodes.every(
    (node) => progress.completed.has(node.id) || progress.skipped.has(node.id),
  );
}

/** Fills the required fields so callers and tests can state only what matters. */
export function task(spec: Partial<TaskSpec> & { id: string }): TaskSpec {
  return {
    description: spec.description ?? "task " + spec.id,
    resources: spec.resources ?? [],
    actions: spec.actions ?? ["read"],
    dependsOn: spec.dependsOn ?? [],
    requiredArtifacts: spec.requiredArtifacts ?? [],
    producedArtifacts: spec.producedArtifacts ?? [],
    estimatedTokens: spec.estimatedTokens ?? 100,
    ...spec,
  };
}
