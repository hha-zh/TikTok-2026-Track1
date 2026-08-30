/**
 * Seeds everything the Todo workload needs on top of the governance fixtures.
 *
 * Additive only: it registers the two bounded artifact types and their schemas.
 * It does not touch the demo's authority boundaries — `app/*` stays
 * exercisable-only, `sec/INC-42` delegatable-only, `payments/*` in neither set.
 */

import type { JsonStore } from "../../store.js";
import { registerTodoArtifactTypes, TODO_ARTIFACT_SCHEMAS } from "./artifacts.js";

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
