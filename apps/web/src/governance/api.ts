import { request } from "../api";
import type { GovernedRunView } from "./types";

export function getGovernedRun(runId: string, principalId: string): Promise<{ run: GovernedRunView }> {
  return request<{ run: GovernedRunView }>(
    "/api/governance/runs/" + encodeURIComponent(runId),
    { headers: { "x-principal-id": principalId } },
  );
}
