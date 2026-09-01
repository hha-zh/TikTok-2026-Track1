export function GovernanceRail({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      className="governance-rail"
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="runtime-governance-inspector"
      title={open ? "Collapse Governance" : "Open Governance"}
    >
      <span className="governance-shield" aria-hidden="true">◇</span>
      <span>Governance</span>
    </button>
  );
}
