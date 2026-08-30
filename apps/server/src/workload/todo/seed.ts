/**
 * Seeds everything the Todo workload needs on top of the governance fixtures.
 *
 * Additive only: it registers the two bounded artifact types and their schemas.
 * It does not touch the demo's authority boundaries — `app/*` stays
 * exercisable-only, `sec/INC-42` delegatable-only, `payments/*` in neither set.
 */

import type { JsonStore } from "../../store.js";
import {
  ARTIFACT_TEST_PLAN,
  ARTIFACT_UI_PLAN,
  registerTodoArtifactTypes,
  TODO_ARTIFACT_SCHEMAS,
} from "./artifacts.js";

/**
 * Delegatable capabilities this workload contributes to a governed run.
 *
 * Passed to `startGovernedRun` rather than baked into the governance fixture,
 * so governance stays unaware that a Todo workload exists. Delegatable only:
 * a planning child may publish its plan back, and the parent still cannot
 * publish one itself.
 */
export const TODO_DELEGATABLE_RESOURCES = [ARTIFACT_UI_PLAN, ARTIFACT_TEST_PLAN];

export async function seedTodoWorkload(store: JsonStore): Promise<void> {
  registerTodoArtifactTypes();
  await store.mutate((database) => {
    for (const schema of TODO_ARTIFACT_SCHEMAS) {
      const index = database.artifactSchemas.findIndex(
        (item) => item.artifactType === schema.artifactType,
      );
      if (index === -1) {
        database.artifactSchemas.push(schema);
      } else {
        database.artifactSchemas[index] = schema;
      }
    }
  });
}
