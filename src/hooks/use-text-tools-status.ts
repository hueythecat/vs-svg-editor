import { useEffect, useState } from 'react';

// One model the svg-text service can read text with, as its /health reports it: `up` is
// the service's own live probe, null when the service is too old to say.
export type TextToolsModelHealth = { model: string | null; server: string | null; up: boolean | null; error?: string };

// What GET /api/text-tools reports: whether the svg-text service behind the "Python text
// service" choice is up, which model it runs by default, and whether each of its models
// (`local` — the vLLM server — and `claude`) is answering right now.
export type TextToolsStatus = {
  host: string;
  up: boolean;
  version?: string | null;
  default?: 'local' | 'claude';
  models?: Partial<Record<'local' | 'claude', TextToolsModelHealth>>;
};

// The model a request would run on: the one asked for, else the service's default.
export const textToolsModelHealth = (status: TextToolsStatus | null, asked: 'local' | 'claude' | null) =>
  status?.models?.[asked ?? status.default ?? 'local'] ?? null;

const POLL_MS = 10_000;

// Polled: the vLLM server sits behind a tunnel that comes and goes. The service caches its
// model probe for 30 s, so polling faster than that only re-reads the same answer. Null
// until the first answer, and whenever the route can't be asked.
export function useTextToolsStatus(active: boolean): TextToolsStatus | null {
  const [status, setStatus] = useState<TextToolsStatus | null>(null);
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const check = async () => {
      try {
        const res = await fetch('/api/text-tools');
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
