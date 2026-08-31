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

import { randomUUID } from "node:crypto";
import type { JsonStore } from "../../store.js";
import type { GovernanceLedger } from "../evidence/ledger.js";
import type { GovernanceEventPayloadMap } from "../evidence/types.js";
import { ancestorPrincipalIds } from "../governance/artifacts.js";
import { resolveGrant } from "../governance/grant-resolver.js";
import type { GovernanceState, Principal, ReasonCode } from "../governance/types.js";
import { buildCandidates, type Candidate } from "./candidates.js";
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

export /**
 * The candidate set for one round, built once.
 *
 * Exists so that "what the router ranked" and "what the ledger recorded" are
 * the same array of the same objects rather than two independent builds.
 */
interface CandidateSnapshot {
  roundIndex: number;
  entries: { node: TaskSpec; candidates: Candidate[] }[];
}

interface RoundRecord {
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

function requireDecisionId(ids: Map<string, string>, taskId: string): string {
  const decisionId = ids.get(taskId);
  if (!decisionId) throw new Error("routing decision id missing for task " + taskId);
  return decisionId;
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

/** The runtime-evidence subset of the ledger's kinds. */
type AdaptiveEventKind =
  | "task_ready"
  | "task_deferred"
  | "routing_decision"
  | "invocation_started"
  | "context_projected"
  | "task_completed"
  | "task_failed"
  | "task_skipped"
  | "runtime_degraded"
  | "run_outcome";

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

  /**
   * Append one Adaptive Runtime evidence event.
   *
   * These are runtime FACTS, not verdicts. They go through the same
   * single-writer, redacted ledger as governance evidence so the Run Inspector
   * has one append-only trail rather than a second store that disappears with
   * the request.
   */
  private record<K extends AdaptiveEventKind>(
    identity: EngineIdentity,
    kind: K,
    payload: GovernanceEventPayloadMap[K],
    grantId?: string,
    principalId?: string,
  ): Promise<unknown> {
    return this.dependencies.ledger.appendEvent(kind, payload, {
      runId: identity.runId,
      grantId: grantId ?? identity.grantId,
      principalId: principalId ?? identity.principal.id,
    });
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
    const finish = async (outcome: RunOutcome): Promise<EngineResult> => {
      await this.record(identity, "run_outcome", {
        outcome,
        completed: completed.size,
        skipped: skipped.size,
        failed: failures.length,
        rounds: rounds.length,
      });
      return { outcome, progress: progress(), artifacts, rounds, failures };
    };

    for (let index = 0; index < this.policy.maxRounds; index += 1) {
      const settledBefore = completed.size + skipped.size;
      if (settledBefore === graph.nodes.length) return await finish("COMPLETED");

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
        return await finish("UNREACHABLE");
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
        return await finish("BLOCKED");
      }
      const state = resolution.state;

      // ONE candidate snapshot per round.
      //
      // Built exactly once and then shared by reference: the router ranks these
      // objects and the ledger records these same objects. Building twice would
      // usually agree, but "usually" is the whole problem - the set that decided
      // and the set recorded as evidence must be the same set, not two sets that
      // happen to match.
      const snapshot: CandidateSnapshot = {
        roundIndex: index,
        entries: ready.map((node) => ({
          node,
          candidates: buildCandidates(node, {
            principal: identity.principal,
            state,
            now: this.now(),
            parallelCapacity: this.policy.parallelCapacity,
            ...(this.dependencies.executionPolicy
              ? { policy: this.dependencies.executionPolicy }
              : {}),
          }),
        })),
      };
      const candidatesByTask = new Map(
        snapshot.entries.map((entry) => [entry.node.id, entry.candidates]),
      );
      // Correlation metadata only. Generate once per decision and reuse that
      // exact value at dispatch; reconstruction/resume must never collide with
      // a previous decision for the same run/task/round tuple.
      const decisionIds = new Map(
        snapshot.entries.map((entry) => [entry.node.id, randomUUID()]),
      );

      const plan = route({
        entries: snapshot.entries,
        effectiveBudgetRemaining: effectiveRemaining(state),
        runBudgetRemaining: state.runState.maxTokens - state.runState.tokensUsed,
        runCapTokens: state.runState.maxTokens,
        childSlotsRemaining: state.envelope.maxChildren - state.grantState.childCount,
        parallelCapacity: this.policy.parallelCapacity,
        policy: this.routerPolicy,
      });

      const record: RoundRecord = { index, plan, executed: [] };
      rounds.push(record);

      for (const node of ready) {
        await this.record(identity, "task_ready", { taskId: node.id });
      }
      const runPressure =
        state.runState.maxTokens > 0
          ? Math.min(
              1,
              Math.max(
                0,
                1 - (state.runState.maxTokens - state.runState.tokensUsed) /
                  state.runState.maxTokens,
              ),
            )
          : 1;
      for (const assignment of plan.assignments) {
        const node = graph.nodes.find((item) => item.id === assignment.nodeId);
        const built = candidatesByTask.get(assignment.nodeId) ?? [];
        await this.record(identity, "routing_decision", {
          decisionId: requireDecisionId(decisionIds, assignment.nodeId),
          taskId: assignment.nodeId,
          disposition: assignment.disposition,
          placement: assignment.placement,
          shape: plan.shape,
          wave: assignment.wave,
          declaredUtilityGain: node?.hints?.expectedUtilityGain ?? null,
          declaredIncrementalCost: node?.hints?.expectedIncrementalCost ?? null,
          declaredIsolationPreference: node?.hints?.isolationPreference ?? null,
          // DECLARED, per task rather than per candidate: the same estimate is
          // weighed against every placement.
          estimatedTokens: node?.estimatedTokens ?? null,
          authorityIsolationGain: assignment.authorityIsolationGain,
          delegationValue: assignment.delegationValue,
          delegationThreshold: assignment.delegationThreshold,
          // Recorded once for the decision rather than repeated per candidate:
          // these are properties of the run at this moment, not of a candidate.
          budget: {
            effectiveTokensRemaining: effectiveRemaining(state),
            runTokensRemaining: state.runState.maxTokens - state.runState.tokensUsed,
            runPressure,
            childSlotsRemaining: state.envelope.maxChildren - state.grantState.childCount,
            depthRemaining: state.envelope.depth,
            parallelCapacity: this.policy.parallelCapacity,
          },
          candidates: built.map((candidate) => ({
            placement: candidate.placement,
            authorityLegal: candidate.authority.legal,
            authorityReason: candidate.authority.reason,
            constraintAxis: candidate.authority.constraintAxis,
            hardEligible: candidate.hardEligible,
            planningFit: candidate.planningFit,
            budgetReason: candidate.budget.reason,
            structurallyNarrower: candidate.authority.structurallyNarrower,
            routableNow: candidate.routableNow,
            effectiveResources: candidate.authority.effectiveResources,
            effectiveActions: candidate.authority.effectiveActions,
          })),
        });
        if (assignment.disposition === "DEGRADE") {
          await this.record(identity, "runtime_degraded", {
            taskId: assignment.nodeId,
            from: "PARALLEL",
            to: plan.shape,
            note: assignment.note,
          });
        }
      }

      // --- dispositions that settle without executing ---
      for (const assignment of plan.assignments) {
        if (assignment.disposition === "SKIP") {
          skipped.add(assignment.nodeId);
          await this.record(identity, "task_skipped", {
            taskId: assignment.nodeId,
            reason: assignment.note,
          });
        }
        if (assignment.disposition === "BLOCKED") {
          failures.push({
            taskId: assignment.nodeId,
            reason: assignment.note,
            governanceReason: assignment.governanceReason,
          });
          await this.record(identity, "task_failed", {
            taskId: assignment.nodeId,
            reason: assignment.note,
          });
        }
        if (assignment.disposition === "DEFER") {
          const count = (deferCounts.get(assignment.nodeId) ?? 0) + 1;
          deferCounts.set(assignment.nodeId, count);
          await this.record(identity, "task_deferred", {
            taskId: assignment.nodeId,
            deferCount: count,
            note: assignment.note,
          });
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
              return await finish("DEFER_CEILING");
            }
          }
        }
      }
      if (plan.blocked) return await finish("BLOCKED");

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
            this.dispatch(
              member.node,
              member.assignment,
              identity,
              artifacts,
              requireDecisionId(decisionIds, member.node.id),
            ),
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
            await this.record(identity, "task_completed", {
              taskId: outcome.taskId,
              invocationId: outcome.invocationId,
              placement: outcome.placement,
            });
            for (const artifact of outcome.committed) {
              artifacts.push(artifact);
              artifactNames.add(artifact.id);
            }
          } else {
            await this.record(identity, "task_failed", {
              taskId: outcome.taskId,
              reason: outcome.note,
            });
            const node = graph.nodes.find((item) => item.id === outcome.taskId);
            if (node?.optional) {
              skipped.add(outcome.taskId);
              executedAnything = true;
            } else {
              failures.push({ taskId: outcome.taskId, reason: outcome.note });
              return await finish("EXECUTION_FAILED");
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
        if (!anyDeferred) return await finish("BLOCKED");
      }
    }

    return await finish("ROUND_LIMIT");
  }

  private commitArtifacts(
    node: TaskSpec,
    produced: ProducedArtifact[],
    executorPrincipalId: string,
  ): { ok: true; artifacts: ContextArtifact[] } | { ok: false; error: string } {
    const database = this.dependencies.store.snapshot();
    const artifacts: ContextArtifact[] = [];
    for (const item of produced) {
      if (item.publishedArtifactId === undefined) {
        // Raw output is legitimate on the REUSE path: the executor produced it
        // for its own downstream task and nothing crosses a principal
        // boundary. When it IS delegated, the ContextBroker withholds it from
        // the parent, so publication is enforced by the boundary rather than
        // by a second rule here.
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
      // The workload contract names the expected type. Without this an
      // executor could satisfy `ui_plan` by publishing any type it happens to
      // be allowed to publish.
      const expectedType = node.producedArtifactTypes?.[item.id];
      if (expectedType !== undefined && stored.type !== expectedType) {
        return {
          ok: false,
          error:
            `published artifact for ${item.id} is ${stored.type}, expected ${expectedType}`,
        };
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
    /** The routing_decision this dispatch is carrying out. */
    decisionId: string,
  ): Promise<{
    taskId: string;
    placement: string;
    invocationId: string;
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
    // Stamped up front so a failure before dispatch is still traceable.
    const invocationId = `${identity.runId}:${node.id}:${(this.invocations += 1)}`;
    const fail = (note: string) => ({
      taskId: node.id,
      placement,
      invocationId,
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
      invocationId,
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
    await this.record(
      identity,
      "context_projected",
      {
        invocationId,
        taskId: node.id,
        includedArtifactIds: context.included.map((item) => item.id),
        withheldArtifactIds: context.withheld.map((item) => ({
          id: item.id,
          reason: item.reason,
        })),
      },
      executorGrantId,
      executorPrincipalId,
    );
    if (context.missingRequired.length > 0) {
      // context_projected above still stands: a projection that blocked a
      // dispatch is truthful evidence. No invocation_started is emitted,
      // because no invocation reached the dispatch boundary.
      return fail(
        "required context unavailable to this executor: " +
          context.missingRequired.join(", "),
      );
    }

    await this.record(
      identity,
      "invocation_started",
      {
        decisionId,
        invocationId,
        taskId: node.id,
        executorPrincipalId,
        sourceGrantId: executorGrantId,
        effectiveResources: [...envelope.effective.resources],
        effectiveActions: [...envelope.effective.actions],
      },
      executorGrantId,
      executorPrincipalId,
    );

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

    const commit = this.commitArtifacts(node, result.producedArtifacts, executorPrincipalId);
    if (!commit.ok) {
      return { ...fail(commit.error), usage: result.usage };
    }
    const committed = commit.artifacts;

    return {
      taskId: node.id,
      placement,
      invocationId,
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
