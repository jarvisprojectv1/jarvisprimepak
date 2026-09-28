import { Routes, Route } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { Home } from "./pages/Home";
import { Business } from "./pages/Business";
import { Crm } from "./pages/Crm";
import { Tasks } from "./pages/Tasks";
import { Agents } from "./pages/Agents";
import { Calls } from "./pages/Calls";
import { Email } from "./pages/Email";
import { Files } from "./pages/Files";
import { Intelligence } from "./pages/Intelligence";
import { MemoryPage } from "./pages/Memory";
import { Automations } from "./pages/Automations";
import { Settings } from "./pages/Settings";
import { System } from "./pages/System";

export default function App() {
  return (
    <div className="app-shell">
      <Sidebar />
      <main className="app-content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/business" element={<Business />} />
          <Route path="/crm" element={<Crm />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/calls" element={<Calls />} />
          <Route path="/email" element={<Email />} />
          <Route path="/files" element={<Files />} />
          <Route path="/intelligence" element={<Intelligence />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/automations" element={<Automations />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/system" element={<System />} />
        </Routes>
      </main>
    </div>
  );
}
