import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("lists only user-created Agents while retaining runtime Agents internally", async () => {
    const service = await makeService();
    const user = await service.createAgent({ name: "Travel Recovery Assistant" });
    const runtimeRoot = await service.createAgent({ name: "Runtime root", origin: "governed-runtime" });
    const runtimeChild = await service.createAgent({ name: "Runtime child", origin: "governed-runtime" });

    expect(service.listAgents().map((agent) => agent.id)).toEqual([user.id]);
    expect(service.getAgent(runtimeRoot.id).origin).toBe("governed-runtime");
    expect(service.getAgent(runtimeChild.id).origin).toBe("governed-runtime");
  });

  it("persists a governed conversation without invoking the runner and restores READY", async () => {
    let calls = 0;
    const service = await makeService({ run: async () => { calls += 1; throw new Error("must not run"); },
      cancel: async () => false, isAvailable: async () => true });
    const agent = await service.createAgent({ name: "Travel Recovery Assistant" });
    await service.beginGovernedConversation(agent.id, "governed-run", "recover my trip");
    expect(service.getAgent(agent.id).status).toBe("busy");
    await service.completeGovernedConversation(agent.id, "governed-run", "### Recovery plan ready");
    expect(service.getAgent(agent.id).status).toBe("ready");
    expect(service.getMessages(agent.id).map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "user", content: "recover my trip" },
      { role: "assistant", content: "### Recovery plan ready" },
    ]);
    expect(calls).toBe(0);
  });

  it("migrates legacy governed task executors structurally across reload", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-origin-migration-"));
    temporaryDirectories.push(root);
    const dataPath = path.join(root, "data", "db.json");
    const workspacePath = path.join(root, "workspaces");
    const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.dirname(dataPath),
      AGENT_WORKSPACE_ROOT: workspacePath, CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key", ARK_MODEL: "ep-test" });
    const store = new JsonStore(dataPath);
    const first = new AgentService(config, store, new WorkspaceManager(workspacePath), new FakeRunner());
    await first.initialize();
    const user = await first.createAgent({ name: "Travel Recovery Assistant" });
    const legacyRuntime = await first.createAgent({ name: "Legacy executor" });
    await store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === legacyRuntime.id)!;
      delete (agent as Partial<typeof agent>).origin;
      database.messages.push({ id: "legacy-message", agentId: legacyRuntime.id, runId: "legacy-run",
        role: "user", content: "[travel-task:search_transport] bounded task", createdAt: new Date().toISOString() });
    });
    const reloadedStore = new JsonStore(dataPath);
    const reloaded = new AgentService(config, reloadedStore, new WorkspaceManager(workspacePath), new FakeRunner());
    await reloaded.initialize();

    expect(reloaded.listAgents().map((agent) => agent.id)).toEqual([user.id]);
    expect(reloaded.getAgent(legacyRuntime.id).origin).toBe("governed-runtime");
  });

  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});
