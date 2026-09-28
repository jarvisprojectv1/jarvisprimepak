import type { ReactNode } from "react";

export function PageShell({
  title,
  status,
  children,
}: {
  title: string;
  status?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page">
      <div className="page-header">
        <h1>{title}</h1>
        {status && <span className="badge">{status}</span>}
      </div>
      <div className="page-body">{children}</div>
    </div>
  );
}
