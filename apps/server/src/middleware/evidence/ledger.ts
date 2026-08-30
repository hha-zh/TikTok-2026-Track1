import type { JsonStore } from "../../store.js";
import type {
  GovernanceEvent,
  GovernanceEventKind,
  GovernanceEventPayloadMap,
} from "./types.js";
import { applyGovernanceEvent } from "./projections.js";

export interface GovernanceEventContext {
  runId: string;
  grantId: string;
  principalId: string;
}

const sensitiveKey = /^(?:authorization|run_token|api_key|ark_api_key)$/i;

function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\bgho_[A-Za-z0-9]+/g, "[REDACTED]")
    .replace(/\b(ARK_API_KEY\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

export function sanitizeEventPayload<T>(payload: T): T {
  return sanitizeValue(payload) as T;
}

export class GovernanceLedger {
  private appendQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: JsonStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  appendEvent<K extends GovernanceEventKind>(
    kind: K,
    payload: GovernanceEventPayloadMap[K],
    context: GovernanceEventContext,
  ): Promise<GovernanceEvent<K>> {
    const operation = this.appendQueue.then(() =>
      this.store.mutate((database) => {
        // Sequence assignment, append and projection changes share one mutation.
        const seq = database.governanceEvents.reduce(
          (highest, event) => Math.max(highest, event.seq),
          0,
        ) + 1;
        const event: GovernanceEvent<K> = {
          seq,
          ts: this.now(),
          ...context,
          kind,
          payload: sanitizeEventPayload(payload),
        };
        database.governanceEvents.push(event);
        applyGovernanceEvent(database, event);
        return structuredClone(event);
      }),
    );
    this.appendQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
