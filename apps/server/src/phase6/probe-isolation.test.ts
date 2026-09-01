import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupProbeState, createProbeState } from "./probe-isolation.js";

describe("external probe state isolation", () => {
  it("cannot mutate or clean the normal Agent registry", async () => {
    const parent = await createProbeState(path.join(tmpdir(), "phase6-isolation-tests"));
    const normal = path.join(parent.root, "normal", "launchpad.json");
    await mkdir(path.dirname(normal), { recursive: true });
    const initial = JSON.stringify({ agents: [{ id: "user-agent" }] });
    await writeFile(normal, initial, "utf8");

    const isolated = await createProbeState(path.join(parent.root, "probes"));
    await mkdir(isolated.dataDirectory, { recursive: true });
    await writeFile(
      path.join(isolated.dataDirectory, "launchpad.json"),
      JSON.stringify({ agents: [{ id: "probe-root" }, { id: "probe-child" }] }),
      "utf8",
    );

    expect(await readFile(normal, "utf8")).toBe(initial);
    await cleanupProbeState(isolated);
    await expect(access(isolated.root)).rejects.toThrow();
    expect(await readFile(normal, "utf8")).toBe(initial);
    await cleanupProbeState(parent);
  });
});

