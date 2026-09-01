import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";

export interface ProbeState {
  root: string;
  dataDirectory: string;
  workspaceRoot: string;
  codexHome: string;
}

/** Allocate state owned exclusively by one external verification run. */
export async function createProbeState(parent: string): Promise<ProbeState> {
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "phase6-"));
  return {
    root,
    dataDirectory: path.join(root, "data"),
    workspaceRoot: path.join(root, "workspaces"),
    codexHome: path.join(root, "codex-home"),
  };
}

/** Remove only the uniquely allocated probe root. */
export async function cleanupProbeState(state: ProbeState): Promise<void> {
  await rm(state.root, { recursive: true, force: true });
}

