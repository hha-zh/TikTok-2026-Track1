import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

describe("local demo network posture", () => {
  it("binds the backend to loopback by default", () => {
    expect(loadConfig({ NODE_ENV: "development" }).host).toBe("127.0.0.1");
  });

  it("still permits an explicit host override", () => {
    expect(loadConfig({ NODE_ENV: "development", HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });

  it("scopes the non-loopback override to the Stage 7D container proof", async () => {
    const proofSource = await readFile(
      fileURLToPath(new URL("../../../scripts/stage7d-travel-proof.mjs", import.meta.url)),
      "utf8",
    );
    expect(proofSource).toContain('NODE_ENV: "production", HOST: "0.0.0.0"');
    expect(loadConfig({ NODE_ENV: "development" }).host).toBe("127.0.0.1");
  });
});
