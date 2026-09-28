import { PageShell } from "../components/PageShell";

export function System() {
  return (
    <PageShell title="System">
      <p className="muted">System health, logs (system_logs) and audit trail (audit_logs) are being written for real right now. This view is a routed placeholder for a live log viewer.</p>
    </PageShell>
  );
}
