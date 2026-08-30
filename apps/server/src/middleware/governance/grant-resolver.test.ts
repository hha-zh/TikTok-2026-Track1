import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../store.js";
import type { Envelope } from "./types.js";
import { resolveGrant } from "./grant-resolver.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "grant-child",
    principalId: "agent-child",
    exercisable: { resources: ["resource:stored"], actions: ["read"] },
    delegatable: { resources: [], actions: [] },
    depth: 1,
    maxTokens: 100,
    maxToolCalls: 2,
    maxChildren: 0,
    runId: "run-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function resolverStore(envelopes: Envelope[] = [envelope()]) {
  const root = await mkdtemp(path.join(tmpdir(), "grant-resolver-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.envelopes.push(...envelopes);
    database.runStates.push({
      runId: "run-1",
      maxTokens: 1_200,
      tokensUsed: 4,
    });
    for (const item of envelopes) {
      if (!database.grantStates.some((state) => state.grantId === item.id)) {
        database.grantStates.push({
          grantId: item.id,
          revoked: false,
          tokensUsed: 3,
          childCount: 0,
        });
      }
    }
  });
  return store;
}

const input = {
  principalId: "agent-child",
  grantId: "grant-child",
  runId: "run-1",
};
const now = "2026-01-02T00:00:00.000Z";

describe("resolveGrant", () => {
  it("resolves authority from the stored envelope", async () => {
    const store = await resolverStore();
    const result = resolveGrant(input, store, now);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.envelope.exercisable.resources).toEqual([
      "resource:stored",
    ]);
  });

  it("rejects a missing grant", async () => {
    const store = await resolverStore([]);
    expect(resolveGrant(input, store, now)).toEqual({
      ok: false,
      reason: "GRANT_NOT_FOUND",
      detail: "Grant does not exist",
    });
  });

  it("rejects a principal and grant mismatch", async () => {
    const store = await resolverStore();
    expect(
      resolveGrant({ ...input, principalId: "other-agent" }, store, now),
    ).toMatchObject({ ok: false, reason: "MALFORMED_INPUT" });
  });

  it("rejects a run and grant mismatch", async () => {
    const store = await resolverStore();
    expect(
      resolveGrant({ ...input, runId: "run-other" }, store, now),
    ).toMatchObject({ ok: false, reason: "MALFORMED_INPUT" });
  });

  it("builds a live ancestry chain", async () => {
    const child = envelope({ parentGrantId: "grant-parent" });
    const parent = envelope({
      id: "grant-parent",
      principalId: "agent-parent",
      parentGrantId: "grant-root",
      depth: 0,
    });
    const root = envelope({
      id: "grant-root",
      principalId: "human-root",
      depth: 0,
    });
    const store = await resolverStore([child, parent, root]);
    const result = resolveGrant(input, store, now);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.ancestry).toEqual([
      { grantId: "grant-parent", revoked: false, expired: false },
      { grantId: "grant-root", revoked: false, expired: false },
    ]);
  });

  it("marks a revoked ancestor", async () => {
    const child = envelope({ parentGrantId: "grant-parent" });
    const parent = envelope({ id: "grant-parent", principalId: "agent-parent" });
    const store = await resolverStore([child, parent]);
    await store.mutate((database) => {
      const state = database.grantStates.find(
        (item) => item.grantId === "grant-parent",
      );
      if (state) state.revoked = true;
    });
    const result = resolveGrant(input, store, now);

    expect(result.ok && result.state.ancestry[0]?.revoked).toBe(true);
  });

  it("marks an ancestor expired at the exact boundary", async () => {
    const child = envelope({ parentGrantId: "grant-parent" });
    const parent = envelope({
      id: "grant-parent",
      principalId: "agent-parent",
      expiresAt: now,
    });
    const store = await resolverStore([child, parent]);
    const result = resolveGrant(input, store, now);

    expect(result.ok && result.state.ancestry[0]?.expired).toBe(true);
  });

  it("rejects a broken parent chain", async () => {
    const store = await resolverStore([
      envelope({ parentGrantId: "missing-parent" }),
    ]);
    expect(resolveGrant(input, store, now)).toMatchObject({
      ok: false,
      reason: "MALFORMED_INPUT",
    });
  });

  it("rejects a cyclic parent chain", async () => {
    const child = envelope({ parentGrantId: "grant-parent" });
    const parent = envelope({
      id: "grant-parent",
      principalId: "agent-parent",
      parentGrantId: "grant-child",
    });
    const store = await resolverStore([child, parent]);
    expect(resolveGrant(input, store, now)).toMatchObject({
      ok: false,
      reason: "MALFORMED_INPUT",
    });
  });

  it("returns exactly the frozen governance state shape", async () => {
    const storedEnvelope = envelope();
    const store = await resolverStore([storedEnvelope]);
    const result = resolveGrant(input, store, now);

    expect(result).toEqual({
      ok: true,
      state: {
        envelope: storedEnvelope,
        ancestry: [],
        grantState: {
          grantId: "grant-child",
          revoked: false,
          tokensUsed: 3,
          childCount: 0,
        },
        runState: { runId: "run-1", maxTokens: 1_200, tokensUsed: 4 },
        now,
      },
    });
  });

  it("fails closed when projection state is missing", async () => {
    const store = await resolverStore();
    await store.mutate((database) => {
      database.grantStates = [];
    });
    expect(resolveGrant(input, store, now)).toMatchObject({
      ok: false,
      reason: "MALFORMED_INPUT",
    });
  });
});
