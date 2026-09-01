/**
 * Bounded Return-Gate types for the Todo workload.
 *
 * `ui_plan` and `test_plan` may be executed by delegated children, and a
 * child's raw output can never become a parent context artifact. These are the
 * only shapes in which a planning result may cross:
 *
 *   child raw output
 *        X
 *        |
 *   Return Gate  ->  UIPlan / TestPlan  ->  ContextBroker  ->  implementation
 *
 * Every field is an enum or a bounded integer. There is deliberately no
 * free-text field, no `summary`, no `planText` and no open JSON: the spec
 * language has no kind that could express one, so the bound holds by
 * construction rather than by reviewer discipline. A plan that cannot be said
 * in these fields does not cross — that is the cost of the boundary, and it is
 * the intended cost.
 */

import { registerArtifactFieldSpecs } from "../../middleware/governance/artifacts.js";
import type { ArtifactSchema } from "../../middleware/governance/types.js";

export const ARTIFACT_UI_PLAN = "UIPlan";
export const ARTIFACT_TEST_PLAN = "TestPlan";

export const UI_PLAN_SCHEMA: ArtifactSchema = {
  artifactType: ARTIFACT_UI_PLAN,
  version: 1,
  maxFieldCount: 4,
  maxSerializedBytes: 256,
  allowedFieldNames: ["layout", "interaction", "responsive", "component_count"],
};

export const TEST_PLAN_SCHEMA: ArtifactSchema = {
  artifactType: ARTIFACT_TEST_PLAN,
  version: 1,
  maxFieldCount: 4,
  maxSerializedBytes: 256,
  allowedFieldNames: [
    "coverage",
    "interaction_tests",
    "accessibility",
    "responsive_tests",
  ],
};

export const TODO_ARTIFACT_SCHEMAS: ArtifactSchema[] = [
  UI_PLAN_SCHEMA,
  TEST_PLAN_SCHEMA,
];

/**
 * Register the field shapes with the Artifact Gate.
 *
 * Idempotent. Called by the workload's seeding so governance never has to know
 * that a Todo workload exists.
 */
export function registerTodoArtifactTypes(): void {
  registerArtifactFieldSpecs(ARTIFACT_UI_PLAN, {
    layout: { kind: "enum", values: ["single_column", "split_panel"] },
    interaction: { kind: "enum", values: ["inline", "modal"] },
    responsive: { kind: "enum", values: ["mobile_first", "desktop_first"] },
    component_count: { kind: "int", min: 0, max: 50 },
  });
  registerArtifactFieldSpecs(ARTIFACT_TEST_PLAN, {
    coverage: { kind: "enum", values: ["core", "core_and_edge"] },
    interaction_tests: { kind: "int", min: 0, max: 100 },
    accessibility: { kind: "enum", values: ["required", "optional"] },
    responsive_tests: { kind: "int", min: 0, max: 100 },
  });
}
