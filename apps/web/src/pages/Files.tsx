import { PageShell } from "../components/PageShell";

export function Files() {
  return (
    <PageShell title="Files">
      <p className="muted">The files tool can already read/write inside a sandboxed directory via /tools/files/execute. This view is a routed placeholder for a real file browser.</p>
    </PageShell>
  );
}
