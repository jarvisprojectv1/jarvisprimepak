// Small fetch wrapper for the JARVIS API. Base URL defaults to the API's
// default dev port; override with VITE_API_URL if needed.
const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  return res.json();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}
