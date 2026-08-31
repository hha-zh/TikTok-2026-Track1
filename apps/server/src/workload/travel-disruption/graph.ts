import { task, type TaskGraph, type TaskSpec } from "../../middleware/adaptive/task-graph.js";
import {
  TYPE_ACCOMMODATION_OPTIONS, TYPE_FINAL_RECOVERY, TYPE_IDENTITY_VERIFICATION,
  TYPE_ROUTE_PLAN, TYPE_TRANSPORT_OPTIONS, TYPE_TRAVEL_CONSTRAINTS,
  TYPE_VALIDATED_RECOVERY,
} from "./artifacts.js";
import {
  RESOURCE_ACCOMMODATION, RESOURCE_CALENDAR, RESOURCE_ITINERARY, RESOURCE_PASSPORT,
  RESOURCE_PREFERENCES, RESOURCE_ROUTES, RESOURCE_TRANSPORT,
} from "./resources.js";

export const T0_UNDERSTAND = "understand_disruption";
export const T1_TRANSPORT = "search_transport";
export const T2_ACCOMMODATION = "search_accommodation";
export const T3_ROUTE = "plan_local_arrival";
export const T4_IDENTITY = "verify_identity";
export const T5_VALIDATE = "validate_recovery_plan";
export const T6_FINAL = "final_recovery_plan";

export const A_CONSTRAINTS = "travel_constraints";
export const A_TRANSPORT = "transport_options";
export const A_ACCOMMODATION = "accommodation_options";
export const A_ROUTE = "route_plan";
export const A_IDENTITY = "identity_verification";
export const A_VALIDATED = "validated_recovery_plan";
export const A_FINAL = "final_travel_recovery_plan";

const publicationAuthority = (input: string[], type: string) => ({
  resources: [...input, type],
  actions: ["read", "model:invoke", "artifact:create", "artifact:publish"],
});

const adaptiveHints = {
  independent: true,
  expectedUtilityGain: 0.45,
  expectedIncrementalCost: 500,
} as const;

export function buildTravelGraph(): TaskGraph {
  const nodes: TaskSpec[] = [
    task({
      id: T0_UNDERSTAND, description: "Derive bounded constraints from the cancelled trip",
      resources: [RESOURCE_ITINERARY, RESOURCE_CALENDAR, RESOURCE_PREFERENCES], actions: ["read"],
      dependsOn: [], requiredArtifacts: [], producedArtifacts: [A_CONSTRAINTS], estimatedTokens: 500,
    }),
    task({
      id: T1_TRANSPORT, description: "Search deterministic transport alternatives",
      resources: [RESOURCE_TRANSPORT], actions: ["read", "model:invoke"], dependsOn: [],
      requiredArtifacts: [A_CONSTRAINTS], producedArtifacts: [A_TRANSPORT],
      producedArtifactTypes: { [A_TRANSPORT]: TYPE_TRANSPORT_OPTIONS }, estimatedTokens: 900,
      delegatedAuthority: publicationAuthority([RESOURCE_TRANSPORT], TYPE_TRANSPORT_OPTIONS), hints: adaptiveHints,
    }),
    task({
      id: T2_ACCOMMODATION, description: "Search deterministic accommodation alternatives",
      resources: [RESOURCE_ACCOMMODATION], actions: ["read", "model:invoke"], dependsOn: [],
      requiredArtifacts: [A_CONSTRAINTS], producedArtifacts: [A_ACCOMMODATION],
      producedArtifactTypes: { [A_ACCOMMODATION]: TYPE_ACCOMMODATION_OPTIONS }, estimatedTokens: 900,
      delegatedAuthority: publicationAuthority([RESOURCE_ACCOMMODATION], TYPE_ACCOMMODATION_OPTIONS), hints: adaptiveHints,
    }),
    task({
      id: T3_ROUTE, description: "Select a consistent local arrival route",
      resources: [RESOURCE_ROUTES], actions: ["read"], dependsOn: [],
      requiredArtifacts: [A_CONSTRAINTS, A_TRANSPORT], producedArtifacts: [A_ROUTE], estimatedTokens: 600,
    }),
    task({
      id: T4_IDENTITY, description: "Verify identity for the selected transport option",
      resources: [RESOURCE_PASSPORT], actions: ["read", "model:invoke"], dependsOn: [],
      requiredArtifacts: [A_CONSTRAINTS, A_ROUTE], producedArtifacts: [A_IDENTITY],
      producedArtifactTypes: { [A_IDENTITY]: TYPE_IDENTITY_VERIFICATION }, estimatedTokens: 800,
      delegatedAuthority: publicationAuthority([RESOURCE_PASSPORT], TYPE_IDENTITY_VERIFICATION),
      hints: { isolationPreference: "preferred" },
    }),
    task({
      id: T5_VALIDATE, description: "Validate the bounded recovery combination",
      resources: [], actions: ["model:invoke"], dependsOn: [],
      requiredArtifacts: [A_CONSTRAINTS, A_TRANSPORT, A_ACCOMMODATION, A_ROUTE, A_IDENTITY],
      producedArtifacts: [A_VALIDATED], producedArtifactTypes: { [A_VALIDATED]: TYPE_VALIDATED_RECOVERY },
      estimatedTokens: 700,
      delegatedAuthority: { resources: [TYPE_VALIDATED_RECOVERY], actions: ["model:invoke", "artifact:create", "artifact:publish"] },
      hints: { expectedUtilityGain: adaptiveHints.expectedUtilityGain, expectedIncrementalCost: adaptiveHints.expectedIncrementalCost },
    }),
    task({
      id: T6_FINAL, description: "Synthesize the bounded user-facing recovery plan",
      resources: [], actions: ["model:invoke"], dependsOn: [], requiredArtifacts: [A_CONSTRAINTS, A_VALIDATED],
      producedArtifacts: [A_FINAL], producedArtifactTypes: { [A_FINAL]: TYPE_FINAL_RECOVERY }, estimatedTokens: 500,
    }),
  ];
  return { id: "travel-disruption-v1", nodes };
}

export const TRAVEL_ROUTING_INPUTS = {
  runTokenCap: 12_000,
  rootGrantTokenCap: 12_000,
  maxChildren: 4,
  delegationDepth: 1,
  parallelCapacity: 2,
  adaptiveUtilityGain: adaptiveHints.expectedUtilityGain,
  adaptiveIncrementalCost: adaptiveHints.expectedIncrementalCost,
} as const;
