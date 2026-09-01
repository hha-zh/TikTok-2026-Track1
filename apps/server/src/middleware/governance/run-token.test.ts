import { describe, expect, it } from "vitest";
import {
  RunTokenService,
  RunTokenVerificationError,
} from "./run-token.js";

const secret = Buffer.alloc(32, 7);
const claims = {
  runId: "run-1",
  principalId: "agent-1",
  grantId: "grant-1",
  exp: 2_000,
};

describe("RunTokenService", () => {
  it("mints and verifies a valid run token", () => {
    const service = new RunTokenService(secret);
    const token = service.mint(claims);

    expect(token.startsWith("bouncer.v1.")).toBe(true);
    expect(service.verify(token, 1_999)).toEqual(claims);
  });

  it("rejects a modified payload", () => {
    const service = new RunTokenService(secret);
    const parts = service.mint(claims).split(".");
    const payload = Buffer.from(
      JSON.stringify({ ...claims, grantId: "grant-attacker" }),
    ).toString("base64url");
    const modified = `${parts[0]}.${parts[1]}.${payload}.${parts[3]}`;

    expect(() => service.verify(modified, 1_000)).toThrow(
      RunTokenVerificationError,
    );
  });

  it("rejects a modified signature", () => {
    const service = new RunTokenService(secret);
    const token = service.mint(claims);
    const modified = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");

    expect(() => service.verify(modified, 1_000)).toThrow(
      RunTokenVerificationError,
    );
  });

  it("rejects a token at its expiry boundary", () => {
    const service = new RunTokenService(secret);
    expect(() => service.verify(service.mint(claims), claims.exp)).toThrow(
      RunTokenVerificationError,
    );
  });

  it("rejects malformed and incomplete tokens", () => {
    const service = new RunTokenService(secret);
    expect(() => service.verify("bouncer.v1.not-json.signature", 1)).toThrow(
      RunTokenVerificationError,
    );
    expect(() => service.verify("bouncer.v2.payload.signature", 1)).toThrow(
      RunTokenVerificationError,
    );
    expect(() =>
      service.mint({ ...claims, runId: "" }),
    ).toThrow("Invalid run token input");
    expect(() =>
      service.mint({ ...claims, exp: Number.POSITIVE_INFINITY }),
    ).toThrow("Invalid run token input");
  });

  it("is distinguishable from the existing app bearer token", () => {
    const service = new RunTokenService(secret);
    expect(RunTokenService.hasTokenMarker(service.mint(claims))).toBe(true);
    expect(RunTokenService.hasTokenMarker("shared-app-auth-token")).toBe(false);
  });

  it("never includes a rejected raw token in its failure message", () => {
    const service = new RunTokenService(secret);
    const rawToken = "bouncer.v1.sensitive.invalid-signature";
    try {
      service.verify(rawToken, 1);
      throw new Error("Expected verification to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RunTokenVerificationError);
      expect((error as Error).message).not.toContain(rawToken);
    }
  });
});
