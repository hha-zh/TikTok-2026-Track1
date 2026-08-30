/**
 * ExecutionEngine — drive a TaskGraph round by round.
 *
 * Owns execution and progress ONLY. It adds no governance surface and has no
 * ALLOW/DENY path of its own: every legality question is already answered by
 * `authorize()` / `deriveChildEnvelope()` inside the CandidateBuilder, and the
 * engine simply refuses to dispatch what the router did not mark runnable.
 *
 * Per round:
 *
 *   inspect actual progress + committed artifacts
 *     -> ready and unreachable tasks
 *     -> resolve the LATEST governance and budget state
 *     -> build legal candidates
 *     -> route WHO and HOW
 *     -> per assignment: re-resolve, derive a FRESH invocation envelope,
 *        project least context, execute, commit real artifacts, record real
 *        usage, then and only then mark completed
 *     -> re-resolve and re-route
 *
 * The candidate-level envelope is a PREVIEW for planning and the Run Inspector.
 * Dispatch always derives a fresh one from state re-read at that moment, so a
 * revocation or a newly exhausted run budget between planning and execution is
 * caught rather than rescued by a stale plan.
 */

import type { JsonStore } from "../../store.js";
import type { GovernanceLedger } from "../evidence/ledger.js";
import { ancestorPrincipalIds } from "../governance/artifacts.js";
import { resolveGrant } from "../governance/grant-resolver.js";
import type { GovernanceState, Principal, ReasonCode } from "../governance/types.js";
import { buildCandidates } from "./candidates.js";
import {
  projectContext,
  type ContextArtifact,
  type ProjectedContext,
} from "./context-broker.js";
import {
  deriveExecutionEnvelope,
  type ExecutionEnvelope,
  type ExecutionPolicy,
} from "./execution-envelope.js";
import {
  DEFAULT_ROUTER_POLICY,
  route,
  type Assignment,
  type RouterPolicy,
  type RoutingPlan,
} from "./router.js";
import {
  missingPromisedArtifacts,
  readyNodes,
  unreachableNodes,
  validateGraph,
  type GraphProgress,
  type TaskGraph,
  type TaskSpec,
} from "./task-graph.js";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface TaskUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TaskExecutionRequest {
  task: TaskSpec;
  envelope: ExecutionEnvelope;
  context: ProjectedContext;
  placement: "REUSE_CURRENT" | "DELEGATE_SPECIALIST";
}

export interface ProducedArtifact {
  /** The artifact NAME the task graph uses. */
  id: string;
  value: unknown;
  /**
   * Set when the value crossed the Return Gate.
   *
   * A delegated executor is a separate principal, so its raw output can never
   * become a parent context artifact. Publishing is the only path, and the
   * engine VERIFIES the claim against the store rather than believing the
   * executor - see commitArtifacts.
   */
  publishedArtifactId?: string | undefined;
}

export interface TaskExecutionResult {
  ok: boolean;
  /** What the task ACTUALLY produced. The graph only declared a promise. */
  producedArtifacts: ProducedArtifact[];
  usage: TaskUsage;
  error?: string | undefined;
}

export interface TaskExecutor {
  execute(request: TaskExecutionRequest): Promise<TaskExecutionResult>;
}

export type DelegationOutcome =
  | { ok: true; childPrincipalId: string; grantId: string }
  | { ok: false; reason: ReasonCode };

/** The existing delegation path, behind an interface so the engine stays pure. */
export interface DelegationPort {
  delegate(input: {
    parentPrincipal: Principal;
    parentGrantId: string;
    runId: string;
    task: TaskSpec;
  }): Promise<DelegationOutcome>;
}

// ---------------------------------------------------------------------------
// Policy and result
// ---------------------------------------------------------------------------

export interface EnginePolicy {
  /**
   * How often one required task may be DEFERred before the run gives up.
   *
   * A required task cannot wait forever on "the estimate may fit later" when
   * nothing is changing; without a ceiling that is a livelock.
   */
  maxDeferPerTask: number;
  /** Backstop against a graph that never settles. */
  maxRounds: number;
  /** Concurrent invocations the runtime will actually start. */
  parallelCapacity: number;
}

export const DEFAULT_ENGINE_POLICY: EnginePolicy = {
  maxDeferPerTask: 3,
  maxRounds: 50,
  parallelCapacity: 2,
};

export type RunOutcome =
  | "COMPLETED"
  | "BLOCKED"
  | "DEFER_CEILING"
  | "UNREACHABLE"
  | "ROUND_LIMIT"
  | "EXECUTION_FAILED";

export interface RoundRecord {
  index: number;
  plan: RoutingPlan;
  executed: {
    taskId: string;
    placement: string;
    completed: boolean;
    usage: TaskUsage;
    note: string;
  }[];
}

export interface EngineFailure {
  taskId: string;
  reason: string;
  governanceReason?: ReasonCode | null | undefined;
}

export interface EngineResult {
  outcome: RunOutcome;
  progress: GraphProgress;
  artifacts: ContextArtifact[];
  rounds: RoundRecord[];
  failures: EngineFailure[];
}

export interface EngineDependencies {
  store: JsonStore;
  ledger: GovernanceLedger;
  executor: TaskExecutor;
  delegation: DelegationPort;
  policy?: Partial<EnginePolicy> | undefined;
  routerPolicy?: Partial<RouterPolicy> | undefined;
  executionPolicy?: ExecutionPolicy | undefined;
  now?: (() => string) | undefined;
}

export interface EngineIdentity {
  principal: Principal;
  grantId: string;
  runId: string;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class ExecutionEngine {
  private readonly policy: EnginePolicy;
  private readonly routerPolicy: RouterPolicy;
  /** Monotonic within a run, so invocation ids are unique and traceable. */
  private invocations = 0;

  constructor(private readonly dependencies: EngineDependencies) {
    this.policy = { ...DEFAULT_ENGINE_POLICY, ...dependencies.policy };
    this.routerPolicy = { ...DEFAULT_ROUTER_POLICY, ...dependencies.routerPolicy };
  }

  private now(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }

  /** Fresh state, every time. Never cached across a dispatch boundary. */
  private resolve(principalId: string, grantId: string, runId: string) {
    return resolveGrant({ principalId, grantId, runId }, this.dependencies.store, this.now());
  }

  async run(graph: TaskGraph, identity: EngineIdentity): Promise<EngineResult> {
    const completed = new Set<string>();
    const skipped = new Set<string>();
    const artifactNames = new Set<string>();
    const artifacts: ContextArtifact[] = [];
    const rounds: RoundRecord[] = [];
    const failures: EngineFailure[] = [];
    const deferCounts = new Map<string, number>();

    const structure = validateGraph(graph);
    if (!structure.ok) {
      return {
        outcome: "BLOCKED",
        progress: { completed, skipped, artifacts: artifactNames },
        artifacts,
        rounds,
        failures: structure.problems.map((problem) => ({
          taskId: "nodeId" in problem ? problem.nodeId : graph.id,
          reason: "graph invalid: " + problem.kind,
        })),
      };
    }

    const progress = (): GraphProgress => ({
      completed,
      skipped,
      artifacts: artifactNames,
    });
    const finish = (outcome: RunOutcome): EngineResult => ({
      outcome,
      progress: progress(),
      artifacts,
      rounds,
      failures,
    });

    for (let index = 0; index < this.policy.maxRounds; index += 1) {
      const settledBefore = completed.size + skipped.size;
      if (settledBefore === graph.nodes.length) return finish("COMPLETED");

      // A task whose producer was skipped can never become ready. Report it as
      // blocked rather than letting the run look stalled.
      const unreachable = unreachableNodes(graph, progress());
      const requiredUnreachable = unreachable.filter((entry) => !entry.node.optional);
      for (const entry of unreachable) {
        if (entry.node.optional) {
          skipped.add(entry.node.id);
        }
      }
      if (requiredUnreachable.length > 0) {
        for (const entry of requiredUnreachable) {
          failures.push({
            taskId: entry.node.id,
            reason: "required artifacts can no longer be produced: " +
              entry.missingArtifacts.join(", "),
          });
        }
        return finish("UNREACHABLE");
      }

      const ready = readyNodes(graph, progress());
      if (ready.length === 0) {
        return finish(completed.size + skipped.size === graph.nodes.length
          ? "COMPLETED"
          : "BLOCKED");
      }

      // Latest state, at the top of every round.
      const resolution = this.resolve(
        identity.principal.id,
        identity.grantId,
        identity.runId,
      );
      if (!resolution.ok) {
        failures.push({ taskId: graph.id, reason: "grant unresolvable: " + resolution.reason });
        return finish("BLOCKED");
      }
      const state = resolution.state;

      const plan = route({
        entries: ready.map((node) => ({
          node,
          candidates: buildCandidates(node, {
            principal: identity.principal,
            state,
            now: this.now(),
            ...(this.dependencies.executionPolicy
              ? { policy: this.dependencies.executionPolicy }
              : {}),
          }),
        })),
        effectiveBudgetRemaining: effectiveRemaining(state),
        runBudgetRemaining: state.runState.maxTokens - state.runState.tokensUsed,
        runCapTokens: state.runState.maxTokens,
        childSlotsRemaining: state.envelope.maxChildren - state.grantState.childCount,
        parallelCapacity: this.policy.parallelCapacity,
        policy: this.routerPolicy,
      });

      const record: RoundRecord = { index, plan, executed: [] };
      rounds.push(record);

      // --- dispositions that settle without executing ---
      for (const assignment of plan.assignments) {
        if (assignment.disposition === "SKIP") {
          skipped.add(assignment.nodeId);
        }
        if (assignment.disposition === "BLOCKED") {
          failures.push({
            taskId: assignment.nodeId,
            reason: assignment.note,
            governanceReason: assignment.governanceReason,
          });
        }
        if (assignment.disposition === "DEFER") {
          const count = (deferCounts.get(assignment.nodeId) ?? 0) + 1;
          deferCounts.set(assignment.nodeId, count);
          if (count > this.policy.maxDeferPerTask) {
            const node = graph.nodes.find((item) => item.id === assignment.nodeId);
            if (node?.optional) {
              skipped.add(assignment.nodeId);
            } else {
              failures.push({
                taskId: assignment.nodeId,
                reason:
                  `deferred ${count} times, ceiling ${this.policy.maxDeferPerTask}: ` +
                  assignment.note,
              });
              return finish("DEFER_CEILING");
            }
          }
        }
      }
      if (plan.blocked) return finish("BLOCKED");

      // --- execute the waves in order ---
      const byId = new Map(plan.assignments.map((item) => [item.nodeId, item]));
      let executedAnything = false;

      for (const wave of plan.waves) {
        const members = wave.nodeIds
          .map((nodeId) => ({
            assignment: byId.get(nodeId),
            node: graph.nodes.find((item) => item.id === nodeId),
          }))
          .filter(
            (entry): entry is { assignment: Assignment; node: TaskSpec } =>
              entry.assignment !== undefined && entry.node !== undefined,
          );

        const results = await Promise.all(
          members.map((member) =>
            this.dispatch(member.node, member.assignment, identity, artifacts),
          ),
        );

        for (const outcome of results) {
          record.executed.push({
            taskId: outcome.taskId,
            placement: outcome.placement,
            completed: outcome.completed,
            usage: outcome.usage,
            note: outcome.note,
          });
          if (outcome.completed) {
            executedAnything = true;
            completed.add(outcome.taskId);
            for (const artifact of outcome.committed) {
              artifacts.push(artifact);
              artifactNames.add(artifact.id);
            }
          } else {
            const node = graph.nodes.find((item) => item.id === outcome.taskId);
            if (node?.optional) {
              skipped.add(outcome.taskId);
              executedAnything = true;
            } else {
              failures.push({ taskId: outcome.taskId, reason: outcome.note });
              return finish("EXECUTION_FAILED");
            }
          }
        }
      }

      // Only give up when the round changed nothing at all. A round that merely
      // SKIPped a task still made progress: the next round is what discovers
      // that a downstream task depending on its artifact is now unreachable.
      const settledAfter = completed.size + skipped.size;
      const madeProgress = executedAnything || settledAfter > settledBefore;
      if (!madeProgress && plan.waves.length === 0) {
        const anyDeferred = plan.assignments.some((item) => item.disposition === "DEFER");
        if (!anyDeferred) return finish("BLOCKED");
      }
    }

    return finish("ROUND_LIMIT");
  }

  private commitArtifacts(
    produced: ProducedArtifact[],
    executorPrincipalId: string,
  ): { ok: true; artifacts: ContextArtifact[] } | { ok: false; error: string } {
    const database = this.dependencies.store.snapshot();
    const artifacts: ContextArtifact[] = [];
    for (const item of produced) {
      if (item.publishedArtifactId === undefined) {
        artifacts.push({
          id: item.id,
          origin: "own_task_output",
          producedByPrincipalId: executorPrincipalId,
          value: item.value,
        });
        continue;
      }
      // Verified, not trusted: the Return Gate must actually have run.
      const stored = database.artifacts.find(
        (candidate) => candidate.id === item.publishedArtifactId,
      );
      if (!stored) {
        return { ok: false, error: "published artifact not found: " + item.id };
      }
      if (!stored.published) {
        return { ok: false, error: "artifact was never published: " + item.id };
      }
      if (stored.ownerPrincipalId !== executorPrincipalId) {
        return { ok: false, error: "published artifact belongs to another principal: " + item.id };
      }
      artifacts.push({
        id: item.id,
        origin: "published_finding",
        producedByPrincipalId: stored.ownerPrincipalId,
        recipients: [...stored.recipients],
        artifactType: stored.type,
        value: stored.fields,
      });
    }
    return { ok: true, artifacts };
  }

  /**
   * One task, start to finish.
   *
   * Re-resolves immediately before dispatch, derives a fresh invocation
   * envelope, and refuses to run if the context cannot be assembled.
   */
  private async dispatch(
    node: TaskSpec,
    assignment: Assignment,
    identity: EngineIdentity,
    artifacts: ContextArtifact[],
  ): Promise<{
    taskId: string;
    placement: string;
    completed: boolean;
    committed: ContextArtifact[];
    usage: TaskUsage;
    note: string;
  }> {
    const empty: TaskUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    const placement = assignment.placement ?? "REUSE_CURRENT";
    const fail = (note: string) => ({
      taskId: node.id,
      placement,
      completed: false,
      committed: [],
      usage: empty,
      note,
    });

    // Who will execute, and under which grant.
    let executorPrincipalId = identity.principal.id;
    let executorGrantId = identity.grantId;

    if (placement === "DELEGATE_SPECIALIST") {
      const delegated = await this.dependencies.delegation.delegate({
        parentPrincipal: identity.principal,
        parentGrantId: identity.grantId,
        runId: identity.runId,
        task: node,
      });
      if (!delegated.ok) {
        return fail("delegation refused: " + delegated.reason);
      }
      executorPrincipalId = delegated.childPrincipalId;
      executorGrantId = delegated.grantId;
    }

    // Fresh state at dispatch. A revocation between planning and here must not
    // be rescued by the plan that was made a moment ago.
    const resolution = this.resolve(executorPrincipalId, executorGrantId, identity.runId);
    if (!resolution.ok) {
      return fail("state unresolvable at dispatch: " + resolution.reason);
    }
    const state = resolution.state;
    if (
      state.grantState.revoked ||
      state.ancestry.some((ancestor) => ancestor.revoked)
    ) {
      return fail("grant revoked before dispatch");
    }
    if (effectiveRemaining(state) <= 0) {
      return fail("budget exhausted before dispatch");
    }

    const envelope = deriveExecutionEnvelope({
      state,
      task: node,
      invocationId: `${identity.runId}:${node.id}:${this.invocations += 1}`,
      ...(this.dependencies.executionPolicy
        ? { policy: this.dependencies.executionPolicy }
        : {}),
    });

    // Real ancestry from the grant chain, so a delegated child can be briefed
    // with what its parent produced while nothing flows back up without the
    // Return Gate.
    const context = projectContext(
      node,
      envelope,
      artifacts,
      ancestorPrincipalIds(this.dependencies.store, executorGrantId),
    );
    if (context.missingRequired.length > 0) {
      return fail(
        "required context unavailable to this executor: " +
          context.missingRequired.join(", "),
      );
    }

    const result = await this.dependencies.executor.execute({
      task: node,
      envelope,
      context,
      placement,
    });

    // Real usage, after the call. estimatedTokens is never persisted and never
    // reserved; this is the only accounting path.
    if (result.usage.totalTokens > 0) {
      await this.dependencies.ledger.appendEvent("tokens_consumed", result.usage, {
        runId: identity.runId,
        grantId: executorGrantId,
        principalId: executorPrincipalId,
      });
    }

    if (!result.ok) {
      return {
        ...fail("execution failed: " + (result.error ?? "unknown")),
        usage: result.usage,
      };
    }

    // Validate the promise before committing anything.
    const producedNames = new Set(result.producedArtifacts.map((item) => item.id));
    const missing = missingPromisedArtifacts(node, producedNames);
    if (missing.length > 0) {
      return {
        ...fail("promised artifacts not produced: " + missing.join(", ")),
        usage: result.usage,
      };
    }

    const commit = this.commitArtifacts(result.producedArtifacts, executorPrincipalId);
    if (!commit.ok) {
      return { ...fail(commit.error), usage: result.usage };
    }
    const committed = commit.artifacts;

    return {
      taskId: node.id,
      placement,
      completed: true,
      committed,
      usage: result.usage,
      note: assignment.note,
    };
  }
}

/**
 * Turn what an executor says it produced into context artifacts.
 *
 * An unpublished value carries the EXECUTOR's principal, so a delegated
 * child's raw output is kept away from the parent by the ContextBroker's
 * visibility rule rather than by anything here.
 *
 * A published claim is checked against the store: the artifact must exist, be
 * published, and name recipients. Believing the executor instead would make
 * the Return Gate bypassable by any code that sets a field.
 */
function effectiveRemaining(state: GovernanceState): number {
  return Math.min(
    state.envelope.maxTokens - state.grantState.tokensUsed,
    state.runState.maxTokens - state.runState.tokensUsed,
  );
}
