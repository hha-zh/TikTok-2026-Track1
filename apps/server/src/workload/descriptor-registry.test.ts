import { afterEach, describe, expect, it } from "vitest";
import { buildGovernedRunView } from "../middleware/evidence/governed-run-view.js";
import { createApp } from "../app.js";
import type { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { GovernanceLedger } from "../middleware/evidence/ledger.js";
import { RunTokenService } from "../middleware/governance/run-token.js";
import type { TravelLifecycleResult } from "./travel-disruption/run.js";
import { runTravelLifecycle } from "./travel-disruption/run.js";
import {
  T1_TRANSPORT,
  T4_IDENTITY,
} from "./travel-disruption/graph.js";
import { createWorkloadDescriptorResolver } from "./descriptor-registry.js";

const lifecycles: TravelLifecycleResult[] = [];

afterEach(async () => {
  await Promise.all(lifecycles.splice(0).map((lifecycle) => lifecycle.cleanup()));
});

describe("production workload descriptor resolution", () => {
  it("resolves durable Travel metadata into declared task-graph truth", async () => {
    const lifecycle = await runTravelLifecycle("registry-travel-run");
    lifecycles.push(lifecycle);
    const metadata = lifecycle.store.snapshot().runStates.find((state) =>
      state.runId === lifecycle.runId)?.workloadDescriptor;
    expect(metadata).toEqual({ workloadId: "travel-disruption-v1", descriptorVersion: "1" });

    const descriptor = createWorkloadDescriptorResolver(lifecycle.store)(lifecycle.runId);
    const service = { listAgents: () => [], systemInfo: async () => ({}) } as unknown as AgentService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, {
      store: lifecycle.store,
      runTokens: new RunTokenService(Buffer.alloc(32, 23)),
      ledger: new GovernanceLedger(lifecycle.store),
      governedRunDescriptor: createWorkloadDescriptorResolver(lifecycle.store),
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/governance/runs/${lifecycle.runId}`,
      headers: { "x-principal-id": "travel-user" },
    });
    await app.close();
    expect(response.statusCode).toBe(200);
    const view = response.json<{ run: ReturnType<typeof buildGovernedRunView> }>().run;
    expect(view?.run.workload).toEqual({
      id: "travel-disruption-v1",
      scenario: "cancelled-sin-to-tokyo-recovery",
      quality: "DECLARED",
    });
    expect(view?.tasks).toHaveLength(7);
    expect(view?.tasks.every((task) => task.label.quality === "DECLARED"
      && task.required.quality === "DECLARED"
      && task.dependencies.quality === "DECLARED"
      && task.producedArtifacts.quality === "DECLARED"
      && task.statusQuality === "DERIVED")).toBe(true);
    const transport = view?.tasks.find((task) => task.taskId === T1_TRANSPORT);
    expect(transport?.required.value).toBe(true);
    expect(transport?.producedArtifacts.value)
      .toEqual([{ id: "transport_options", type: "TransportOptions" }]);
    expect(view?.tasks.find((task) => task.taskId === T4_IDENTITY)?.dependencies.value?.artifacts)
      .toEqual(["travel_constraints", "route_plan"]);
  });

  it.each([
    ["unknown workload", { workloadId: "unknown", descriptorVersion: "1" }],
    ["unknown descriptor version", { workloadId: "travel-disruption-v1", descriptorVersion: "999" }],
  ])("returns UNAVAILABLE for %s", async (_label, workloadDescriptor) => {
    const lifecycle = await runTravelLifecycle(`registry-${workloadDescriptor.descriptorVersion}-${workloadDescriptor.workloadId}`);
    lifecycles.push(lifecycle);
    await lifecycle.store.mutate((database) => {
      const state = database.runStates.find((item) => item.runId === lifecycle.runId);
      if (!state) throw new Error("run state missing");
      state.workloadDescriptor = workloadDescriptor;
    });
    const descriptor = createWorkloadDescriptorResolver(lifecycle.store)(lifecycle.runId);
    expect(descriptor).toBeUndefined();
    const view = buildGovernedRunView(lifecycle.store, lifecycle.runId, descriptor);
    expect(view?.run.workload).toBeNull();
    expect(view?.tasks.every((task) => task.label.quality === "UNAVAILABLE"
      && task.required.quality === "UNAVAILABLE"
      && task.dependencies.quality === "UNAVAILABLE"
      && task.producedArtifacts.quality === "UNAVAILABLE"
      && task.statusQuality === "DERIVED")).toBe(true);
  });

  it.each([
    ["missing descriptor metadata", undefined],
    ["legacy partial descriptor metadata", { workloadId: "travel-disruption-v1" }],
  ])("keeps descriptor-backed fields UNAVAILABLE for %s", async (_label, workloadDescriptor) => {
    const lifecycle = await runTravelLifecycle(`registry-legacy-${lifecycles.length}`);
    lifecycles.push(lifecycle);
    await lifecycle.store.mutate((database) => {
      const state = database.runStates.find((item) => item.runId === lifecycle.runId);
      if (!state) throw new Error("run state missing");
      if (workloadDescriptor === undefined) delete state.workloadDescriptor;
      else state.workloadDescriptor = workloadDescriptor as typeof state.workloadDescriptor;
    });
    const descriptor = createWorkloadDescriptorResolver(lifecycle.store)(lifecycle.runId);
    expect(descriptor).toBeUndefined();
    const view = buildGovernedRunView(lifecycle.store, lifecycle.runId, descriptor);
    expect(view?.run.workload).toBeNull();
    expect(view?.tasks.length).toBeGreaterThan(0);
    expect(view?.tasks.every((task) => task.label.quality === "UNAVAILABLE"
      && task.required.quality === "UNAVAILABLE"
      && task.dependencies.quality === "UNAVAILABLE"
      && task.producedArtifacts.quality === "UNAVAILABLE"
      && task.statusQuality === "DERIVED")).toBe(true);
  });
});
