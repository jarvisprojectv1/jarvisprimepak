import { PageShell } from "../components/PageShell";

export function Crm() {
  return (
    <PageShell title="Crm">
      <p className="muted">Contacts, companies, leads and clients live in the database now (see database/schema.prisma). This view is a routed placeholder; a real CRM table/board UI is Phase 2+.</p>
    </PageShell>
  );
}
