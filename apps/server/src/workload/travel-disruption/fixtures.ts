import type { JsonStore } from "../../store.js";
import type { GovernanceLedger } from "../../middleware/evidence/ledger.js";
import { startGovernedRun } from "../../middleware/governance/fixtures.js";
import { TRAVEL_ARTIFACT_SCHEMAS, registerTravelArtifactTypes } from "./artifacts.js";
import { TRAVEL_ROUTING_INPUTS } from "./graph.js";
import {
  RESOURCE_ACCOMMODATION, RESOURCE_CALENDAR, RESOURCE_ITINERARY, RESOURCE_PASSPORT,
  RESOURCE_PREFERENCES, RESOURCE_ROUTES, RESOURCE_TRANSPORT, TRAVEL_RESOURCES,
} from "./resources.js";
import {
  TYPE_ACCOMMODATION_OPTIONS, TYPE_IDENTITY_VERIFICATION, TYPE_TRANSPORT_OPTIONS,
  TYPE_VALIDATED_RECOVERY,
} from "./artifacts.js";
import { TRAVEL_DESCRIPTOR_VERSION, TRAVEL_WORKLOAD_ID } from "./evidence.js";

export const TRAVEL_OWNER = "travel-user";

export async function seedTravelFixtures(store: JsonStore): Promise<void> {
  registerTravelArtifactTypes();
  await store.mutate((database) => {
    if (!database.principals.some((item) => item.id === TRAVEL_OWNER)) {
      database.principals.push({ id: TRAVEL_OWNER, kind: "human" });
    }
    for (const resource of TRAVEL_RESOURCES) {
      const value = structuredClone(resource);
      const index = database.mockResources.findIndex((item) => item.id === value.id);
      if (index < 0) database.mockResources.push(value);
      else database.mockResources[index] = value;
    }
    for (const schema of TRAVEL_ARTIFACT_SCHEMAS) {
      const index = database.artifactSchemas.findIndex((item) => item.artifactType === schema.artifactType);
      if (index < 0) database.artifactSchemas.push(schema);
      else database.artifactSchemas[index] = schema;
    }
  });
}

export async function startTravelRun(store: JsonStore, ledger: GovernanceLedger, runId = "travel-run-1") {
  const governed = await startGovernedRun(store, ledger, {
    runId,
    ownerId: TRAVEL_OWNER,
    workloadDescriptor: {
      workloadId: TRAVEL_WORKLOAD_ID,
      descriptorVersion: TRAVEL_DESCRIPTOR_VERSION,
    },
  });
  await store.mutate((database) => {
    const envelope = database.envelopes.find((item) => item.id === governed.envelope.id);
    const run = database.runStates.find((item) => item.runId === runId);
    if (!envelope || !run) throw new Error("travel root state missing");
    envelope.exercisable = {
      resources: [RESOURCE_ITINERARY, RESOURCE_CALENDAR, RESOURCE_PREFERENCES, RESOURCE_TRANSPORT, RESOURCE_ACCOMMODATION, RESOURCE_ROUTES],
      actions: ["read", "model:invoke", "delegate"],
    };
    envelope.delegatable = {
      resources: [RESOURCE_TRANSPORT, RESOURCE_ACCOMMODATION, RESOURCE_ROUTES, RESOURCE_PASSPORT, TYPE_TRANSPORT_OPTIONS, TYPE_ACCOMMODATION_OPTIONS, TYPE_IDENTITY_VERIFICATION, TYPE_VALIDATED_RECOVERY],
      actions: ["read", "model:invoke", "artifact:create", "artifact:publish"],
    };
    envelope.maxChildren = TRAVEL_ROUTING_INPUTS.maxChildren;
    envelope.maxTokens = TRAVEL_ROUTING_INPUTS.rootGrantTokenCap;
    envelope.depth = TRAVEL_ROUTING_INPUTS.delegationDepth;
    run.maxTokens = TRAVEL_ROUTING_INPUTS.runTokenCap;
  });
  const snapshot = store.snapshot();
  return {
    principal: snapshot.principals.find((item) => item.id === governed.principal.id)!,
    envelope: snapshot.envelopes.find((item) => item.id === governed.envelope.id)!,
    runState: snapshot.runStates.find((item) => item.runId === runId)!,
  };
}
