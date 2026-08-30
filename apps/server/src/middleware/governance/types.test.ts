import { describe, expect, it } from "vitest";
import type { Decision } from "./types.js";

describe("governance decision contract", () => {
  it("represents truthful allow and deny reasons", () => {
    const allowed = {
      verdict: "ALLOW",
      reason: "AUTHORIZED",
    } satisfies Decision;
    const denied = {
      verdict: "DENY",
      reason: "RESOURCE_NOT_GRANTED",
    } satisfies Decision;

    expect(allowed).toEqual({ verdict: "ALLOW", reason: "AUTHORIZED" });
    expect(denied).toEqual({
      verdict: "DENY",
      reason: "RESOURCE_NOT_GRANTED",
    });
  });
});
