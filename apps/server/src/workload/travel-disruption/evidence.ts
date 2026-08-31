import type { GovernedRunDescriptor } from "../../middleware/evidence/governed-run-view.js";
import type { TravelOracle } from "./oracle.js";
import { buildTravelGraph } from "./graph.js";

export const TRAVEL_WORKLOAD_ID = "travel-disruption-v1";
export const TRAVEL_DESCRIPTOR_VERSION = "1";

export function travelRunDescriptor(oracle?: TravelOracle): GovernedRunDescriptor {
  return {
    workload: {
      id: TRAVEL_WORKLOAD_ID,
      scenario: "cancelled-sin-to-tokyo-recovery",
      graph: buildTravelGraph(),
    },
    domain: {
      summary: {
        route: { origin: "SIN", destination: "TOKYO" },
        arrivalDeadline: "2026-09-02T13:00:00+09:00",
        spendingConstraint: { currency: "SGD", maximumAdditionalSpend: 700 },
        approvalPolicy: { currency: "SGD", threshold: 300 },
      },
      ...(oracle ? { oracle: oracle.domain } : {}),
    },
    ...(oracle ? {
      governanceOracle: oracle.governance,
      adaptiveOracle: oracle.adaptive,
      lifecycleOracle: oracle.lifecycle,
    } : {}),
    executionProvenance: "DETERMINISTIC_SYNTHETIC_FIXTURE",
  };
}
