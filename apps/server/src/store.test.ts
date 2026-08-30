import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("loads and normalizes a legacy version-1 database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const legacyDatabase = {
      version: 1,
      agents: [
        {
          id: "agent-1",
          name: "Existing Agent",
          description: "preserved",
          instructions: "keep this",
          status: "ready",
          workspacePath: "/tmp/existing-agent",
          codexThreadId: null,
          lastError: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      messages: [
        {
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "existing message",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      runs: [
        {
          id: "run-1",
          agentId: "agent-1",
          status: "completed",
          prompt: "existing prompt",
          output: "existing output",
          error: null,
          usage: { inputTokens: 2, outputTokens: 1 },
          startedAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:02.000Z",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    };
    await writeFile(filePath, JSON.stringify(legacyDatabase), "utf8");

    const store = new JsonStore(filePath);
    await store.initialize();
    const snapshot = store.snapshot();

    expect(snapshot.agents).toEqual(legacyDatabase.agents);
    expect(snapshot.messages).toEqual(legacyDatabase.messages);
    expect(snapshot.runs).toEqual(legacyDatabase.runs);
    expect(snapshot.principals).toEqual([]);
    expect(snapshot.envelopes).toEqual([]);
    expect(snapshot.governanceEvents).toEqual([]);
    expect(snapshot.runStates).toEqual([]);
    expect(snapshot.grantStates).toEqual([]);
    expect(snapshot.mockResources).toEqual([]);
    expect(snapshot.artifacts).toEqual([]);
    expect(snapshot.artifactSchemas).toEqual([]);

    await store.mutate(() => undefined);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(persisted.agents).toEqual(legacyDatabase.agents);
    expect(persisted.messages).toEqual(legacyDatabase.messages);
    expect(persisted.runs).toEqual(legacyDatabase.runs);
    expect(persisted.principals).toEqual([]);
    expect(persisted.governanceEvents).toEqual([]);
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});
