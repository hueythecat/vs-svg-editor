import { useEffect, useState } from 'react';

// What GET /api/text-tools reports: whether the svg-text service behind the "Python text
// service" choice is up, and whether the model server it reads text with is answering and
// serving its model. modelUp is null when the service doesn't say which server it uses.
export type TextToolsStatus = {
  host: string;
  up: boolean;
  model?: string | null;
  modelServer?: string | null;
  modelUp?: boolean | null;
};

const POLL_MS = 10_000;

// Polled like useLocalLlmStatus, for the same reason: the model server sits behind a
// tunnel that comes and goes. Null until the first answer, and whenever the route can't
// be asked.
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
