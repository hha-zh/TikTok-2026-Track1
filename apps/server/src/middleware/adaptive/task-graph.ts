/**
 * TaskGraph — the work an adaptive run has to get through.
 *
 * Pure data plus pure queries. It knows nothing about authority: what a node
 * *needs* is stated here, whether that need is permitted is answered by Hard
 * Governance. The boundary for the whole adaptive layer is:
 *
 *   Hard Governance defines the legal execution space.
 *   Adaptive Runtime chooses only inside that legal space.
 */

export interface TaskNode {
  id: string;
  description: string;
  /** Resources the node must read. Empty for pure reasoning steps. */
  resources: string[];
  /** Actions the node must perform, e.g. "read", "model:invoke". */
  actions: string[];
  /** Node ids that must complete first. */
  dependsOn: string[];
  /** Rough token cost. Used for ranking and budget feasibility, never for authority. */
  estimatedTokens: number;
  /**
   * A node the overall result can survive without. Optional nodes are dropped
   * when they are unaffordable or not permitted; required ones block instead,
   * because silently omitting them would produce a confident partial answer.
   */
  optional?: boolean | undefined;
}

export interface TaskGraph {
  id: string;
  nodes: TaskNode[];
}

export type GraphProblem =
  | { kind: "duplicate_id"; nodeId: string }
  | { kind: "unknown_dependency"; nodeId: string; dependsOn: string }
  | { kind: "cycle"; nodeIds: string[] };

export type GraphValidation =
  | { ok: true }
  | { ok: false; problems: GraphProblem[] };

/**
 * Structural validation only. A graph that fails here cannot be scheduled at
 * all, which is a different failure from a node being disallowed.
 */
export function validateGraph(graph: TaskGraph): GraphValidation {
  const problems: GraphProblem[] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (seen.has(node.id)) problems.push({ kind: "duplicate_id", nodeId: node.id });
    seen.add(node.id);
  }
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) {
      if (!seen.has(dependency)) {
        problems.push({
          kind: "unknown_dependency",
          nodeId: node.id,
          dependsOn: dependency,
        });
      }
    }
  }

  // Cycle detection by repeated removal of dependency-free nodes: whatever
  // remains is exactly the set that can never become ready.
  const remaining = new Map(graph.nodes.map((node) => [node.id, [...node.dependsOn]]));
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, dependencies] of remaining) {
      if (dependencies.every((dependency) => !remaining.has(dependency))) {
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
  /** Nodes dropped as unaffordable or not permitted; they never become ready. */
  skipped: ReadonlySet<string>;
}

const EMPTY_PROGRESS: GraphProgress = {
  completed: new Set<string>(),
  skipped: new Set<string>(),
};

/**
 * Nodes whose dependencies are all satisfied and which have not run yet.
 *
 * A dependency satisfied by a SKIPPED node still counts as satisfied — the
 * plan chose to proceed without it, so its dependents are not held hostage.
 * Blocking there instead would turn one dropped optional node into a stalled
 * graph.
 */
export function readyNodes(
  graph: TaskGraph,
  progress: GraphProgress = EMPTY_PROGRESS,
): TaskNode[] {
  const settled = new Set<string>([...progress.completed, ...progress.skipped]);
  return graph.nodes.filter(
    (node) =>
      !settled.has(node.id) &&
      node.dependsOn.every((dependency) => settled.has(dependency)),
  );
}

/** Nodes still outstanding once the ready set is taken out. */
export function pendingNodes(
  graph: TaskGraph,
  progress: GraphProgress = EMPTY_PROGRESS,
): TaskNode[] {
  const settled = new Set<string>([...progress.completed, ...progress.skipped]);
  const ready = new Set(readyNodes(graph, progress).map((node) => node.id));
  return graph.nodes.filter((node) => !settled.has(node.id) && !ready.has(node.id));
}

export function isComplete(graph: TaskGraph, progress: GraphProgress): boolean {
  return graph.nodes.every(
    (node) => progress.completed.has(node.id) || progress.skipped.has(node.id),
  );
}
