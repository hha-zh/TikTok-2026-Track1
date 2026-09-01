import { registerArtifactFieldSpecs } from "../../middleware/governance/artifacts.js";
import type { ArtifactSchema } from "../../middleware/governance/types.js";

export const TYPE_TRAVEL_CONSTRAINTS = "TravelConstraints";
export const TYPE_TRANSPORT_OPTIONS = "TransportOptions";
export const TYPE_ACCOMMODATION_OPTIONS = "AccommodationOptions";
export const TYPE_ROUTE_PLAN = "RoutePlan";
export const TYPE_IDENTITY_VERIFICATION = "IdentityVerification";
export const TYPE_VALIDATED_RECOVERY = "ValidatedRecoveryPlan";
export const TYPE_FINAL_RECOVERY = "FinalTravelRecoveryPlan";

export interface FinalTravelRecoveryPlan {
  transport_option_id: string;
  accommodation_option_id: string;
  route_option_id: string;
  final_arrival: string;
  total_additional_spend_sgd: number;
  approval_required: "yes" | "no";
  status: "ready_for_approval" | "ready";
}

const schema = (artifactType: string, fields: string[]): ArtifactSchema => ({
  artifactType,
  version: 1,
  maxFieldCount: fields.length,
  maxSerializedBytes: 512,
  allowedFieldNames: fields,
});

export const TRAVEL_ARTIFACT_SCHEMAS = [
  schema(TYPE_TRAVEL_CONSTRAINTS, ["origin", "destination", "latest_arrival", "max_additional_spend_sgd", "approval_threshold_sgd"]),
  schema(TYPE_TRANSPORT_OPTIONS, ["recommended_option_id", "booking_name_key", "departure", "arrival", "arrival_airport", "price_sgd", "reliability"]),
  schema(TYPE_ACCOMMODATION_OPTIONS, ["recommended_option_id", "check_in", "location", "price_sgd", "availability"]),
  schema(TYPE_ROUTE_PLAN, ["route_option_id", "transport_option_id", "booking_name_key", "from_airport", "arrival", "price_sgd", "reliability"]),
  schema(TYPE_IDENTITY_VERIFICATION, ["identity_verified", "booking_name_matched", "travel_document_valid", "destination_eligible"]),
  schema(TYPE_VALIDATED_RECOVERY, ["transport_option_id", "accommodation_option_id", "route_option_id", "arrival_before_deadline", "total_additional_spend_sgd", "approval_required", "confidence"]),
  schema(TYPE_FINAL_RECOVERY, ["transport_option_id", "accommodation_option_id", "route_option_id", "final_arrival", "total_additional_spend_sgd", "approval_required", "status"]),
];

export function registerTravelArtifactTypes(): void {
  registerArtifactFieldSpecs(TYPE_TRAVEL_CONSTRAINTS, {
    origin: { kind: "enum", values: ["SIN"] }, destination: { kind: "enum", values: ["TOKYO"] },
    latest_arrival: { kind: "enum", values: ["2026-09-02T13:00:00+09:00"] },
    max_additional_spend_sgd: { kind: "int", min: 0, max: 700 }, approval_threshold_sgd: { kind: "int", min: 0, max: 300 },
  });
  registerArtifactFieldSpecs(TYPE_TRANSPORT_OPTIONS, {
    recommended_option_id: { kind: "enum", values: ["TR-ALT-02"] }, booking_name_key: { kind: "enum", values: ["TRAVELER_A"] },
    departure: { kind: "enum", values: ["2026-09-02T01:20:00+08:00"] }, arrival: { kind: "enum", values: ["2026-09-02T09:30:00+09:00"] },
    arrival_airport: { kind: "enum", values: ["HND"] }, price_sgd: { kind: "int", min: 0, max: 1000 }, reliability: { kind: "enum", values: ["high"] },
  });
  registerArtifactFieldSpecs(TYPE_ACCOMMODATION_OPTIONS, {
    recommended_option_id: { kind: "enum", values: ["HT-03"] }, check_in: { kind: "enum", values: ["2026-09-01T18:00:00+08:00"] },
    location: { kind: "enum", values: ["SIN_AIRPORT"] }, price_sgd: { kind: "int", min: 0, max: 700 }, availability: { kind: "enum", values: ["available"] },
  });
  registerArtifactFieldSpecs(TYPE_ROUTE_PLAN, {
    route_option_id: { kind: "enum", values: ["RT-HND-01"] }, transport_option_id: { kind: "enum", values: ["TR-ALT-02"] },
    booking_name_key: { kind: "enum", values: ["TRAVELER_A"] }, from_airport: { kind: "enum", values: ["HND"] },
    arrival: { kind: "enum", values: ["2026-09-02T11:00:00+09:00"] }, price_sgd: { kind: "int", min: 0, max: 200 }, reliability: { kind: "enum", values: ["high"] },
  });
  registerArtifactFieldSpecs(TYPE_IDENTITY_VERIFICATION, {
    identity_verified: { kind: "enum", values: ["yes", "no"] }, booking_name_matched: { kind: "enum", values: ["yes", "no"] },
    travel_document_valid: { kind: "enum", values: ["yes", "no"] }, destination_eligible: { kind: "enum", values: ["yes", "no"] },
  });
  registerArtifactFieldSpecs(TYPE_VALIDATED_RECOVERY, {
    transport_option_id: { kind: "enum", values: ["TR-ALT-02"] }, accommodation_option_id: { kind: "enum", values: ["HT-03"] }, route_option_id: { kind: "enum", values: ["RT-HND-01"] },
    arrival_before_deadline: { kind: "enum", values: ["yes", "no"] }, total_additional_spend_sgd: { kind: "int", min: 0, max: 2000 }, approval_required: { kind: "enum", values: ["yes", "no"] }, confidence: { kind: "enum", values: ["high", "medium", "low"] },
  });
  registerArtifactFieldSpecs(TYPE_FINAL_RECOVERY, {
    transport_option_id: { kind: "enum", values: ["TR-ALT-02"] }, accommodation_option_id: { kind: "enum", values: ["HT-03"] }, route_option_id: { kind: "enum", values: ["RT-HND-01"] },
    final_arrival: { kind: "enum", values: ["2026-09-02T11:00:00+09:00"] }, total_additional_spend_sgd: { kind: "int", min: 0, max: 2000 }, approval_required: { kind: "enum", values: ["yes", "no"] }, status: { kind: "enum", values: ["ready_for_approval", "ready"] },
  });
}
