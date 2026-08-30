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
  /** Planning estimate only. Never reservation, never accounting. */
  estimatedTokens: number;
  /**
   * A task the overall result can survive without. Optional tasks are dropped
   * when unaffordable or not permitted; required ones block instead, because
   * silently omitting one produces a confident partial answer.
   */
  optional?: boolean | undefined;
  hints?: TaskRoutingHints | undefined;
}

export interface TaskGraph {
  id: string;
  nodes: TaskSpec[];
}

export type GraphProblem =
  | { kind: "duplicate_id"; nodeId: string }
  | { kind: "unknown_dependency"; nodeId: string; dependsOn: string }
  | { kind: "unproducible_artifact"; nodeId: string; artifact: string }
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

  const producible = new Set(graph.nodes.flatMap((node) => node.producedArtifacts));
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
  const producers = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const artifact of node.producedArtifacts) {
      producers.set(artifact, [...(producers.get(artifact) ?? []), node.id]);
    }
  }
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
}

const EMPTY_PROGRESS: GraphProgress = {
  completed: new Set<string>(),
  skipped: new Set<string>(),
};

/**
 * Artifacts that actually exist: produced by COMPLETED tasks only.
 *
 * Derived rather than tracked separately so the graph stays the single source
 * of truth about what has been produced.
 */
export function availableArtifacts(
  graph: TaskGraph,
  progress: GraphProgress = EMPTY_PROGRESS,
): Set<string> {
  const available = new Set<string>();
  for (const node of graph.nodes) {
    if (!progress.completed.has(node.id)) continue;
    for (const artifact of node.producedArtifacts) available.add(artifact);
  }
  return available;
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
