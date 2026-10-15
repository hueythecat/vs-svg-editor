// Client side of the "Qwen — AI MCP tools" Text detection choice: the svg-text service
// (assets/ai-tools, reached through /api/text-tools) and the step that turns what it
// returns into this editor's own text layers.
//
// The service answers with an editable copy of the artwork: each item's outlines are
// wrapped in <g data-detected-id="tN" display="none"> where they were, and the
// replacement text sits in one <g id="editable-text"> at the end. That last group is one
// layer as far as the editor is concerned, so the Text tab could never pick out a single
// line in it. Each <text> is lifted to the root instead, the shape the other Customise
// passes give their fields, and listed as a layer of its own.
import type { SvgLayer } from '@/lib/svg-utils';

export type TextToolsFont = {
  family: string; weight: number; category: string;
  score: number | null; lowConfidence: boolean;
  alternatives: string[];            // e.g. ["Lora 600", "Merriweather 800"]
  visionSuggestion: string | null;
};
export type TextToolsItem = {
  id: string;                        // "t1": data-detected-id on the outlines, editable-t1 on the text
  text: string;
  kind: 'line' | 'arc' | 'glyph';
  bbox: [number, number, number, number];   // SVG user units
  fill: string | null;
  capHeight: number;
  source: 'crop' | 'fullpage';       // 'fullpage' = found by the service's safety-net pass
  font: TextToolsFont | null;
};
// The service's font suggestions for the design as a whole, separate from the face it
// matched to each item. matchedInDesign marks one it also found in the artwork itself.
export type TextToolsDesignFont = {
  family: string; weight: number; category: string;
  reason: string;
  matchedInDesign: boolean;
};
export type TextToolsResult = {
  items: TextToolsItem[];
  designFonts?: TextToolsDesignFont[];   // absent from older versions of the service
  editableSvg: string;
  rejected: string[];
  timing: Record<string, number>;
};

export async function detectWithTextTools(svg: string, filename: string): Promise<TextToolsResult> {
  const res = await fetch('/api/text-tools', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ svg, filename }),
  });
  const body = await res.json().catch(() => null) as (TextToolsResult & { error?: { message?: string } }) | null;
  if (!res.ok || !body || body.error) {
    throw new Error(body?.error?.message ?? `Text service error ${res.status}`);
  }
  if (!Array.isArray(body.items) || typeof body.editableSvg !== 'string') {
    throw new Error('The text service sent back something unexpected');
  }
  return body;
}

// "'Barlow Condensed', sans-serif" -> "Barlow Condensed". The Text tab's font list holds
// bare family names, and a stack would never match one of them.
const firstFamily = (stack: string) => stack.split(',')[0].trim().replace(/^['"]|['"]$/g, '');

/** Lift the service's editable text out of its one group into a root-level <text> per
 *  item. Returns the document (serialised, root <svg> only — no XML declaration) and a
 *  layer row per lifted field, or null when the SVG cannot be parsed. */
export function liftEditableText(
  editableSvg: string,
  items: TextToolsItem[],
  idPrefix = `_text_${Date.now()}`,
): { content: string; textLayers: SvgLayer[] } | null {
  const doc = new DOMParser().parseFromString(editableSvg, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return null;
  const root = doc.documentElement;
  const group = doc.getElementById('editable-text');
  const byId = new Map(items.map((it) => [it.id, it]));
  const textLayers: SvgLayer[] = [];

  for (const g of Array.from(group?.querySelectorAll('[data-source]') ?? [])) {
    const item = byId.get(g.getAttribute('data-source') ?? '');
    const text = g.querySelector('text');
    if (!item || !text) continue;
    const id = `${idPrefix}_${item.id}`;
    text.id = id;
    text.setAttribute('data-name', item.text);
    const family = firstFamily(text.getAttribute('font-family') ?? '');
    if (family) text.setAttribute('font-family', family);
    // Flat text is re-anchored on its centre, which is what every other field in the
    // editor is placed by — editing the words then grows them both ways rather than off
    // to the right. The service sets x at the left edge with a fitted textLength, so the
    // centre is half that length along. Curved text keeps its path's own anchoring.
    const length = Number(text.getAttribute('textLength'));
    if (!text.querySelector('textPath') && Number.isFinite(length) && length > 0) {
      text.setAttribute('x', String(Number(text.getAttribute('x') ?? 0) + length / 2));
      text.setAttribute('text-anchor', 'middle');
    }
    root.appendChild(text);
    textLayers.push({ id, label: item.text });
  }
  group?.remove();
  return { content: new XMLSerializer().serializeToString(root), textLayers };
}
