import { PageShell } from "../components/PageShell";

export function Agents() {
  return (
    <PageShell title="Agents">
      <p className="muted">Registered agents (research, crm) can be run via POST /agents/:name/run. This view is a routed placeholder for live agent status/output.</p>
    </PageShell>
  );
}
