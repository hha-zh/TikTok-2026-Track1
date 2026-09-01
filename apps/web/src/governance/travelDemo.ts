import { request } from "../api";

export interface GovernanceBinding {
  runId: string;
  principalId: string;
  displayName?: string;
}

export const isTravelDemoAgent = (name: string) =>
  name.trim().toLowerCase() === "travel recovery assistant";

export type TravelExecutionMode = "deterministic" | "real";

export function startTravelDemo(
  requestText: string,
  executionMode: TravelExecutionMode = "deterministic",
): Promise<GovernanceBinding> {
  return request<GovernanceBinding>("/api/governance/travel-demo-runs", {
    method: "POST",
    body: JSON.stringify({ request: requestText, executionMode }),
  });
}

/** Final user-facing Travel flow: real evidence or an explicit failure, never fixture fallback. */
export function startUserTravelDemo(requestText: string, agentId: string): Promise<GovernanceBinding> {
  return request<GovernanceBinding>("/api/governance/travel-demo-runs", {
    method: "POST",
    body: JSON.stringify({ request: requestText, executionMode: "real", agentId }),
  });
}
