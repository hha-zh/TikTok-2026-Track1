import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  agentCodexHome,
  buildContainerRunArgs,
  containerName,
  initializeAgentCodexHome,
} from "./container-codex-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent-unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain(
      "type=bind,src=/tmp/codex-home/agent-unsafe,dst=/codex-home",
    );
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
    expect(args).not.toContain("RUN_TOKEN");
  });

  it("isolates Agent homes beneath the configured CODEX_HOME", () => {
    const root = "/tmp/codex-home";
    const first = agentCodexHome(root, "agent-a");
    const second = agentCodexHome(root, "agent-b");

    expect(first).toBe("/tmp/codex-home/agent-a");
    expect(second).toBe("/tmp/codex-home/agent-b");
    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(path.resolve(root));
    expect(path.dirname(second)).toBe(path.resolve(root));
    expect(() => agentCodexHome(root, "../escape")).toThrow();
  });

  it("mounts only the selected Agent home and keeps the token out of argv", () => {
    const runtimeRunToken = "bouncer.v1.raw-secret.signature";
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent-b",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: null,
        runtimeRunToken,
      },
      config,
    );

    expect(args).toContain("RUN_TOKEN");
    expect(args).not.toContain(runtimeRunToken);
    expect(args).toContain(
      "type=bind,src=/tmp/codex-home/agent-b,dst=/codex-home",
    );
    expect(args.join(" ")).not.toContain("/tmp/codex-home/agent-a");
  });

  it("initializes only configuration in separate Agent homes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-codex-home-test-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "config.toml"), "model = \"test\"\n", "utf8");
    const config = loadConfig({ NODE_ENV: "test", CODEX_HOME: root });

    const first = await initializeAgentCodexHome(config, "agent-a");
    await writeFile(path.join(first, "session-sentinel"), "agent-a-only", "utf8");
    const second = await initializeAgentCodexHome(config, "agent-b");

    expect(await readFile(path.join(first, "config.toml"), "utf8")).toBe(
      "model = \"test\"\n",
    );
    expect(await readFile(path.join(second, "config.toml"), "utf8")).toBe(
      "model = \"test\"\n",
    );
    await expect(readFile(path.join(second, "session-sentinel"), "utf8")).rejects
      .toMatchObject({ code: "ENOENT" });
  });
});
