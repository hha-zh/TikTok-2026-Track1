import { EvidenceBadge } from "./EvidenceBadge";
import type { GovernanceEvent } from "./types";

export function RunSafeguards({ events }: { events: GovernanceEvent[] }) {
  const safeguards = events.filter((event) => event.verdict && !event.taskId);
  return (
    <section className="governance-card">
      <div className="governance-card-heading"><span>Run safeguards</span><EvidenceBadge quality={safeguards.length ? "OBSERVED" : "UNAVAILABLE"} /></div>
      {safeguards.length === 0 ? <p className="governance-unavailable">No unambiguously run-scoped authorization evidence is available.</p> : (
        <div className="authority-events">
          {safeguards.map((event) => (
            <div className={`authority-event authority-${event.verdict?.toLowerCase()}`} key={event.eventId}>
              <div><strong>{event.principalId}</strong><span className={`verdict verdict-${event.verdict?.toLowerCase()}`}>{event.verdict}</span></div>
              <span>{event.action ?? "action unavailable"}{event.resourceId ? ` · ${event.resourceId}` : ""}</span>
              {event.reasonCode && <code>{event.reasonCode}</code>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
