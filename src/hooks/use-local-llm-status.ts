import { useEffect, useState } from 'react';

// What GET /api/local reports: whether the vLLM server the "Local" models try first is
// answering, which of those models it would take, and whether the rest have Ollama to
// fall back to (see src/lib/ollama.ts).
export type LocalLlmStatus = { host: string; up: boolean; models: string[]; fallback: boolean };

const POLL_MS = 10_000;

// Asked while `active`, and again every few seconds: the server is a tunnel that comes
// and goes, and the point is to say which it is before a call is spent finding out.
// Null until the first answer, and whenever the route can't be asked.
export function useLocalLlmStatus(active: boolean): LocalLlmStatus | null {
  const [status, setStatus] = useState<LocalLlmStatus | null>(null);
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const check = async () => {
      try {
        const res = await fetch('/api/local');
        if (stop) return;
        setStatus(res.ok ? await res.json() : null);
      } catch {
        if (!stop) setStatus(null);
      }
    };
    const timer = setInterval(check, POLL_MS);
    void check();
    return () => { stop = true; clearInterval(timer); };
  }, [active]);
  return status;
}
