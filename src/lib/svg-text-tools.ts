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
// The names come from the model and are not checked against Google Fonts.
export type TextToolsDesignFont = {
  family: string; weight: number;
  category: 'serif' | 'sans-serif' | 'display' | 'handwriting' | 'monospace' | null;
  reason: string | null;
  matchedInDesign: boolean;
};
export type TextToolsResult = {
  items: TextToolsItem[];
  // Empty unless /detect is asked with ?fonts=1, which the editor never does — the Text
  // tab's Suggest fonts button asks /design-fonts instead.
  designFonts?: TextToolsDesignFont[];
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

/** The design-wide font suggestions: one short model call of its own (/design-fonts),
 *  made only when the user asks for them. Null when the service could not be asked or
 *  failed; [] when it answered with none. */
export async function fetchDesignFonts(svg: string): Promise<TextToolsDesignFont[] | null> {
  try {
    const res = await fetch('/api/text-tools?op=design-fonts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ svg }),
    });
    if (!res.ok) return null;
    const body = await res.json() as { designFonts?: unknown };
    return Array.isArray(body.designFonts)
      ? body.designFonts.filter((f): f is TextToolsDesignFont => typeof f?.family === 'string' && f.family !== '')
      : [];
  } catch {
    return null;
  }
}

// The editor hides layers with CSS (the canvas's display:none rules), not in the SVG, so
// the service would read text off layers the user has switched off. They are hidden in the
// copy it is sent instead, and the mark lets liftEditableText take that back off the
// answer. Nothing is removed: the service maps what it finds back to the elements by
// document order, and that has to match the document the editor holds.
const EDITOR_HIDDEN = 'data-editor-hidden';

/** A copy of `svg` with each id in `hidden` set display="none" for the service. */
export function markHiddenForService(svg: string, hidden: Iterable<string>): string {
  const ids = [...hidden];
  if (ids.length === 0) return svg;
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return svg;
  for (const id of ids) {
    const el = doc.getElementById(id);
    if (!el || el.getAttribute('display') === 'none') continue;
    el.setAttribute('display', 'none');
    el.setAttribute(EDITOR_HIDDEN, '1');
  }
  return new XMLSerializer().serializeToString(doc.documentElement);
}

const DETECTED_SOURCE = 'data-detected-source';
// The face the service matched to the item and its runners-up, as "Family weight" entries
// joined with "|" — kept on the field itself so they survive undo and reordering.
const FONT_CHOICES = 'data-font-choices';

export type FontChoice = { family: string; weight: number };

// "Lora 600" -> { family: 'Lora', weight: 600 }; a name with no weight is taken as 400.
export function parseFontChoice(choice: string): FontChoice {
  const m = /^(.*?)\s+(\d{3})$/.exec(choice.trim());
  return m ? { family: m[1], weight: Number(m[2]) } : { family: choice.trim(), weight: 400 };
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
  for (const el of Array.from(root.querySelectorAll(`[${EDITOR_HIDDEN}]`))) {
    el.removeAttribute('display');
    el.removeAttribute(EDITOR_HIDDEN);
  }
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
    // Ties the field to its hidden outlines, for Show original and Not text.
    text.setAttribute(DETECTED_SOURCE, item.id);
    if (item.font) {
      const choices = [`${item.font.family} ${item.font.weight}`, ...item.font.alternatives]
        .filter((c, i, all) => c.trim() && all.indexOf(c) === i);
      text.setAttribute(FONT_CHOICES, choices.join('|'));
    }
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
    const review = item.source === 'fullpage' ? 'text' : item.font?.lowConfidence ? 'font' : undefined;
    textLayers.push(review ? { id, label: item.text, review } : { id, label: item.text });
  }
  group?.remove();
  return { content: new XMLSerializer().serializeToString(root), textLayers };
}

// The service's item id behind a lifted text field, or null for any other layer.
// fontChoices: the service's match first, then its alternatives; empty when it had none.
export function detectedSourceOf(
  svg: string, textId: string,
): { source: string; showingOriginal: boolean; fontChoices: FontChoice[] } | null {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const text = doc.getElementById(textId);
  const source = text?.getAttribute(DETECTED_SOURCE);
  if (!text || !source) return null;
  const fontChoices = (text.getAttribute(FONT_CHOICES) ?? '').split('|').filter(Boolean).map(parseFontChoice);
  return { source, showingOriginal: text.getAttribute('display') === 'none', fontChoices };
}

const originalsOf = (doc: Document, source: string) =>
  Array.from(doc.querySelectorAll(`[data-detected-id="${CSS.escape(source)}"]`));

/** Swap a lifted field for the outlines it replaced, or back. Written into the SVG, like
 *  the service's own hiding, so it exports the way it looks. */
export function showDetectedOriginal(svg: string, textId: string, original: boolean): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const text = doc.getElementById(textId);
  const source = text?.getAttribute(DETECTED_SOURCE);
  if (!text || !source) return svg;
  for (const g of originalsOf(doc, source)) {
    if (original) g.removeAttribute('display'); else g.setAttribute('display', 'none');
  }
  if (original) text.setAttribute('display', 'none'); else text.removeAttribute('display');
  return new XMLSerializer().serializeToString(doc.documentElement);
}

/** "Not text": put the outlines back and drop the field. The caller drops its layer row. */
export function rejectDetected(svg: string, textId: string): string {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const text = doc.getElementById(textId);
  const source = text?.getAttribute(DETECTED_SOURCE);
  if (!text || !source) return svg;
  for (const g of originalsOf(doc, source)) g.removeAttribute('display');
  // An arc's path lives in <defs> under the service's own id for the item.
  doc.getElementById(`arc-${source}`)?.remove();
  text.remove();
  return new XMLSerializer().serializeToString(doc.documentElement);
}

/** Keep the families Google Fonts actually serves. The design-font names come from the
 *  model unchecked, and css2 answers 400 for a family it doesn't have — a name that fails
 *  here would sit in the Font list and render as the fallback face. A check that can't be
 *  made at all (offline, blocked) keeps the name rather than emptying the list. */
export async function servedGoogleFamilies(families: string[]): Promise<string[]> {
  const served = await Promise.all(families.map(async (family) => {
    try {
      const res = await fetch(`https://fonts.googleapis.com/css2?family=${family.replace(/\s+/g, '+')}`);
      return res.ok;
    } catch {
      return true;
    }
  }));
  return families.filter((_, i) => served[i]);
}
