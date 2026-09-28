import { useEffect, useState } from "react";
import { PageShell } from "../components/PageShell";
import { apiGet, apiPost } from "../lib/api";

interface ChatResponse {
  ok: boolean;
  reply: string;
  configurationRequired?: boolean;
}

export function Home() {
  const [health, setHealth] = useState<string>("checking...");
  const [message, setMessage] = useState("");
  const [log, setLog] = useState<{ from: "you" | "jarvis"; text: string }[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    apiGet<{ status: string }>("/health")
      .then((res) => setHealth(res.status))
      .catch(() => setHealth("unreachable (start the API with `npm run dev -w apps/api`)"));
  }, []);

  async function sendMessage() {
    if (!message.trim()) return;
    const text = message;
    setMessage("");
    setLog((l) => [...l, { from: "you", text }]);
    setSending(true);
    try {
      const res = await apiPost<ChatResponse>("/chat", { message: text, conversationId: "web-dashboard" });
      setLog((l) => [...l, { from: "jarvis", text: res.reply }]);
    } catch {
      setLog((l) => [...l, { from: "jarvis", text: "Could not reach the JARVIS API." }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <PageShell title="Home" status={`API: ${health}`}>
      <p className="muted">
        This is the JARVIS command center shell (Phase 1: Foundation). Talk to JARVIS below - it
        routes through the real orchestrator and tool registry.
      </p>

      <div className="chat-panel">
        <div className="chat-log">
          {log.length === 0 && <div className="muted">No messages yet. Say hello.</div>}
          {log.map((entry, i) => (
            <div key={i} className={`chat-bubble ${entry.from}`}>
              <strong>{entry.from === "you" ? "You" : "JARVIS"}:</strong> {entry.text}
            </div>
          ))}
        </div>
        <div className="chat-input-row">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder="Message JARVIS..."
          />
          <button onClick={sendMessage} disabled={sending}>
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>
    </PageShell>
  );
}
