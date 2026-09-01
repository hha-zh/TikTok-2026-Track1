import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../store.js";
import { GovernanceLedger } from "./ledger.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createLedger() {
  const root = await mkdtemp(path.join(tmpdir(), "governance-ledger-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  let tick = 0;
  const ledger = new GovernanceLedger(
    store,
    () => `2026-01-01T00:00:00.${String(tick++).padStart(3, "0")}Z`,
  );
  return { ledger, store };
}

const context = {
  runId: "run-1",
  grantId: "grant-1",
  principalId: "principal-1",
};

describe("GovernanceLedger", () => {
  it("appends events with globally monotonic sequence numbers", async () => {
    const { ledger, store } = await createLedger();
    const first = await ledger.appendEvent(
      "principal_created",
      { kind: "human" },
      context,
    );
    const second = await ledger.appendEvent(
      "authority_evaluated",
      { verdict: "DENY", reason: "RESOURCE_NOT_GRANTED" },
      context,
    );

    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(store.snapshot().governanceEvents.map((event) => event.seq)).toEqual([
      1, 2,
    ]);
  });

  it("serializes concurrent appends without loss or duplicate sequences", async () => {
    const { ledger, store } = await createLedger();
    const appended = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        ledger.appendEvent(
          "tool_allowed",
          { toolName: `tool-${index}` },
          context,
        ),
      ),
    );

    const expected = Array.from({ length: 24 }, (_, index) => index + 1);
    expect(appended.map((event) => event.seq)).toEqual(expected);
    expect(store.snapshot().governanceEvents).toHaveLength(24);
    expect(
      new Set(store.snapshot().governanceEvents.map((event) => event.seq)).size,
    ).toBe(24);
  });

  it("updates token projections in the same append", async () => {
    const { ledger, store } = await createLedger();
    await store.mutate((database) => {
      database.runStates.push({
        runId: "run-1",
        maxTokens: 1_200,
        tokensUsed: 0,
      });
    });
    await ledger.appendEvent(
      "tokens_consumed",
      {
        inputTokens: 6,
        cachedInputTokens: 1,
        outputTokens: 4,
        totalTokens: 10,
      },
      context,
    );

    const snapshot = store.snapshot();
    expect(snapshot.runStates).toEqual([
      { runId: "run-1", maxTokens: 1_200, tokensUsed: 10 },
    ]);
    expect(snapshot.grantStates).toEqual([
      { grantId: "grant-1", revoked: false, tokensUsed: 10, childCount: 0 },
    ]);
  });

  it("redacts secret-shaped values before persistence", async () => {
    const { ledger, store } = await createLedger();
    const payload = {
      toolName: "safe-tool",
      note: "sk-live-123 Bearer abc.def gho_example ARK_API_KEY=secret-value",
      authorization: "Bearer must-not-survive",
    };
    await ledger.appendEvent("tool_allowed", payload, context);

    const serialized = JSON.stringify(store.snapshot().governanceEvents);
    expect(serialized).not.toContain("sk-live-123");
    expect(serialized).not.toContain("abc.def");
    expect(serialized).not.toContain("gho_example");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("must-not-survive");
    expect(serialized).toContain("[REDACTED]");
    expect(payload.note).toContain("sk-live-123");
  });
});
