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
              <div><strong>{event.resourceId ?? event.action ?? event.kind}</strong><span className={`verdict verdict-${event.verdict?.toLowerCase()}`}>{event.verdict}</span></div>
              {event.reasonCode && <code>{event.reasonCode}</code>}
              <details className="technical-details">
                <summary>Technical details</summary>
                <dl>
                  <div><dt>Event</dt><dd>{event.kind}</dd></div>
                  <div><dt>Principal</dt><dd>{event.principalId}</dd></div>
                  <div><dt>Grant</dt><dd>{event.grantId}</dd></div>
                  <div><dt>Sequence</dt><dd>{event.sequence}</dd></div>
                  {event.action && <div><dt>Action</dt><dd>{event.action}</dd></div>}
                </dl>
              </details>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
