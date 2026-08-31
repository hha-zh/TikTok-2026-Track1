import type { GovernedRunDescriptor } from "../../middleware/evidence/governed-run-view.js";
import type { TravelOracle } from "./oracle.js";
import { buildTravelGraph } from "./graph.js";

export function travelRunDescriptor(oracle: TravelOracle): GovernedRunDescriptor {
  return {
    workload: {
      id: "travel-disruption-v1",
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
      oracle: oracle.domain,
    },
    governanceOracle: oracle.governance,
    adaptiveOracle: oracle.adaptive,
    lifecycleOracle: oracle.lifecycle,
    executionProvenance: "DETERMINISTIC_SYNTHETIC_FIXTURE",
  };
}
