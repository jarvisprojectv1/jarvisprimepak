import { PageShell } from "../components/PageShell";

export function MemoryPage() {
  return (
    <PageShell title="Memory">
      <p className="muted">
        JARVIS's namespaced, append-only memory store is real and queryable via GET/POST
        /memory (see core/memory). This view is a routed placeholder for browsing memory
        visually.
      </p>
    </PageShell>
  );
}
