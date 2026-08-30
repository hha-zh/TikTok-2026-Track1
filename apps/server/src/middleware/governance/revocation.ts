import type { GovernanceLedger } from "../evidence/ledger.js";
import type { JsonStore } from "../../store.js";
import type { AuthenticatedIdentity } from "./identity.js";

type HumanIdentity = Extract<AuthenticatedIdentity, { kind: "human" }>;

export type RevocationResult =
  | { ok: true; grantId: string; revoked: true; transitioned: boolean }
  | { ok: false; statusCode: 403 | 404 };

export class HumanRevocationService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: JsonStore,
    private readonly ledger: GovernanceLedger,
  ) {}

  revoke(identity: HumanIdentity, grantId: string): Promise<RevocationResult> {
    const operation = this.queue.then(() => this.revokeSerialized(identity, grantId));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async revokeSerialized(
    identity: HumanIdentity,
    grantId: string,
  ): Promise<RevocationResult> {
    const database = this.store.snapshot();
    const envelope = database.envelopes.find((item) => item.id === grantId);
    if (!envelope) return { ok: false, statusCode: 404 };

    const target = database.principals.find(
      (principal) => principal.id === envelope.principalId,
    );
    if (!target || target.kind !== "agent" || !target.ownerId) {
      return { ok: false, statusCode: 404 };
    }
    if (target.ownerId !== identity.principalId) {
      return { ok: false, statusCode: 403 };
    }

    const grantState = database.grantStates.find(
      (state) => state.grantId === grantId,
    );
    if (!grantState) return { ok: false, statusCode: 404 };
    if (grantState.revoked) {
      return { ok: true, grantId, revoked: true, transitioned: false };
    }

    await this.ledger.appendEvent(
      "grant_revoked",
      { reason: "PARENT_GRANT_REVOKED" },
      {
        runId: envelope.runId,
        grantId: envelope.id,
        principalId: identity.principalId,
      },
    );
    return { ok: true, grantId, revoked: true, transitioned: true };
  }
}
