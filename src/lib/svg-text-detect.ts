// Browser-side text detection for the Customise pass — the "New — DOM regions" option
// in the AI tools panel. Ported from assets/new-api-call/svgTextDetect.js.
//
// The browser already renders SVG, so bboxes, transforms and CSS are resolved natively:
// every shape is measured off-screen, live <text> becomes a region as-is, and outlined
// glyph paths are clustered into words/lines. The artwork is then rendered twice — clean,
// and with each region boxed and numbered — and both go to /api/svg-text with a short
// brief. The model reads and styles the numbered regions; the DOM facts stay ours and
// are merged around its answer.
//
// The result follows the reference format (vectorstock_1993268_text_regions.json):
// each region names its editor layer (layer, layer_uuid), the CSS classes of its shapes
// (class_uuids), a bbox in the SVG's own user units, and every shape by xpath — so a
// region is addressable glyph by glyph even when the file gives the glyphs no ids.
//
// Only the final call goes through the backend proxy, which keeps the API key off the client.

const RENDER_W = 1800;                  // px long-edge render
const PROXY_URL = '/api/svg-text';
const SHAPES = 'path,rect,circle,ellipse,polygon,polyline,text';

// A gap between neighbouring glyphs wider than this fraction of the line height is a
// word space. Letter spacing in display type rarely passes ~0.2 of the cap height; a
// space is usually 0.25–0.35.
const WORD_GAP_FRAC = 0.24;

// Overlapping shapes only count as faces of one letter when their bboxes are of similar
// area. An extruded letter's face and side measure 1.0–1.5× each other; a monogram inside
// its shield frame is 4–30×, and joining those swallows the letter into the ornament.
const MAX_OVERLAP_AREA_RATIO = 3;

type BBox = [number, number, number, number]; // x0, y0, x1, y1 in render px

type Collected = {
  xpath: string;
  kind: 'text' | 'path';
  bbox: BBox;
  fill: string;
  paint: string;             // fill as compared when clustering — see paintKey
  classes: string[];
  layerId: string | null;
  group: string;             // xpath of the SVG group the shape clusters within
  text?: string;
  fontFamily: string;
  fontWeight: string;
  fontSize: string;
};

type Region = {
  region: number;
  els: Collected[];
  bbox: BBox;
  fill: string;
  source: 'live_text' | 'outlined_paths';
  svgText?: string;
};

export type LayerRef = { id: string; label: string };

type WordOut = { text_content?: string; font_weight?: string; xpaths?: string[]; bbox?: number[] } & Record<string, unknown>;

export type DetectedTextRegion = {
  region: number;
  layer: string | null;
  layer_uuid: string | null;
  fill: string;
  class_uuids: string[];
  glyph_paths: number;
  bbox: number[];
  source: Region['source'];
  xpaths: string[];
  words?: WordOut[];
} & Record<string, unknown>;

// ---------- 1. Mount the SVG off-screen at a fixed pixel width ----------
function mountSvg(svgString: string): { host: HTMLDivElement; svg: SVGSVGElement } {
  const host = document.createElement('div');
  host.style.cssText = `position:absolute;left:-100000px;top:0;visibility:hidden;width:${RENDER_W}px`;
  host.innerHTML = svgString;
  document.body.appendChild(host);
  const svg = host.querySelector('svg');
  if (!svg) {
    host.remove();
    throw new Error('Text detection: the document has no <svg> root');
  }
  const vb = svg.viewBox.baseVal;
  const aspect = vb && vb.width ? vb.height / vb.width : svg.getBBox().height / svg.getBBox().width;
  svg.setAttribute('width', String(RENDER_W));
  svg.setAttribute('height', String(Math.round(RENDER_W * aspect)));
  return { host, svg };
}

// "/*/*[2]/*[4]/*[1]" — the root is "/*", then each step is the 1-based position among
// the parent's element children. Same form as the reference output.
function xpathOf(el: Element, root: Element): string {
  const steps: string[] = [];
  for (let n: Element = el; n !== root; n = n.parentElement!) {
    steps.unshift(`/*[${Array.prototype.indexOf.call(n.parentElement!.children, n) + 1}]`);
  }
  return '/*' + steps.join('');
}

// The editor layer an element belongs to: its nearest ancestor-or-self in the layer list.
function layerIdOf(el: Element, root: Element, layerIds: Set<string>): string | null {
  for (let n: Element | null = el; n && n !== root; n = n.parentElement) if (n.id && layerIds.has(n.id)) return n.id;
  return null;
}

// The group a shape clusters within: its parent, skipping wrappers that hold nothing
// else (an Illustrator mask or clip group around a single path), so the wrapped path
// still counts as a sibling of the shapes beside its wrapper.
function groupOf(el: Element, root: Element): Element {
  let g = el.parentElement!;
  while (g !== root && g.children.length === 1 && g.parentElement) g = g.parentElement;
  return g;
}

// Computed colours come back as rgb()/rgba(); the reference reports hex.
function toHex(color: string): string {
  const m = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return color;
  return '#' + m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('');
}

// Illustrator gives every object its own gradient, so nine identical gold letters carry
// nine different url(#…) fills and never count as the same colour (vectorstock_23517236's
// LUXURIOUS). Gradients are compared by their stops instead, following href to the
// gradient that actually holds them.
function paintKey(fill: string, svg: SVGSVGElement): string {
  let id = fill.match(/^url\(["']?#([^"')]+)/)?.[1];
  if (!id) return toHex(fill);
  for (let hops = 0; id && hops < 5; hops++) {
    const grad: Element | null = svg.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!grad) break;
    const stops = Array.from(grad.querySelectorAll('stop'));
    if (stops.length) {
      return 'gradient(' + stops.map((s) => {
        const cs = getComputedStyle(s);
        return `${toHex(cs.stopColor)} ${s.getAttribute('offset') ?? 0} ${cs.stopOpacity}`;
      }).join(', ') + ')';
    }
    id = (grad.getAttribute('href') ?? grad.getAttribute('xlink:href'))?.replace(/^#/, '');
  }
  return fill;
}

// ---------- 2. Collect elements with pixel bboxes + computed styles ----------
function collect(svg: SVGSVGElement, layerIds: Set<string>): Collected[] {
  const origin = svg.getBoundingClientRect();
  const out: Collected[] = [];
  for (const el of Array.from(svg.querySelectorAll(SHAPES))) {
    if (el.closest('defs,clipPath,mask,symbol')) continue;
    const r = el.getBoundingClientRect();              // includes all transforms
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);                   // resolves classes / <style> rules
    const isText = el.tagName.toLowerCase() === 'text';
    out.push({
      xpath: xpathOf(el, svg),
      kind: isText ? 'text' : 'path',
      bbox: [r.left - origin.left, r.top - origin.top, r.right - origin.left, r.bottom - origin.top],
      fill: toHex(cs.fill),
      paint: paintKey(cs.fill, svg),
      classes: Array.from(el.classList),
      layerId: layerIdOf(el, svg, layerIds),
      group: xpathOf(groupOf(el, svg), svg),
      text: isText ? (el.textContent ?? '').trim() : undefined,
      fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontSize: cs.fontSize,
    });
  }
  return out;
}

const unionBox = (els: Collected[]): BBox => [
  Math.min(...els.map((e) => e.bbox[0])), Math.min(...els.map((e) => e.bbox[1])),
  Math.max(...els.map((e) => e.bbox[2])), Math.max(...els.map((e) => e.bbox[3])),
];

// ---------- 3. Cluster outlined glyph paths into words/lines ----------
// Two glyphs belong to one region when they sit in the same SVG group and either
//   • share a fill and sit side by side on a line (the original test: overlapping
//     vertically by half the shorter one, with a gap under gapFactor × the taller), or
//   • overlap each other and are of similar size — the faces of one extruded letter,
//     whatever their colours (see MAX_OVERLAP_AREA_RATIO).
// Staying inside a group is what the reference does: it keeps a contact icon out of the
// line of text beside it, and keeps the pieces of a logo letter together.
//
// Pairwise with union-find rather than the original's single pass, which dropped each
// glyph into the first cluster it touched and never joined two clusters afterwards — so
// the result depended on visiting order, and "LOGONAME" came out as LOG / ON / AME.
//
// maxGlyphFrac drops shapes too tall to be a glyph — backgrounds, frames. It was 0.25,
// which silently threw out poster headlines: the BEER letters on vectorstock_1432338
// are 0.34–0.36 of the canvas height and never reached clustering.
function clusterGlyphs(paths: Collected[], canvasH: number, maxGlyphFrac = 0.5, gapFactor = 0.8): Collected[][] {
  const glyphs = paths.filter((p) => { const h = p.bbox[3] - p.bbox[1]; return h > 0 && h < canvasH * maxGlyphFrac; });
  const parent = glyphs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));

  // On one line and side by side, not one inside the other: neighbouring letters barely
  // overlap horizontally, while a word set on a same-colour banner or a monogram inside
  // its ring lies wholly within the ornament's span (vectorstock_4505328). Nor flat: no
  // glyph, and not even a long word outlined as one path (~6.5:1), is FLAT_RATIO× wider
  // than tall, but the mirrored halves of vectorstock_1993268's card shadow are ~15×.
  const FLAT_RATIO = 8;
  const beside = (a: BBox, b: BBox) => {
    const ah = a[3] - a[1], bh = b[3] - b[1];
    if (a[2] - a[0] > FLAT_RATIO * ah || b[2] - b[0] > FLAT_RATIO * bh) return false;
    const vOverlap = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
    const hOverlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    if (hOverlap >= 0.5 * Math.min(a[2] - a[0], b[2] - b[0])) return false;
    const hGap = Math.max(a[0] - b[2], b[0] - a[2], 0);
    return vOverlap > 0.5 * Math.min(ah, bh) && hGap < gapFactor * Math.max(ah, bh);
  };

  const joins = (a: Collected, b: Collected) => {
    const [ax0, ay0, ax1, ay1] = a.bbox, [bx0, by0, bx1, by1] = b.bbox;
    const ah = ay1 - ay0, bh = by1 - by0;
    const vOverlap = Math.min(ay1, by1) - Math.max(ay0, by0);
    const hOverlap = Math.min(ax1, bx1) - Math.max(ax0, bx0);
    if (vOverlap > 0 && hOverlap > 0) {
      const aArea = (ax1 - ax0) * ah, bArea = (bx1 - bx0) * bh;
      const minArea = Math.min(aArea, bArea);
      if (hOverlap * vOverlap > 0.3 * minArea && Math.max(aArea, bArea) <= MAX_OVERLAP_AREA_RATIO * minArea) return true;
    }
    return a.paint === b.paint && beside(a.bbox, b.bbox);
  };

  const byGroup = new Map<string, number[]>();
  glyphs.forEach((g, i) => byGroup.set(g.group, [...(byGroup.get(g.group) ?? []), i]));
  for (const idx of byGroup.values()) {
    for (let x = 0; x < idx.length; x++) {
      for (let y = x + 1; y < idx.length; y++) {
        if (joins(glyphs[idx[x]], glyphs[idx[y]])) parent[find(idx[x])] = find(idx[y]);
      }
    }
  }

  // A group that came out as one glyph — each letter in its own <g>, face and extrusion
  // together (vectorstock_1432338's BEER) — never meets the letters beside it above. Such
  // groups are joined with their sibling one-glyph groups when they share a colour and sit
  // side by side. Only with each other: a lone shape directly in the parent is as likely
  // a monogram as a letter, and the scrolls either side of vectorstock_4505328's P are
  // one-glyph groups too. Never across the root, which would join across layers.
  const byParent = new Map<string, { root: number; bbox: BBox; paints: Set<string> }[]>();
  for (const [group, idx] of byGroup) {
    const up = group.replace(/\/\*\[\d+\]$/, '');
    if (up === group || up === '/*' || new Set(idx.map(find)).size !== 1) continue;
    const els = idx.map((i) => glyphs[i]);
    byParent.set(up, [...(byParent.get(up) ?? []), {
      root: find(idx[0]), bbox: unionBox(els), paints: new Set(els.map((e) => e.paint)),
    }]);
  }
  for (const cs of byParent.values()) {
    for (let x = 0; x < cs.length; x++) {
      for (let y = x + 1; y < cs.length; y++) {
        const a = cs[x], b = cs[y];
        if ([...a.paints].some((p) => b.paints.has(p)) && beside(a.bbox, b.bbox)) parent[find(a.root)] = find(b.root);
      }
    }
  }

  const clusters = new Map<number, Collected[]>();
  glyphs.forEach((g, i) => { const r = find(i); clusters.set(r, [...(clusters.get(r) ?? []), g]); });
  // Top to bottom, then left to right — region numbers read like the artwork. Glyphs
  // within a region go left to right, so its xpaths do too.
  const list = [...clusters.values()]
    .map((els) => els.sort((a, b) => a.bbox[0] - b.bbox[0]))
    .sort((a, b) => unionBox(a)[1] - unionBox(b)[1] || unionBox(a)[0] - unionBox(b)[0]);

  // The original kept clusters of 2+; a lone shape is kept too when it sits in the same
  // layer as a real cluster, which is how the reference picks up the contact icons.
  const textLayers = new Set(list.filter((c) => c.length >= 2).map((c) => c[0].layerId));
  return list.filter((c) => c.length >= 2 || (c[0].layerId !== null && textLayers.has(c[0].layerId)));
}

// The fill most of a region's shapes carry — the purple of an extruded letter's sides
// rather than whichever face happens to sort first.
function mainFill(els: Collected[]): string {
  const counts = new Map<string, number>();
  for (const e of els) counts.set(e.fill, (counts.get(e.fill) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0][0];
}

// Split one region's glyphs into `count` words at its count − 1 widest gaps. The count
// comes from the model's reading: a fixed space threshold can't tell word spaces from
// the tracking of a light, widely spaced face, which is where mixed-weight names live.
function splitWords(els: Collected[], count: number): Collected[][] | null {
  const sorted = [...els].sort((a, b) => a.bbox[0] - b.bbox[0]);
  if (count < 1 || count > sorted.length) return null;
  let right = sorted[0].bbox[2];
  const gaps = sorted.slice(1).map((g, i) => {
    const gap = g.bbox[0] - right;
    right = Math.max(right, g.bbox[2]);
    return { at: i + 1, gap };
  });
  const cuts = gaps.sort((a, b) => b.gap - a.gap).slice(0, count - 1).map((g) => g.at).sort((a, b) => a - b);
  return [0, ...cuts].map((from, i) => sorted.slice(from, cuts[i] ?? sorted.length));
}

// ---------- 4. Render clean + annotated PNGs ----------
async function renderPngs(svg: SVGSVGElement, regions: Region[]): Promise<{ clean: string; annotated: string }> {
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
  });
  const w = svg.width.baseVal.value, h = svg.height.baseVal.value;

  const draw = (annotate: boolean) => {
    const cv = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    if (annotate) {
      const fs = Math.max(14, Math.round(w / 90));
      ctx.font = `bold ${fs}px sans-serif`; ctx.lineWidth = 3;
      for (const r of regions) {
        const [x0, y0, x1, y1] = r.bbox;
        ctx.strokeStyle = '#ff00b4'; ctx.strokeRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6);
        const ty = Math.max(fs, y0 - 6);
        ctx.strokeStyle = '#fff'; ctx.strokeText(String(r.region), x0, ty);
        ctx.fillStyle = '#ff00b4'; ctx.fillText(String(r.region), x0, ty);
      }
    }
    return cv.toDataURL('image/png').split(',')[1];
  };
  const out = { clean: draw(false), annotated: draw(true) };
  URL.revokeObjectURL(url);
  return out;
}

// ---------- 5. Main ----------
// `layers` is the editor's layer list, which names each region's layer. `model` picks
// among /api/svg-text's allowlist (the same as /api/claude's) and `effort` how hard it
// thinks; the route defaults to Sonnet 5 at low effort when they are omitted.
export async function detectSvgText(
  svgString: string,
  opts: { layers?: LayerRef[]; model?: string; effort?: 'low' | 'medium' | 'high' } = {},
): Promise<DetectedTextRegion[]> {
  const layers = opts.layers ?? [];
  const layerLabel = new Map(layers.map((l) => [l.id, l.label]));
  const { host, svg } = mountSvg(svgString);
  try {
    const els = collect(svg, new Set(layerLabel.keys()));
    const regions: Region[] = [
      ...els.filter((e) => e.kind === 'text').map((e) => ({
        els: [e], bbox: e.bbox, fill: e.fill, source: 'live_text' as const, svgText: e.text,
      })),
      ...clusterGlyphs(els.filter((e) => e.kind === 'path'), svg.height.baseVal.value)
        .map((c) => ({ els: c, bbox: unionBox(c), fill: mainFill(c), source: 'outlined_paths' as const })),
    ].map((r, i) => ({ ...r, region: i + 1 }));
    if (!regions.length) return [];

    const images = await renderPngs(svg, regions);
    const brief = regions.map((r) => ({
      region: r.region, source: r.source, fill: r.fill, glyph_paths: r.els.length,
      ...(r.svgText ? { svg_text: r.svgText } : {}),
    }));

    const resp = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model, effort: opts.effort, clean: images.clean, annotated: images.annotated, regions: brief,
      }),
    });
    if (!resp.ok) throw new Error(`Text detection failed: ${resp.status} ${await resp.text()}`);
    const { regions: judged } = await resp.json() as { regions: Array<{ region: number } & Record<string, unknown>> };

    // Render px → the SVG's own user units, which is what the reference reports.
    const vb = svg.viewBox.baseVal;
    const k = vb && vb.width ? vb.width / RENDER_W : 1;
    const ox = vb?.x ?? 0, oy = vb?.y ?? 0;
    const toUser = (b: BBox) => [b[0] * k + ox, b[1] * k + oy, b[2] * k + ox, b[3] * k + oy].map((v) => +v.toFixed(1));

    // Merge: exact facts from the DOM + the model's reading/style
    const byNum = Object.fromEntries(judged.map((j) => [j.region, j]));
    return regions.map((r) => {
      const { region: _region, words: modelWords, ...m } = byNum[r.region] ?? ({} as Record<string, unknown>);
      const layerId = r.els[0].layerId;
      const out: DetectedTextRegion = {
        region: r.region,
        layer: layerId ? layerLabel.get(layerId) ?? layerId : null,
        layer_uuid: layerId,
        fill: r.fill,
        class_uuids: [...new Set(r.els.flatMap((e) => e.classes))].sort(),
        glyph_paths: r.els.length,
        bbox: toUser(r.bbox),
        source: r.source,
        ...(r.source === 'live_text'
          ? { svg_text: r.svgText, font_family_in_file: r.els[0].fontFamily, font_size_in_file: r.els[0].fontSize }
          : {}),
        ...m,
        xpaths: r.els.map((e) => e.xpath),
      };
      // The model's words, each given its glyphs by splitting the region at its widest
      // gaps. Live <text> is one element, so its words can't be split into shapes.
      if (Array.isArray(modelWords) && modelWords.length) {
        const ours = r.source === 'outlined_paths' ? splitWords(r.els, modelWords.length) : null;
        out.words = (modelWords as WordOut[]).map((w, i) => (ours
          ? { ...w, xpaths: ours[i].map((e) => e.xpath), bbox: toUser(unionBox(ours[i])) }
          : w));
      }
      return out;
    });
  } finally {
    host.remove();
  }
}
