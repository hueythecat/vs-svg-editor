// useDetectText.ts — call the svg-text service from the editor ("Customise" button).
// Works in React / Expo web (fetch + FormData + AbortController).
import { useCallback, useRef, useState } from "react";

export type DetectedFont = {
  family: string; weight: number; category: string;
  score: number | null; lowConfidence: boolean;
  alternatives: string[];            // e.g. ["Lora 600", "Merriweather 800"]
  visionSuggestion: string | null;
};
export type DetectedItem = {
  id: string;                        // "t1" -> data-detected-id="t1" (hidden outlines), id="editable-t1" (text)
  text: string;
  kind: "line" | "arc" | "glyph";
  geometry: { angle?: number; centre?: [number, number]; radius?: number };
  bbox: [number, number, number, number];   // SVG user units
  fill: string | null;
  capHeight: number;
  contours: number;
  source: "crop" | "fullpage";       // "fullpage" = found by the safety-net pass, worth a review
  font: DetectedFont | null;
};
export type DetectResult = {
  items: DetectedItem[];
  editableSvg: string;               // load this into the canvas
  rejected: string[];
  timing: Record<string, number>;
};

// Dev: EXPO_PUBLIC_SVGTEXT_API=http://localhost:8010   Prod (behind Caddy): /api/text
const API = (process.env.EXPO_PUBLIC_SVGTEXT_API ?? "/api/text").replace(/\/$/, "");
const TIMEOUT_MS = 90_000;

export function useDetectText() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const detect = useCallback(async (svg: string, filename = "design.svg"): Promise<DetectResult | null> => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", new Blob([svg], { type: "image/svg+xml" }), filename);
      const res = await fetch(`${API}/detect`, { method: "POST", body: form, signal: ac.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as any));
        const msg =
          res.status === 502 ? "Text service can't reach the vision model (tunnel down?)" :
          res.status === 415 ? "That file isn't a valid SVG" :
          res.status === 413 ? "SVG is too large (20 MB max)" :
          body.detail || `Text service error ${res.status}`;
        throw new Error(msg);
      }
      return (await res.json()) as DetectResult;
    } catch (e: any) {
      setError(e?.name === "AbortError" ? "Timed out or cancelled" : e?.message ?? String(e));
      return null;
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }, []);

  const cancel = useCallback(() => ctrl.current?.abort(), []);
  return { detect, cancel, busy, error };
}
