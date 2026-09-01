import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "../../store.js";
import { verifyIdentity } from "./identity.js";
import { RunTokenService } from "./run-token.js";

const temporaryDirectories: string[] = [];
const secret = Buffer.alloc(32, 9);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function identityFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "identity-test-"));
  temporaryDirectories.push(root);
  const store = new JsonStore(path.join(root, "db.json"));
  await store.initialize();
  await store.mutate((database) => {
    database.principals.push(
      { id: "wtan", kind: "human" },
      {
        id: "agent-1",
        kind: "agent",
        ownerId: "wtan",
        parentPrincipalId: "wtan",
      },
    );
  });
  return { store, runTokens: new RunTokenService(secret) };
}

const tokenClaims = {
  runId: "run-1",
  principalId: "agent-1",
  grantId: "grant-1",
  exp: 2_000,
};

describe("verifyIdentity", () => {
  it("resolves a known human principal", async () => {
    const dependencies = await identityFixture();
    const result = verifyIdentity(
      { principalHeader: "wtan" },
      dependencies,
      1_000,
    );

    expect(result).toEqual({
      ok: true,
      identity: {
        kind: "human",
        principalId: "wtan",
        principal: { id: "wtan", kind: "human" },
      },
    });
  });

  it("rejects an unknown human principal", async () => {
    const dependencies = await identityFixture();
    expect(
      verifyIdentity({ principalHeader: "unknown" }, dependencies, 1_000),
    ).toEqual({ ok: false, reason: "PRINCIPAL_NOT_FOUND" });
  });

  it("resolves an agent from a valid run token", async () => {
    const dependencies = await identityFixture();
    const token = dependencies.runTokens.mint(tokenClaims);
    const result = verifyIdentity(
      { authorizationHeader: `Bearer ${token}` },
      dependencies,
      1_000,
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.identity.kind !== "agent") return;
    expect(result.identity).toMatchObject({
      principalId: "agent-1",
      grantId: "grant-1",
      runId: "run-1",
      principal: { id: "agent-1", kind: "agent" },
    });
  });

  it("rejects an agent token naming a human principal", async () => {
    const dependencies = await identityFixture();
    const token = dependencies.runTokens.mint({
      ...tokenClaims,
      principalId: "wtan",
    });
    expect(
      verifyIdentity(
        { authorizationHeader: `Bearer ${token}` },
        dependencies,
        1_000,
      ),
    ).toEqual({ ok: false, reason: "PRINCIPAL_NOT_FOUND" });
  });

  it("does not fall through to a human header for a forged agent token", async () => {
    const dependencies = await identityFixture();
    const token = dependencies.runTokens.mint(tokenClaims);
    const forged = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");

    expect(
      verifyIdentity(
        {
          authorizationHeader: `Bearer ${forged}`,
          principalHeader: "wtan",
        },
        dependencies,
        1_000,
      ),
    ).toEqual({ ok: false, reason: "INVALID_TOKEN" });
  });

  it("does not fall through to a human header for an expired agent token", async () => {
    const dependencies = await identityFixture();
    const token = dependencies.runTokens.mint(tokenClaims);

    expect(
      verifyIdentity(
        {
          authorizationHeader: `Bearer ${token}`,
          principalHeader: "wtan",
        },
        tokenClaims.exp,
      ),
    ).toEqual({ ok: false, reason: "INVALID_TOKEN" });
  });

  it("does not persist a raw token during verification", async () => {
    const dependencies = await identityFixture();
    const token = dependencies.runTokens.mint(tokenClaims);
    verifyIdentity(
      { authorizationHeader: `Bearer ${token}` },
      dependencies,
      1_000,
    );

    expect(JSON.stringify(dependencies.store.snapshot())).not.toContain(token);
  });
});
