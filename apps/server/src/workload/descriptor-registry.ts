import type { GovernedRunDescriptor } from "../middleware/evidence/governed-run-view.js";
import type { JsonStore } from "../store.js";
import {
  TRAVEL_DESCRIPTOR_VERSION,
  TRAVEL_WORKLOAD_ID,
  travelRunDescriptor,
} from "./travel-disruption/evidence.js";

type DescriptorFactory = () => GovernedRunDescriptor;

const descriptorFactories = new Map<string, DescriptorFactory>([
  [`${TRAVEL_WORKLOAD_ID}:${TRAVEL_DESCRIPTOR_VERSION}`, () => travelRunDescriptor()],
]);

/** Application-composition resolver. Generic middleware never imports workload code. */
export function createWorkloadDescriptorResolver(store: JsonStore) {
  return (runId: string): GovernedRunDescriptor | undefined => {
    const metadata = store.snapshot().runStates.find((state) => state.runId === runId)
      ?.workloadDescriptor;
    if (!metadata) return undefined;
    return descriptorFactories
      .get(`${metadata.workloadId}:${metadata.descriptorVersion}`)?.();
  };
}
