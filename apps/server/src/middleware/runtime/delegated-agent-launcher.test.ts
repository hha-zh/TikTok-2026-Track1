import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../../agent-service.js";
import { createApp } from "../../app.js";
import { agentCodexHome } from "../../container-codex-runner.js";
import { loadConfig } from "../../config.js";
import { JsonStore } from "../../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../../types.js";
import { WorkspaceManager } from "../../workspace.js";
import { GovernanceLedger } from "../evidence/ledger.js";
import { DelegationService, type ChildEnvelopeRequest } from "../governance/delegation.js";
import type { AuthenticatedIdentity } from "../governance/identity.js";
import { RunTokenService } from "../governance/run-token.js";
import { DelegatedAgentLauncher } from "./delegated-agent-launcher.js";

const roots: string[] = [];
const services: AgentService[] = [];
afterEach(async () => {
  // Drain before removing the temp dirs. sendMessage resolves once a run is
  // queued and executeRun keeps writing to the store afterwards, so cleanup
  // otherwise races those writes and fails intermittently with ENOTEMPTY.
  await Promise.all(
    services.splice(0).map((service) => service.drainActiveExecutions()),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class CapturingRunner implements AgentRunner {
  readonly requests: RunnerRequest[] = [];

  constructor(private readonly fail = false) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.requests.push(structuredClone(request));
    if (this.fail) throw new Error("runner failed before governed execution");
    return { output: "fixed harmless child result", threadId: "child-thread", usage: null };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const authority: ChildEnvelopeRequest = {
  exercisable: { resources: ["sec/INC-42"], actions: ["read"] },
  delegatable: { resources: [], actions: [] },
  maxTokens: 500,
  maxToolCalls: 5,
  maxChildren: 0,
};
const task = "Read the delegated harmless resource and return only a fixed classification.";

async function harness(runner = new CapturingRunner()) {
  const root = await mkdtemp(path.join(tmpdir(), "live-governed-child-"));
  roots.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex-home"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    RUNTIME_PROVIDER: "container",
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const agents = new AgentService(config, store, workspaces, runner);
  services.push(agents);
  await agents.initialize();
  const parentAgent = await agents.createAgent({ name: "Real parent Agent" });
  await store.mutate((database) => {
    database.agents.find((item) => item.id === parentAgent.id)!.codexThreadId = "parent-thread";
    database.principals.push(
      { id: "wtan", kind: "human" },
      { id: "agent-parent", kind: "agent", ownerId: "wtan", parentPrincipalId: "wtan" },
    );
    database.envelopes.push({
      id: "grant-parent",
      principalId: "agent-parent",
      exercisable: { resources: ["app/*"], actions: ["read", "delegate"] },
      delegatable: { resources: ["sec/INC-42"], actions: ["read"] },
      depth: 1,
      maxTokens: 800,
      maxToolCalls: 10,
      maxChildren: 2,
      runId: "governance-run",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    database.grantStates.push({ grantId: "grant-parent", revoked: false, tokensUsed: 100, childCount: 0 });
    database.runStates.push({ runId: "governance-run", maxTokens: 1200, tokensUsed: 200 });
    database.mockResources.push({ id: "sec/INC-42", ownerId: "wtan", domain: "sec", body: { marker: "harmless-delegated-body" } });
  });
  const runTokens = new RunTokenService(Buffer.alloc(32, 43));
  const ledger = new GovernanceLedger(store);
  const app = await createApp(config, agents, { store, runTokens, ledger });
  const parentToken = runTokens.mint({ runId: "governance-run", principalId: "agent-parent", grantId: "grant-parent", exp: 4_102_444_800 });
  const response = await app.inject({
    method: "POST",
    url: "/api/delegations",
    headers: { authorization: `Bearer ${parentToken}` },
    payload: { ...authority, task },
  });
  return { root, config, store, runner, agents, app, runTokens, parentAgent, parentToken, response };
}

async function capturedChild(requests: RunnerRequest[]) {
  await expect.poll(() => requests.length).toBe(1);
  return requests[0]!;
}

describe("live governed child integration", () => {
  it("creates a real Agent and returns only a real queued ChildHandle", async () => {
    const { response, store, runner, app } = await harness();
    expect(response.statusCode).toBe(201);
    const handle = response.json();
    expect(handle.status).toBe("queued");
    expect(store.snapshot().agents.some((item) => item.id === handle.childAgentId)).toBe(true);
    expect(store.snapshot().principals.some((item) => item.id === handle.childPrincipalId)).toBe(true);
    expect(store.snapshot().envelopes.some((item) => item.id === handle.grantId)).toBe(true);
    expect(response.body).not.toContain("fixed harmless child result");
    expect(response.body).not.toContain("bouncer.v1");
    await capturedChild(runner.requests);
    await app.close();
  });

  it("passes an ephemeral token bound only to the child identity/grant/run", async () => {
    const { response, store, runner, runTokens, parentToken, app } = await harness();
    const handle = response.json();
    const runnerRequest = await capturedChild(runner.requests);
    expect(runnerRequest.runtimeRunToken).toBeTruthy();
    expect(runnerRequest.runtimeRunToken).not.toBe(parentToken);
    const claims = runTokens.verify(runnerRequest.runtimeRunToken!);
    expect(claims).toMatchObject({ principalId: handle.childPrincipalId, grantId: handle.grantId, runId: "governance-run" });
    expect(claims.grantId).not.toBe("grant-parent");
    const serialized = JSON.stringify(store.snapshot());
    expect(serialized).not.toContain(runnerRequest.runtimeRunToken);
    expect(store.snapshot().governanceEvents.every((event) => !JSON.stringify(event).includes(runnerRequest.runtimeRunToken!))).toBe(true);
    expect(store.snapshot().messages.every((message) => !message.content.includes(runnerRequest.runtimeRunToken!))).toBe(true);
    await app.close();
  });

  it("uses isolated workspace, CODEX_HOME and a fresh thread without copying resources", async () => {
    const { config, response, store, runner, parentAgent, app } = await harness();
    const handle = response.json();
    const childAgent = store.snapshot().agents.find((item) => item.id === handle.childAgentId)!;
    const runnerRequest = await capturedChild(runner.requests);
    expect(childAgent.workspacePath).not.toBe(parentAgent.workspacePath);
    expect(runnerRequest.workspacePath).toBe(childAgent.workspacePath);
    expect(runnerRequest.threadId).toBeNull();
    expect(agentCodexHome(config.codexHome, childAgent.id)).not.toBe(agentCodexHome(config.codexHome, parentAgent.id));
    for (const workspace of [childAgent.workspacePath, parentAgent.workspacePath]) {
      const contents = await Promise.all((await readdir(workspace)).map((name) => readFile(path.join(workspace, name), "utf8")));
      expect(contents.join("\n")).not.toContain("harmless-delegated-body");
    }
    await app.close();
  });

  it("keeps parent denied while the live-generated child callback is allowed", async () => {
    const { app, response, runner, parentToken } = await harness();
    const childRequest = await capturedChild(runner.requests);
    const parent = await app.inject({ method: "GET", url: "/api/resources/sec/INC-42", headers: { authorization: `Bearer ${parentToken}` } });
    expect(parent.statusCode).toBe(403);
    expect(parent.json().reason).toBe("NOT_EXERCISABLE_DELEGATE_ONLY");
    const child = await app.inject({ method: "GET", url: "/api/resources/sec/INC-42", headers: { authorization: `Bearer ${childRequest.runtimeRunToken}` } });
    expect(child.statusCode).toBe(200);
    expect(response.json().childPrincipalId).toBeTruthy();
    await app.close();
  });

  it("invalidates the same live child token when the human revokes its parent", async () => {
    const { app, runner } = await harness();
    const childRequest = await capturedChild(runner.requests);
    const token = childRequest.runtimeRunToken!;
    expect((await app.inject({ method: "GET", url: "/api/resources/sec/INC-42", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/envelopes/grant-parent/revoke", headers: { "x-principal-id": "wtan" } })).statusCode).toBe(200);
    const denied = await app.inject({ method: "GET", url: "/api/resources/sec/INC-42", headers: { authorization: `Bearer ${token}` } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().reason).toBe("PARENT_GRANT_REVOKED");
    await app.close();
  });

  it("increments the real parent child count exactly once", async () => {
    const { store, app } = await harness();
    expect(store.snapshot().grantStates.find((item) => item.grantId === "grant-parent")?.childCount).toBe(1);
    await app.close();
  });

  it("revokes child authority when asynchronous runner startup fails", async () => {
    const { response, store, app } = await harness(new CapturingRunner(true));
    expect(response.statusCode).toBe(201);
    const grantId = response.json().grantId;
    await expect.poll(() => store.snapshot().grantStates.find((item) => item.grantId === grantId)?.revoked).toBe(true);
    await app.close();
  });

  it("does not allow ordinary Playground HTTP input to inject runtimeRunToken", async () => {
    const { agents, app, runner } = await harness();
    await capturedChild(runner.requests);
    const ordinary = await agents.createAgent({ name: "Ordinary Agent" });
    const response = await app.inject({ method: "POST", url: `/api/agents/${ordinary.id}/messages`, payload: { content: "ordinary task", runtimeRunToken: "attacker-token" } });
    expect(response.statusCode).toBe(202);
    await expect.poll(() => runner.requests.length).toBe(2);
    expect(runner.requests[1]?.runtimeRunToken).toBeUndefined();
    await app.close();
  });

  it("rejects widening before creating a real Agent or child authority", async () => {
    const base = await harness();
    const agentsBefore = base.store.snapshot().agents.length;
    const envelopesBefore = base.store.snapshot().envelopes.length;
    const response = await base.app.inject({
      method: "POST", url: "/api/delegations",
      headers: { authorization: `Bearer ${base.parentToken}` },
      payload: { ...authority, task, exercisable: { resources: ["payments/private"], actions: ["read"] } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().reason).toBe("CHILD_EXCEEDS_PARENT");
    expect(base.store.snapshot().agents).toHaveLength(agentsBefore);
    expect(base.store.snapshot().envelopes).toHaveLength(envelopesBefore);
    await base.app.close();
  });
});

describe("live launch compensation", () => {
  async function compensationFixture() {
    const base = await harness();
    await base.app.close();
    const identity: Extract<AuthenticatedIdentity, { kind: "agent" }> = {
      kind: "agent", principalId: "agent-parent", grantId: "grant-parent", runId: "governance-run",
      principal: base.store.snapshot().principals.find((item) => item.id === "agent-parent")!,
    };
    const ledger = new GovernanceLedger(base.store);
    const delegation = new DelegationService({ store: base.store, ledger });
    return { ...base, identity, ledger, delegation };
  }

  it("revokes newly created child authority when real Agent creation fails", async () => {
    const base = await compensationFixture();
    const launcher = new DelegatedAgentLauncher({
      config: base.config, store: base.store, ledger: base.ledger, runTokens: base.runTokens,
      delegation: base.delegation,
      agents: {
        createAgent: async () => { throw new Error("creation failed"); },
        sendGovernedMessage: async () => { throw new Error("unreachable"); },
        deleteAgent: async () => ({ archivedWorkspace: "unused" }),
      },
    });
    expect((await launcher.launch(base.identity, authority, task)).ok).toBe(false);
    const child = base.store.snapshot().envelopes.filter((item) => item.parentGrantId === "grant-parent").at(-1)!;
    expect(base.store.snapshot().grantStates.find((item) => item.grantId === child.id)?.revoked).toBe(true);
  });

  it("fails closed before authority creation for local-process execution", async () => {
    const base = await compensationFixture();
    const envelopesBefore = base.store.snapshot().envelopes.length;
    const launcher = new DelegatedAgentLauncher({
      config: { ...base.config, runtimeProvider: "local-process" },
      store: base.store,
      ledger: base.ledger,
      runTokens: base.runTokens,
      delegation: base.delegation,
      agents: base.agents,
    });
    expect(await launcher.launch(base.identity, authority, task)).toEqual({
      ok: false,
      statusCode: 503,
      reason: "MALFORMED_INPUT",
    });
    expect(base.store.snapshot().envelopes).toHaveLength(envelopesBefore);
  });

  it("revokes child authority and cleans up the Agent when scheduling fails", async () => {
    const base = await compensationFixture();
    const governedAgentsBefore = base.store.snapshot().agents.filter((item) => item.name.startsWith("Governed child")).length;
    const launcher = new DelegatedAgentLauncher({
      config: base.config, store: base.store, ledger: base.ledger, runTokens: base.runTokens,
      delegation: base.delegation,
      agents: {
        createAgent: (input) => base.agents.createAgent(input),
        sendGovernedMessage: async () => { throw new Error("schedule failed"); },
        deleteAgent: (id) => base.agents.deleteAgent(id),
      },
    });
    expect((await launcher.launch(base.identity, authority, task)).ok).toBe(false);
    const database = base.store.snapshot();
    const child = database.envelopes.filter((item) => item.parentGrantId === "grant-parent").at(-1)!;
    expect(database.grantStates.find((item) => item.grantId === child.id)?.revoked).toBe(true);
    expect(database.agents.filter((item) => item.name.startsWith("Governed child"))).toHaveLength(governedAgentsBefore);
  });
});
