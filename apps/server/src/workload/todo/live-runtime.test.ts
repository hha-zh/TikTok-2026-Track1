/**
 * Real AgentService integration.
 *
 * Everything below the model is real: AgentService, Agent persistence,
 * workspace allocation, RunnerRequest construction, DelegationService, the
 * DelegatedAgentLauncher, child Principal/Grant, and the child RUN_TOKEN
 * handoff. Only the model itself is substituted, by an AgentRunner that
 * verifies its token and then crosses the SAME gates a container would reach
 * over HTTP.
 *
 * So this proves the real AgentService crossing without Docker or Ark. It does
 * not prove Codex or Volcengine; that is a separate probe and is reported
 * separately.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../agent-service.js";
import { loadConfig } from "../../config.js";
import { JsonStore } from "../../store.js";
import { WorkspaceManager } from "../../workspace.js";
import { ExecutionEngine } from "../../middleware/adaptive/execution-engine.js";
import { GovernanceLedger } from "../../middleware/evidence/ledger.js";
import { DelegationService } from "../../middleware/governance/delegation.js";
import {
  RESOURCE_PAYMENTS,
  seedGovernanceFixtures,
  startGovernedRun,
} from "../../middleware/governance/fixtures.js";
import { RunTokenService } from "../../middleware/governance/run-token.js";
import { DelegatedAgentLauncher } from "../../middleware/runtime/delegated-agent-launcher.js";
import { ARTIFACT_TEST_PLAN, ARTIFACT_UI_PLAN } from "./artifacts.js";
import {
  ARTIFACT_IMPLEMENTATION,
  ARTIFACT_TEST_PLAN_RESULT,
  ARTIFACT_UI_PLAN_RESULT,
  ARTIFACT_WORKSPACE_SUMMARY,
  buildTodoGraph,
  TASK_IMPLEMENTATION,
  TASK_TEST_PLAN,
  TASK_UI_PLAN,
  TASK_WORKSPACE_SCAN,
} from "./graph.js";
import { createLiveTodoRuntime, GovernedProbeRunner } from "./live-runtime.js";
import { seedTodoWorkload, TODO_DELEGATABLE_RESOURCES } from "./seed.js";

const roots: string[] = [];
const services: AgentService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.drainActiveExecutions()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const TOKEN_TTL_SECONDS = 15 * 60;

async function liveHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "todo-live-"));
  roots.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex-home"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    // The launcher refuses anything else, which this also proves.
    RUNTIME_PROVIDER: "container",
  });

  const store = new JsonStore(path.join(root, "data", "db.json"));
  const ledger = new GovernanceLedger(store);
  const runTokens = new RunTokenService();
  const runner = new GovernedProbeRunner(store, ledger, runTokens);
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const agents = new AgentService(config, store, workspaces, runner);
  services.push(agents);
  await agents.initialize();

  await seedGovernanceFixtures(store);
  await seedTodoWorkload(store);
  const governed = await startGovernedRun(store, ledger, {
    runId: "run-1",
    additionalDelegatableResources: TODO_DELEGATABLE_RESOURCES,
  });

  const parentAgent = await agents.createAgent({ name: "Root Todo Agent" });
  const parentRunToken = runTokens.mint({
    runId: "run-1",
    principalId: governed.principal.id,
    grantId: governed.envelope.id,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  });

  const launcher = new DelegatedAgentLauncher({
    config,
    store,
    ledger,
    runTokens,
    delegation: new DelegationService({ store, ledger }),
    agents,
  });

  const runtime = createLiveTodoRuntime({
    store,
    ledger,
    agents,
    launcher,
    parentAgentId: parentAgent.id,
    parentRunToken,
  });

  const engine = new ExecutionEngine({
    store,
    ledger,
    executor: runtime.executor,
    delegation: runtime.delegation,
  });

  return {
    store,
    ledger,
    runTokens,
    runner,
    agents,
    parentAgent,
    parentRunToken,
    runtime,
    engine,
    governed,
    identity: {
      principal: governed.principal,
      grantId: governed.envelope.id,
      runId: "run-1",
    },
  };
}

const requestFor = (runner: GovernedProbeRunner, taskId: string) =>
  runner.requests.find((request) => request.prompt.includes(`[bouncer-task:${taskId}]`));

describe("Live AgentService integration", () => {
  it("runs the whole Todo graph through real Agents", async () => {
    const { engine, identity } = await liveHarness();
    const result = await engine.run(buildTodoGraph(), identity);
    expect(result.outcome).toBe("COMPLETED");
    expect(result.progress.completed.has(TASK_IMPLEMENTATION)).toBe(true);
  });

  it("executes a REUSE task under the root Agent", async () => {
    const { engine, identity, runner, parentAgent } = await liveHarness();
    await engine.run(buildTodoGraph(), identity);
    expect(requestFor(runner, TASK_WORKSPACE_SCAN)?.agentId).toBe(parentAgent.id);
  });

  it("creates a real Starter Kit child Agent for a DELEGATE task", async () => {
    const { engine, identity, runtime, store, parentAgent } = await liveHarness();
    await engine.run(buildTodoGraph(), identity);

    const child = runtime.launched.find((item) => item.taskId === TASK_UI_PLAN);
    expect(child).toBeDefined();
    const agents = store.snapshot().agents;
    const childAgent = agents.find((item) => item.id === child?.childAgentId);
    expect(childAgent).toBeDefined();
    // A distinct Agent with a distinct workspace.
    expect(childAgent?.id).not.toBe(parentAgent.id);
    expect(childAgent?.workspacePath).not.toBe(
      agents.find((item) => item.id === parentAgent.id)?.workspacePath,
    );
  });

  it("hands the CHILD run token to the child's RunnerRequest", async () => {
    const { engine, identity, runner, runtime, runTokens } = await liveHarness();
    await engine.run(buildTodoGraph(), identity);

    const child = runtime.launched.find((item) => item.taskId === TASK_UI_PLAN);
    const request = requestFor(runner, TASK_UI_PLAN);
    expect(request?.agentId).toBe(child?.childAgentId);
    expect(request?.runtimeRunToken).toBeTruthy();

    // It verifies to the CHILD principal and grant, in the same governed run.
    const claims = runTokens.verify(request?.runtimeRunToken ?? "");
    expect(claims.principalId).toBe(child?.childPrincipalId);
    expect(claims.grantId).toBe(child?.grantId);
    expect(claims.runId).toBe("run-1");
  });

  it("never reuses the parent token for child execution", async () => {
    const { engine, identity, runner, parentRunToken } = await liveHarness();
    await engine.run(buildTodoGraph(), identity);

    const childRequests = [TASK_UI_PLAN, TASK_TEST_PLAN]
      .map((taskId) => requestFor(runner, taskId))
      .filter((request) => request !== undefined);
    expect(childRequests).toHaveLength(2);
    for (const request of childRequests) {
      expect(request.runtimeRunToken).not.toBe(parentRunToken);
    }
    // Each child gets its own.
    expect(childRequests[0]?.runtimeRunToken).not.toBe(
      childRequests[1]?.runtimeRunToken,
    );
  });

  it("keeps ordinary Playground input from injecting a runtimeRunToken", async () => {
    const { agents, runner, parentAgent } = await liveHarness();
    // The ungoverned path must never carry a token, whatever the caller sends.
    await agents.sendMessage(
      parentAgent.id,
      "[bouncer-task:workspace_scan] ordinary playground request",
    );
    await agents.drainActiveExecutions();
    const ordinary = runner.requests.at(-1);
    expect(ordinary?.runtimeRunToken).toBeUndefined();
  });
});

describe("Live AgentService integration — projected context reaches the Agent", () => {
  it("gives a delegated planner the workspace_summary it requires", async () => {
    const { engine, identity, runner } = await liveHarness();
    await engine.run(buildTodoGraph(), identity);
    const prompt = requestFor(runner, TASK_UI_PLAN)?.prompt ?? "";
    expect(prompt).toContain("CONTEXT:");
    expect(prompt).toContain(ARTIFACT_WORKSPACE_SUMMARY);
  });

  it("gives it nothing the ContextBroker withheld", async () => {
    const { engine, identity, runner } = await liveHarness();
    await engine.run(buildTodoGraph(), identity);
    const prompt = requestFor(runner, TASK_UI_PLAN)?.prompt ?? "";
    // The sibling's plan and the parent's later output are not this task's.
    expect(prompt).not.toContain(ARTIFACT_TEST_PLAN_RESULT);
    expect(prompt).not.toContain(ARTIFACT_IMPLEMENTATION);
    // A withheld artifact must leave no trace at all - not even its reason.
    expect(prompt).not.toContain("NOT_REQUIRED");
    expect(prompt).not.toContain("withheld");
  });

  it("gives implementation both published plans and no child raw output", async () => {
    const { engine, identity, runner } = await liveHarness();
    await engine.run(buildTodoGraph(), identity);
    const prompt = requestFor(runner, TASK_IMPLEMENTATION)?.prompt ?? "";
    expect(prompt).toContain(ARTIFACT_UI_PLAN_RESULT);
    expect(prompt).toContain(ARTIFACT_TEST_PLAN_RESULT);
    // Bounded published fields only - these came through the Return Gate.
    expect(prompt).toContain("split_panel");
    expect(prompt).toContain("core_and_edge");
    // And nothing the children said.
    expect(prompt).not.toContain("published");
    expect(prompt).not.toContain("assistant");
  });

  it("sends a projected context packet on BOTH placements", async () => {
    const { engine, identity, runner } = await liveHarness();
    await engine.run(buildTodoGraph(), identity);
    for (const taskId of [TASK_WORKSPACE_SCAN, TASK_UI_PLAN, TASK_IMPLEMENTATION]) {
      expect(requestFor(runner, taskId)?.prompt).toContain("CONTEXT:");
    }
    // workspace_scan requires nothing, so its packet is empty rather than absent.
    expect(requestFor(runner, TASK_WORKSPACE_SCAN)?.prompt).toContain(
      '{"artifacts":[]}',
    );
  });

  it("prepares the child before dispatching it, not at delegation time", async () => {
    const { engine, identity, runtime } = await liveHarness();
    await engine.run(buildTodoGraph(), identity);
    // Every prepared child was explicitly dispatched by the executor, after
    // the engine had projected its context.
    expect(runtime.launched).toHaveLength(2);
    expect(runtime.launched.every((child) => child.dispatched)).toBe(true);
  });
});

describe("Live AgentService integration — Return Gate still mandatory", () => {
  it("admits the plans only as published bounded artifacts", async () => {
    const { engine, identity, store, runtime } = await liveHarness();
    const result = await engine.run(buildTodoGraph(), identity);

    const published = store.snapshot().artifacts.filter((item) => item.published);
    expect(published.map((item) => item.type).sort()).toEqual([
      ARTIFACT_TEST_PLAN,
      ARTIFACT_UI_PLAN,
    ]);
    // Published by the CHILD principals, to the parent.
    const childPrincipals = runtime.launched.map((item) => item.childPrincipalId);
    for (const artifact of published) {
      expect(childPrincipals).toContain(artifact.ownerPrincipalId);
      expect(artifact.recipients).toEqual([identity.principal.id]);
    }
    // The engine admitted them as published, never as raw child output.
    expect(
      result.artifacts
        .filter((item) => item.origin === "published_finding")
        .map((item) => item.id)
        .sort(),
    ).toEqual([TASK_TEST_PLAN, TASK_UI_PLAN]);
  });

  it("still lets the backend refuse the cross-principal read", async () => {
    const { engine, identity, runner, store } = await liveHarness();
    const result = await engine.run(buildTodoGraph(), identity);

    // The real gate refused, through the real runner identity.
    expect(runner.denials).toEqual([
      {
        taskId: TASK_WORKSPACE_SCAN,
        resourceId: RESOURCE_PAYMENTS,
        reason: "RESOURCE_NOT_GRANTED",
      },
    ]);
    expect(
      store.snapshot().governanceEvents.filter((e) => e.kind === "resource_denied"),
    ).toHaveLength(1);
    expect(result.outcome).toBe("COMPLETED");
  });
});
