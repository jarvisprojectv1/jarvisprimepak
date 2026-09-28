import { NavLink } from "react-router-dom";

const NAV_ITEMS: { label: string; to: string }[] = [
  { label: "Home", to: "/" },
  { label: "Business", to: "/business" },
  { label: "CRM", to: "/crm" },
  { label: "Tasks", to: "/tasks" },
  { label: "Agents", to: "/agents" },
  { label: "Calls", to: "/calls" },
  { label: "Email", to: "/email" },
  { label: "Files", to: "/files" },
  { label: "Intelligence", to: "/intelligence" },
  { label: "Memory", to: "/memory" },
  { label: "Automations", to: "/automations" },
  { label: "Settings", to: "/settings" },
  { label: "System", to: "/system" },
];

export function Sidebar() {
  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="brand-mark">J</span>
        <div>
          <div className="brand-title">JARVIS</div>
          <div className="brand-subtitle">Prime Pak Packages</div>
        </div>
      </div>
      <ul className="nav-list">
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
            >
              {item.label}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="sidebar-footer">Phase 1 — Foundation</div>
    </nav>
  );
}
