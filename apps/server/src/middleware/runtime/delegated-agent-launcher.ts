import type {
  AgentService,
  GovernedExecutionContext,
} from "../../agent-service.js";
import type { AppConfig } from "../../config.js";
import type { GovernanceLedger } from "../evidence/ledger.js";
import type { JsonStore } from "../../store.js";
import type { Agent } from "../../types.js";
import type { ChildEnvelopeRequest, DelegationService } from "../governance/delegation.js";
import type { AuthenticatedIdentity } from "../governance/identity.js";
import type { RunTokenService } from "../governance/run-token.js";
import type { ChildHandle, ReasonCode } from "../governance/types.js";

const RUNTIME_TOKEN_TTL_SECONDS = 15 * 60;

type AgentIdentity = Extract<AuthenticatedIdentity, { kind: "agent" }>;

export interface DelegatedAgentPlatform {
  createAgent(input: {
    name: string;
    description?: string;
    instructions?: string;
  }): Promise<Agent>;
  sendGovernedMessage(
    agentId: string,
    prompt: string,
    context: GovernedExecutionContext,
  ): ReturnType<AgentService["sendGovernedMessage"]>;
  deleteAgent(agentId: string): Promise<{ archivedWorkspace: string }>;
}

export type LiveDelegationResult =
  | { ok: true; handle: ChildHandle }
  | { ok: false; statusCode: 400 | 403 | 503; reason: ReasonCode };

/**
 * A governed child that exists but has NOT been dispatched yet.
 *
 * Splitting preparation from dispatch is what lets the Adaptive Runtime derive
 * the child's invocation envelope and project its context BEFORE the Agent
 * starts work. Launching atomically meant the child began executing before
 * anything had decided what it was allowed to see.
 *
 * `runtimeRunToken` is held in memory for the caller to hand to
 * `sendGovernedMessage`. It is never persisted.
 */
export interface PreparedChild {
  childPrincipalId: string;
  childAgentId: string;
  grantId: string;
  runtimeRunToken: string;
}

export type PrepareChildResult =
  | { ok: true; prepared: PreparedChild }
  | { ok: false; statusCode: 400 | 403 | 503; reason: ReasonCode };

export interface DelegatedAgentLauncherDependencies {
  config: AppConfig;
  store: JsonStore;
  ledger: GovernanceLedger;
  runTokens: RunTokenService;
  delegation: DelegationService;
  agents: DelegatedAgentPlatform;
  now?: () => Date;
}

export class DelegatedAgentLauncher {
  constructor(private readonly dependencies: DelegatedAgentLauncherDependencies) {}

  /**
   * Atomic convenience API, unchanged for existing callers: prepare, then
   * dispatch immediately.
   */
  async launch(
    identity: AgentIdentity,
    authority: ChildEnvelopeRequest,
    task: string,
  ): Promise<LiveDelegationResult> {
    const prepared = await this.prepare(identity, authority);
    if (!prepared.ok) return prepared;
    return this.dispatch(identity, prepared.prepared, task);
  }

  /**
   * Create the governed child - grant, principal, Agent, workspace, token -
   * WITHOUT starting any work.
   */
  async prepare(
    identity: AgentIdentity,
    authority: ChildEnvelopeRequest,
  ): Promise<PrepareChildResult> {
    if (this.dependencies.config.runtimeProvider !== "container") {
      return { ok: false, statusCode: 503, reason: "MALFORMED_INPUT" };
    }

    const delegated = await this.dependencies.delegation.delegate(identity, authority);
    if (!delegated.ok) return delegated;

    const { childPrincipalId, grantId } = delegated.grant;
    let childAgent: Agent | null = null;
    try {
      childAgent = await this.dependencies.agents.createAgent({
        name: `Governed child ${childPrincipalId.slice(0, 8)}`,
        description: "Attenuated delegated Agent",
        instructions:
          "Execute only the delegated task. Use Bouncer-managed callbacks for governed resources and never reveal credentials.",
      });

      const database = this.dependencies.store.snapshot();
      const envelope = database.envelopes.find((item) => item.id === grantId);
      const principal = database.principals.find((item) => item.id === childPrincipalId);
      if (!envelope || !principal || principal.kind !== "agent") {
        throw new Error("Persisted child authority is incomplete");
      }
      const now = this.dependencies.now?.() ?? new Date();
      const operationalExpiry = Math.floor(now.getTime() / 1_000) + RUNTIME_TOKEN_TTL_SECONDS;
      const envelopeExpiry = envelope.expiresAt
        ? Math.floor(Date.parse(envelope.expiresAt) / 1_000)
        : operationalExpiry;
      const tokenExpiry = Math.min(operationalExpiry, envelopeExpiry);
      if (!Number.isSafeInteger(tokenExpiry) || tokenExpiry <= Math.floor(now.getTime() / 1_000)) {
        throw new Error("Child authority expires before execution can start");
      }
      const runtimeRunToken = this.dependencies.runTokens.mint({
        runId: envelope.runId,
        principalId: principal.id,
        grantId: envelope.id,
        exp: tokenExpiry,
      });
      return {
        ok: true,
        prepared: {
          childPrincipalId: principal.id,
          childAgentId: childAgent.id,
          grantId: envelope.id,
          runtimeRunToken,
        },
      };
    } catch {
      await this.revokeFailedChild(identity, childPrincipalId, grantId);
      if (childAgent) {
        await this.dependencies.agents.deleteAgent(childAgent.id).catch(() => undefined);
      }
      return { ok: false, statusCode: 503, reason: "MALFORMED_INPUT" };
    }
  }

  /**
   * Start the prepared child's work.
   *
   * The caller has had its chance to derive the invocation envelope and
   * project context in between, so `task` is the bounded packet the child is
   * actually meant to see.
   */
  async dispatch(
    identity: AgentIdentity,
    prepared: PreparedChild,
    task: string,
  ): Promise<LiveDelegationResult> {
    try {
      const { run } = await this.dependencies.agents.sendGovernedMessage(
        prepared.childAgentId,
        task,
        {
          runtimeRunToken: prepared.runtimeRunToken,
          onExecutionFailure: () =>
            this.revokeFailedChild(
              identity,
              prepared.childPrincipalId,
              prepared.grantId,
            ),
        },
      );
      return {
        ok: true,
        handle: {
          childPrincipalId: prepared.childPrincipalId,
          childAgentId: prepared.childAgentId,
          grantId: prepared.grantId,
          status: run.status,
        },
      };
    } catch {
      await this.revokeFailedChild(
        identity,
        prepared.childPrincipalId,
        prepared.grantId,
      );
      await this.dependencies.agents
        .deleteAgent(prepared.childAgentId)
        .catch(() => undefined);
      return { ok: false, statusCode: 503, reason: "MALFORMED_INPUT" };
    }
  }

  private async revokeFailedChild(
    parent: AgentIdentity,
    childPrincipalId: string,
    childGrantId: string,
  ): Promise<void> {
    await this.dependencies.ledger.appendEvent(
      "grant_revoked",
      { reason: "MALFORMED_INPUT" },
      {
        runId: parent.runId,
        grantId: childGrantId,
        principalId: childPrincipalId,
      },
    );
  }
}
