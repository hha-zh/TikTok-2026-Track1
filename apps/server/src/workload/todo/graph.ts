/**
 * The Todo workload — Coding Workspace Governance demo.
 *
 *   workspace_scan
 *        |
 *        +----------------+
 *        |                |
 *      ui_plan        test_plan
 *        |                |
 *        +-------+--------+
 *                |
 *         implementation
 *                |
 *        optional_reviewer
 *
 * Task semantics live here, in the workload adapter. Nothing Todo-specific is
 * imported back into the governance or adaptive core — the core sees only
 * resources, actions, artifacts and declared hints.
 *
 * How each step gets its topology, without any special-casing in the router:
 *
 *   workspace_scan     reads app/* which is exercisable-only, so DELEGATE is
 *                      not legal and it is REUSE by governance, not by hint
 *   ui_plan/test_plan  resource-free reasoning, legal BOTH ways, so the soft
 *                      marginal-benefit choice is the only thing deciding
 *   implementation     declares no benefit to extra agency, so it reuses; it
 *                      also consumes both plans, which must have crossed the
 *                      Return Gate if they were delegated
 *   optional_reviewer  optional and low-value, so budget pressure drops it
 */

import type { TaskSpec, TaskGraph } from "../../middleware/adaptive/task-graph.js";
import { task } from "../../middleware/adaptive/task-graph.js";
import {
  RESOURCE_CHECKOUT_LOG,
  RESOURCE_METRICS,
} from "../../middleware/governance/fixtures.js";
import { ARTIFACT_TEST_PLAN, ARTIFACT_UI_PLAN } from "./artifacts.js";

export const TASK_WORKSPACE_SCAN = "workspace_scan";
export const TASK_UI_PLAN = "ui_plan";
export const TASK_TEST_PLAN = "test_plan";
export const TASK_IMPLEMENTATION = "implementation";
export const TASK_OPTIONAL_REVIEWER = "optional_reviewer";

export const ARTIFACT_WORKSPACE_SUMMARY = "workspace_summary";
export const ARTIFACT_UI_PLAN_RESULT = "ui_plan";
export const ARTIFACT_TEST_PLAN_RESULT = "test_plan";
export const ARTIFACT_IMPLEMENTATION = "implementation_result";

/**
 * Authority a delegated planner needs beyond the task's own: it must be able to
 * publish its bounded plan back to the parent. Bounded by the parent's
 * delegatable set, so this cannot widen anything.
 */
const plannerDelegatedAuthority = (artifactType: string) => ({
  resources: [artifactType],
  actions: ["model:invoke", "artifact:create", "artifact:publish"],
});

export interface TodoGraphOptions {
  /**
   * Declared benefit of giving each planning step its own specialist.
   * Heuristic and author-declared, never measured.
   */
  planningUtilityGain?: number;
  planningIncrementalCost?: number;
  reviewerTokens?: number;
}

export function buildTodoGraph(options: TodoGraphOptions = {}): TaskGraph {
  const planningUtilityGain = options.planningUtilityGain ?? 0.45;
  const planningIncrementalCost = options.planningIncrementalCost ?? 300;
  const reviewerTokens = options.reviewerTokens ?? 900;

  const planner = (
    id: string,
    artifactType: string,
    producedArtifact: string,
  ): TaskSpec =>
    task({
      id,
      description: `Draft the ${id.replace("_", " ")} for the Todo feature`,
      // Resource-free reasoning: legal for REUSE and for DELEGATE, which is
      // what makes the adaptive choice real rather than an authority fallback.
      resources: [],
      actions: ["model:invoke"],
      dependsOn: [TASK_WORKSPACE_SCAN],
      requiredArtifacts: [ARTIFACT_WORKSPACE_SUMMARY],
      producedArtifacts: [producedArtifact],
      // Trusted workload contract: when this crosses the Return Gate it must be
      // exactly this type. The executor does not get to choose.
      producedArtifactTypes: { [producedArtifact]: artifactType },
      estimatedTokens: 400,
      delegatedAuthority: plannerDelegatedAuthority(artifactType),
      hints: {
        independent: true,
        expectedUtilityGain: planningUtilityGain,
        expectedIncrementalCost: planningIncrementalCost,
      },
    });

  return {
    id: "todo-workspace",
    nodes: [
      task({
        id: TASK_WORKSPACE_SCAN,
        description: "Inspect the workspace telemetry and summarise its state",
        // app/* is exercisable-only, so governance - not a hint - makes this REUSE.
        resources: [RESOURCE_METRICS, RESOURCE_CHECKOUT_LOG],
        actions: ["read"],
        dependsOn: [],
        requiredArtifacts: [],
        producedArtifacts: [ARTIFACT_WORKSPACE_SUMMARY],
        estimatedTokens: 300,
      }),
      planner(TASK_UI_PLAN, ARTIFACT_UI_PLAN, ARTIFACT_UI_PLAN_RESULT),
      planner(TASK_TEST_PLAN, ARTIFACT_TEST_PLAN, ARTIFACT_TEST_PLAN_RESULT),
      task({
        id: TASK_IMPLEMENTATION,
        description: "Implement the Todo feature against both plans",
        resources: [],
        actions: ["model:invoke"],
        dependsOn: [],
        requiredArtifacts: [ARTIFACT_UI_PLAN_RESULT, ARTIFACT_TEST_PLAN_RESULT],
        producedArtifacts: [ARTIFACT_IMPLEMENTATION],
        estimatedTokens: 600,
        // No declared benefit to extra agency: the work is in one place and
        // needs both plans in one context.
      }),
      task({
        id: TASK_OPTIONAL_REVIEWER,
        description: "Second-opinion review of the implementation",
        resources: [],
        actions: ["model:invoke"],
        dependsOn: [TASK_IMPLEMENTATION],
        requiredArtifacts: [ARTIFACT_IMPLEMENTATION],
        producedArtifacts: [],
        estimatedTokens: reviewerTokens,
        optional: true,
        hints: {
          independent: true,
          // Low declared benefit: worth doing with room to spare, first thing
          // to drop when the run budget tightens.
          expectedUtilityGain: 0.05,
          expectedIncrementalCost: 800,
        },
      }),
    ],
  };
}
