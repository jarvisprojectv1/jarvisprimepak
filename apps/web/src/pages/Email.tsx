import { PageShell } from "../components/PageShell";

export function Email() {
  return (
    <PageShell title="Email">
      <p className="muted">Sending email. CONFIGURATION REQUIRED — SMTP is not configured (see tools/email.ts and .env.example).</p>
    </PageShell>
  );
}
