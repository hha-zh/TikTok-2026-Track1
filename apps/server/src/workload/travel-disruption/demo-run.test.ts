import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../agent-service.js";
import { createApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { GovernanceLedger } from "../../middleware/evidence/ledger.js";
import { RunTokenService } from "../../middleware/governance/run-token.js";
import { JsonStore } from "../../store.js";
import type { AgentRunner } from "../../types.js";
import { WorkspaceManager } from "../../workspace.js";
import { createWorkloadDescriptorResolver } from "../descriptor-registry.js";
import { formatFinalTravelRecoveryPlan } from "./demo-run.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe("live deterministic Travel demo bridge", () => {
  it("renders only the bounded final recovery fields", () => {
    const rendered = formatFinalTravelRecoveryPlan({ transport_option_id: "TR-ALT-02",
      accommodation_option_id: "HT-03", route_option_id: "RT-HND-01",
      final_arrival: "2026-09-02T11:00:00+09:00", total_additional_spend_sgd: 620,
      approval_required: "yes", status: "ready_for_approval" });
    expect(rendered).toContain("TR-ALT-02");
    expect(rendered).toContain("SGD 620");
    expect(rendered).toContain("Approval required:** Yes");
    expect(rendered).toContain("No booking has been made");
    expect(rendered).not.toContain("TRAVEL_RESULT_BEGIN");
  });
  it("keeps real execution opt-in and rejects an unsafe local-process setup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "travel-real-preflight-"));
    directories.push(directory);
    const store = new JsonStore(path.join(directory, "db.json"));
    await store.initialize();
    const ledger = new GovernanceLedger(store);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "travel-demo-test-token" }),
      service,
      { store, ledger, runTokens: new RunTokenService(Buffer.alloc(32, 42)) },
    );
    const response = await app.inject({ method: "POST", url: "/api/governance/travel-demo-runs",
      headers: { authorization: "Bearer travel-demo-test-token" },
      payload: { request: "real Travel", executionMode: "real" } });
    expect(response.statusCode).toBe(503);
    expect(store.snapshot().runStates).toHaveLength(0);
    await app.close();
  });

  it("returns unique readable runs and exposes real progressive evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "travel-demo-http-"));
    directories.push(directory);
    const store = new JsonStore(path.join(directory, "db.json"));
    await store.initialize();
    const ledger = new GovernanceLedger(store);
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "travel-demo-test-token" }),
      service,
      {
        store,
        ledger,
        runTokens: new RunTokenService(Buffer.alloc(32, 41)),
        governedRunDescriptor: createWorkloadDescriptorResolver(store),
      },
    );
    const headers = { authorization: "Bearer travel-demo-test-token" };
    const first = await app.inject({ method: "POST", url: "/api/governance/travel-demo-runs",
      headers, payload: { request: "matching deterministic Travel scenario" } });
    const second = await app.inject({ method: "POST", url: "/api/governance/travel-demo-runs",
      headers, payload: { request: "another invocation" } });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    const firstBody = first.json<{ runId: string; principalId: string }>();
    const secondBody = second.json<{ runId: string; principalId: string }>();
    expect(firstBody.principalId).toBe("travel-user");
    expect(firstBody.runId).not.toBe(secondBody.runId);

    const taskCounts = new Set<number>();
    const tokenUsage = new Set<number>();
    let finalView: Record<string, any> | undefined;
    let secondCompleted = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await app.inject({ method: "GET",
        url: `/api/governance/runs/${firstBody.runId}`,
        headers: { ...headers, "x-principal-id": firstBody.principalId } });
      expect(response.statusCode).toBe(200);
      const view = response.json<{ run: Record<string, any> }>().run;
      taskCounts.add(new Set(view.governanceEvents.flatMap((event: { taskId?: string }) =>
        event.taskId ? [event.taskId] : [])).size);
      tokenUsage.add(view.runtimeState.budgetHorizon.runTokens.used);
      finalView = view;
      const secondResponse = await app.inject({ method: "GET",
        url: `/api/governance/runs/${secondBody.runId}`,
        headers: { ...headers, "x-principal-id": secondBody.principalId } });
      expect(secondResponse.statusCode).toBe(200);
      secondCompleted = secondResponse.json<{ run: { run: { status: string } } }>()
        .run.run.status === "COMPLETED";
      const snapshot = store.snapshot();
      const terminal = (runId: string) => {
        const children = snapshot.envelopes.filter((envelope) =>
          envelope.runId === runId && envelope.parentGrantId !== undefined);
        return children.length === 3 && children.every((child) =>
          snapshot.grantStates.find((state) => state.grantId === child.id)?.revoked);
      };
      if (view.run.status === "COMPLETED" && secondCompleted
        && terminal(firstBody.runId) && terminal(secondBody.runId)) break;
      await pause(5);
    }

    expect(taskCounts.has(0) || [...taskCounts].some((count) => count < 7)).toBe(true);
    expect(taskCounts.has(7)).toBe(true);
    expect(tokenUsage.size).toBeGreaterThanOrEqual(3);
    expect(finalView?.run.status).toBe("COMPLETED");
    expect(secondCompleted).toBe(true);
    expect(finalView?.routingDecisions).toHaveLength(7);
    expect(finalView?.delegations).toHaveLength(3);
    expect(finalView?.contextProjections).toHaveLength(7);
    expect(finalView?.artifacts).toHaveLength(3);
    expect(finalView?.finalResult).toEqual({ type: "FinalTravelRecoveryPlan", quality: "OBSERVED",
      boundedFields: { transport_option_id: "TR-ALT-02", accommodation_option_id: "HT-03",
        route_option_id: "RT-HND-01", final_arrival: "2026-09-02T11:00:00+09:00",
        total_additional_spend_sgd: 620, approval_required: "yes", status: "ready_for_approval" } });
    expect(JSON.stringify(finalView?.finalResult)).not.toContain("TRAVEL_RESULT_BEGIN");
    expect(store.snapshot().agents).toHaveLength(0);
    await app.close();
  });

  it("persists the governed conversation and recovers it after reload without an ordinary Agent run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "travel-governed-conversation-"));
    directories.push(directory);
    const dataPath = path.join(directory, "data", "db.json");
    const workspacePath = path.join(directory, "workspaces");
    const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.dirname(dataPath),
      AGENT_WORKSPACE_ROOT: workspacePath, CODEX_HOME: path.join(directory, "codex"),
      APP_AUTH_TOKEN: "travel-demo-test-token" });
    let ordinaryRuns = 0;
    const runner: AgentRunner = { run: async () => { ordinaryRuns += 1; throw new Error("ordinary path invoked"); },
      cancel: async () => false, isAvailable: async () => true };
    const store = new JsonStore(dataPath);
    const agents = new AgentService(config, store, new WorkspaceManager(workspacePath), runner);
    await agents.initialize();
    const travelAgent = await agents.createAgent({ name: "Travel Recovery Assistant" });
    const ledger = new GovernanceLedger(store);
    const app = await createApp(config, agents, { store, ledger,
      runTokens: new RunTokenService(Buffer.alloc(32, 43)),
      governedRunDescriptor: createWorkloadDescriptorResolver(store) });
    const headers = { authorization: "Bearer travel-demo-test-token" };
    const started = await app.inject({ method: "POST", url: "/api/governance/travel-demo-runs",
      headers, payload: { request: "recover my governed trip", agentId: travelAgent.id } });
    expect(started.statusCode).toBe(202);
    expect(agents.getAgent(travelAgent.id).status).toBe("busy");
    await expect.poll(() => agents.getAgent(travelAgent.id).status).toBe("ready");
    expect(ordinaryRuns).toBe(0);
    expect(store.snapshot().runs).toHaveLength(0);

    const reloadedStore = new JsonStore(dataPath);
    const reloaded = new AgentService(config, reloadedStore,
      new WorkspaceManager(workspacePath), runner);
    await reloaded.initialize();
    const messages = reloaded.getMessages(travelAgent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.content).toBe("recover my governed trip");
    expect(messages[1]?.content).toContain("Recovery plan ready");
    expect(messages[1]?.content).not.toContain("TRAVEL_RESULT_BEGIN");
    expect(new Set(messages.map((message) => message.runId))).toEqual(
      new Set([started.json<{ runId: string }>().runId]));
    await app.close();
  });
});
