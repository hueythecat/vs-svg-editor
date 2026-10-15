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

// Overlapping shapes only count as faces of one letter when their bboxes are of similar
// area. An extruded letter's face and side measure 1.0–1.5× each other; a monogram inside
// its shield frame is 4–30×, and joining those swallows the letter into the ornament.
const MAX_OVERLAP_AREA_RATIO = 3;

// Subpaths a lone path needs to pass for a whole line of outlined lettering — see the
// end of clusterGlyphs.
const LINE_MIN_SUBPATHS = 4;

// Lone shapes a layer may contribute on the strength of sharing it with real text — see
// the end of clusterGlyphs.
const LONE_PER_LAYER_MAX = 15;

// The most regions one call can carry: /api/svg-text refuses more (its MAX_REGIONS).
const MAX_REGIONS = 150;

// Candidates that cannot be lettering are left out of the call — see notLettering.
const MIN_TEXT_PX = 12;      // a region smaller than this both ways is a speck
const MIN_STROKE_PX = 6;     // thinner than this, and not one narrow letter, is a sliver
const NARROW_LETTER_RATIO = 8;
const LINE_THIN_RATIO = 20;  // a drawn line is at least this many times longer than thick
const LINE_STRAIGHT = 1.6;   // …and no longer than this × its box's diagonal

type BBox = [number, number, number, number]; // x0, y0, x1, y1 in render px

type Collected = {
  el: Element;               // the mounted element, for the geometry strokeLike measures
  xpath: string;
  kind: 'text' | 'path';
  bbox: BBox;
  fill: string;
  paint: string;             // fill as compared when clustering — see paintKey
  subpaths: number;          // moveto commands in a <path>'s d — one per letter part
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
      el,
      xpath: xpathOf(el, svg),
      kind: isText ? 'text' : 'path',
      bbox: [r.left - origin.left, r.top - origin.top, r.right - origin.left, r.bottom - origin.top],
      fill: toHex(cs.fill),
      paint: paintKey(cs.fill, svg),
      subpaths: (el.getAttribute('d')?.match(/[Mm]/g) ?? []).length || 1,
      classes: Array.from(el.classList),
      layerId: layerIdOf(el, svg, layerIds),
      group: xpathOf(groupOf(el, svg), svg),
      text: isText ? (el.textContent ?? '').trim() : undefined,
      fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontSize: cs.fontSize,
    });
  }
  return out;
}

// Clusters in the order they would be read: by row, left to right within a row.
//
// Sorting on the top edge alone does not give that. Letters on one baseline do not share
// a top — round ones overshoot, so a G or an O starts a fraction above a T — and a
// spaced-out line whose letters are each their own cluster came out numbered 7, 5, 9, 10,
// 8, 6, 4 from left to right. The model reads the numbers off the image, and with boxes
// that small and numbers that scrambled it put letters on the wrong boxes.
//
// A cluster joins a row when its vertical centre falls inside the row's first (topmost)
// member and the two are of comparable height, so a tall mark beside a line of small
// lettering stays a row of its own instead of swallowing every line it spans.
function inReadingOrder(clusters: Collected[][]): Collected[][] {
  const boxed = clusters.map((els) => ({ els, box: unionBox(els) }))
    .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  const rows: Array<typeof boxed> = [];
  for (const c of boxed) {
    const cy = (c.box[1] + c.box[3]) / 2;
    const h = Math.max(1, c.box[3] - c.box[1]);
    const row = rows.find(([first]) => {
      const fh = Math.max(1, first.box[3] - first.box[1]);
      return cy >= first.box[1] && cy <= first.box[3] && h <= fh * 2 && fh <= h * 2;
    });
    if (row) row.push(c); else rows.push([c]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.box[0] - b.box[0]).map((c) => c.els));
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

  // A mark stacked on a letter — the dot of an i or j, an accent, a cedilla — is neither
  // beside it nor overlapping it, so it was left as a region of its own: a box around a
  // dot, numbered between the words. On vectorstock_1032105 the two i-dots of "Oceanic
  // crust" and "Continental crust" did that, and a small model dealing eight labels out
  // in number order gave a label to each dot and ran out before the last three words.
  //
  // So a shape still on its own joins a letter's cluster when it is the same colour, in
  // the same group, no bigger than half that letter's height either way, at least a third
  // of its width, and sits just clear of it directly above or below. Only into a cluster that already holds two
  // shapes: this can remove a region, never make one — an islet over a lone landmass
  // must not turn two shapes that were not candidates into a region that is.
  const size = new Map<number, number>();
  glyphs.forEach((_, i) => size.set(find(i), (size.get(find(i)) ?? 0) + 1));
  const lone = glyphs.map((_, i) => size.get(find(i)) === 1);
  const stackedOn = (m: BBox, g: BBox) => {
    const mw = m[2] - m[0], mh = m[3] - m[1], gw = g[2] - g[0], gh = g[3] - g[1];
    if (mh > 0.5 * gh || mw > 0.5 * gh) return false;
    // About as wide as what it sits on: a dot is the width of its stem and an accent a
    // good part of its letter, while a stud over a badge's ornament (vectorstock_14306497)
    // or a speck over a landmass is a small fraction of the shape below it.
    if (mw < 0.3 * gw) return false;
    const cx = (m[0] + m[2]) / 2;
    if (cx < g[0] - mw / 2 || cx > g[2] + mw / 2) return false;
    const gap = Math.max(g[1] - m[3], m[1] - g[3]);   // negative when the mark is inside the letter's box
    return gap > -0.25 * mh && gap <= 2.5 * mh;
  };
  for (const idx of byGroup.values()) {
    for (const m of idx) {
      if (!lone[m]) continue;
      const letter = idx.find((g) => !lone[g] && glyphs[g].paint === glyphs[m].paint && stackedOn(glyphs[m].bbox, glyphs[g].bbox));
      if (letter !== undefined) parent[find(m)] = find(letter);
    }
  }

  const clusters = new Map<number, Collected[]>();
  glyphs.forEach((g, i) => { const r = find(i); clusters.set(r, [...(clusters.get(r) ?? []), g]); });
  // Row by row, then left to right — region numbers read like the artwork. Glyphs within
  // a region go left to right, so its xpaths do too.
  const list = inReadingOrder([...clusters.values()].map((els) => els.sort((a, b) => a.bbox[0] - b.bbox[0])));

  // The original kept clusters of 2+; a lone shape is kept too when it sits in the same
  // layer as a real cluster, which is how the reference picks up the contact icons.
  //
  // Or when it looks like a line of lettering outlined as ONE path: several subpaths (a
  // letter and each of its holes is one) in a strip at least twice as wide as tall.
  // vectorstock_34038068's COMPANY NAME and TAGLINE HERE are that, alone in their own
  // layer, and were dropped while the fish beside them was kept. A single glyph fails the
  // width test and a plain shape the subpath one.
  //
  // The layer rule stops at LONE_PER_LAYER_MAX. Text artwork puts a handful of lone shapes
  // beside its lettering (≤ 11 across the samples); an illustration layer holds dozens to
  // thousands — every landmass of vectorstock_1032105's globe, every piece of
  // vectorstock_20430206's cats — and sending them all made the answer too long to finish
  // (or the request too big to accept). Past the cap a layer's lone shapes are not text
  // candidates at all, except the ones that look like an outlined line.
  const textLayers = new Set(list.filter((c) => c.length >= 2).map((c) => c[0].layerId));
  const outlinedLine = (e: Collected) =>
    e.subpaths >= LINE_MIN_SUBPATHS && e.bbox[2] - e.bbox[0] >= 2 * (e.bbox[3] - e.bbox[1]);
  const byLayerRule = (c: Collected[]) => c[0].layerId !== null && textLayers.has(c[0].layerId);
  const lonePerLayer = new Map<string | null, number>();
  for (const c of list) {
    if (c.length === 1 && !outlinedLine(c[0]) && byLayerRule(c)) {
      lonePerLayer.set(c[0].layerId, (lonePerLayer.get(c[0].layerId) ?? 0) + 1);
    }
  }
  return list.filter((c) => c.length >= 2 || outlinedLine(c[0])
    || (byLayerRule(c) && (lonePerLayer.get(c[0].layerId) ?? 0) <= LONE_PER_LAYER_MAX));
}

// Whether a shape is a drawn line — a leader, a rule, an underline — outlined as a filled
// shape: one outline, far longer than it is thick, and running more or less straight.
//
// Half the outline's length is the line's length, and the area inside it over that is its
// thickness. Straightness is what keeps hairline lettering: a thin c, s or n is just as
// long for its thickness, but it curls back inside its own box, where a leader with one
// elbow is never more than √2 × the diagonal. Both figures are ratios, so the element's
// own units do, whatever transforms scale it on the way to the screen.
function strokeLike(e: Collected): boolean {
  const el = e.el;
  if (e.subpaths !== 1 || !(el instanceof SVGGeometryElement)) return false;
  try {
    const perimeter = el.getTotalLength();
    const box = el.getBBox();
    if (!(perimeter > 0)) return false;
    const SAMPLES = 64;
    let twiceArea = 0;
    let prev = el.getPointAtLength(0);
    for (let i = 1; i <= SAMPLES; i++) {
      const pt = el.getPointAtLength((perimeter * i) / SAMPLES);
      twiceArea += prev.x * pt.y - pt.x * prev.y;
      prev = pt;
    }
    const length = perimeter / 2;
    const thickness = Math.abs(twiceArea) / 2 / length;
    return length >= LINE_THIN_RATIO * thickness && length <= LINE_STRAIGHT * Math.hypot(box.width, box.height);
  } catch {
    return false;   // not rendered, or a shape the browser won't measure
  }
}

// Why a cluster of outlined shapes cannot be lettering, or null when it might be.
//
// Every region sent is a numbered box the model has to keep track of, and a small model
// loses track: on vectorstock_1032105 — eight labels among 34 boxes, thirteen of them
// specks and slivers of the globe and four the labels' leader lines — it gave a label to
// every box. None of these can hold text a reader could see, so they are not asked about:
//
//   • a speck: under MIN_TEXT_PX both ways in the 1800px render. The smallest lettering
//     across the samples is 16px tall (vectorstock_20086499's tagline).
//   • a sliver: thinner than MIN_STROKE_PX. One narrow letter is the exception — that
//     tagline's I is 4.5 × 18px — so a single shape no more than NARROW_LETTER_RATIO
//     times longer than wide is kept.
//   • drawn lines: every shape in it is strokeLike.
function notLettering(els: Collected[], bbox: BBox): 'speck' | 'sliver' | 'line' | null {
  const w = bbox[2] - bbox[0], h = bbox[3] - bbox[1];
  const long = Math.max(w, h), short = Math.min(w, h);
  if (long < MIN_TEXT_PX) return 'speck';
  if (short < MIN_STROKE_PX && !(els.length === 1 && long <= NARROW_LETTER_RATIO * short)) return 'sliver';
  if (els.every(strokeLike)) return 'line';
  return null;
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
// What one detection call cost, for the AI tools panel. Tokens are whatever the upstream
// reported; the phase timings exist only for the local model, which is the one slow
// enough for "where did the time go" to be a question.
export type TextDetectStats = {
  model: string;
  seconds: number;          // the call as the browser saw it, request to answer
  regions: number;
  inputTokens: number | null;
  outputTokens: number | null;
  phases: { load: number; read: number; write: number } | null;   // seconds
};

// Joins the regions that make up one line of text into a single region.
//
// The candidates come from measuring the SVG, and widely tracked lettering defeats that:
// each letter of a spaced-out tagline is far enough from its neighbours to be boxed on
// its own, so "YOUR TAGLINE" arrives as eleven one-letter regions and would become eleven
// one-letter text fields. Tuning the clustering to reach across those gaps has broken
// other artwork every time it was tried. The model, though, can see it is one line — so
// it is asked to say so (`lines` in the route's prompt).
//
// What the model is trusted for is narrow: THAT there is a split line, roughly where, and
// what it reads. Which boxes belong to it is decided here, from geometry. The model's own
// list can't be used for that — on the artwork this was built for it left a box out and
// re-read its neighbours so the letters still spelled the line, which any check on the
// spelling passes. So its list is only a pointer to the row:
//
//   • the row is every outlined region in the same colour as the boxes it named, on their
//     baseline band and of comparable height;
//   • read left to right, that row must hold exactly as many shapes as the line has
//     letters. One shape per letter is what split lettering looks like, and it is the
//     test a wrong answer fails: a row that also took in an icon, or a line the model
//     misread, does not count out.
//
// A line that fails is dropped and its regions stay as they were — the worst outcome is
// the behaviour from before this existed.
//
// The joined region takes its styling from the model's description of the first box, the
// line's text, every box's shapes in reading order, their combined bbox, and the lowest
// of their numbers.
const letterCount = (s: string): number => s.replace(/\s+/g, '').length;

function joinLines(
  regions: DetectedTextRegion[],
  lines: Array<{ regions?: unknown; text_content?: unknown }> | undefined,
  // Each region's individual shapes, as [x0, y0, x1, y1] in any one consistent unit.
  shapesOf: Map<number, BBox[]>,
): DetectedTextRegion[] {
  if (!Array.isArray(lines) || lines.length === 0) return regions;
  const byNum = new Map(regions.map((r) => [r.region, r]));
  const taken = new Set<number>();
  const joined: DetectedTextRegion[] = [];
  const mid = (r: DetectedTextRegion) => (r.bbox[1] + r.bbox[3]) / 2;
  const height = (r: DetectedTextRegion) => Math.max(1e-6, r.bbox[3] - r.bbox[1]);
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

  for (const line of lines) {
    const text = typeof line.text_content === 'string' ? line.text_content.trim() : '';
    const named = (Array.isArray(line.regions) ? [...new Set(line.regions as number[])] : [])
      .flatMap((n) => { const r = byNum.get(n); return r && r.source === 'outlined_paths' ? [r] : []; });
    const skip = (reason: string) => console.log(`[text-detect] ignoring line ${JSON.stringify(line)} — ${reason}`);
    if (!text) { skip('no text'); continue; }
    if (named.length < 2) { skip('names fewer than two outlined regions'); continue; }

    // The row the named boxes sit on, in their commonest colour.
    const fills = named.map((r) => r.fill);
    const fill = [...new Set(fills)].sort((a, b) => fills.filter((f) => f === b).length - fills.filter((f) => f === a).length)[0];
    const seeds = named.filter((r) => r.fill === fill);
    const top = median(seeds.map((r) => r.bbox[1]));
    const bottom = median(seeds.map((r) => r.bbox[3]));
    const h = median(seeds.map(height));
    const row = regions
      .filter((r) => r.source === 'outlined_paths' && r.fill === fill && !taken.has(r.region)
        && mid(r) >= top && mid(r) <= bottom && height(r) <= h * 2 && h <= height(r) * 2)
      .sort((a, b) => a.bbox[0] - b.bbox[0]);

    const shapes = row.reduce((n, r) => n + r.glyph_paths, 0);
    if (row.length < 2) { skip('its row holds a single region'); continue; }
    if (shapes !== letterCount(text)) {
      skip(`its row holds ${shapes} shape(s) but the line has ${letterCount(text)} letter(s)`);
      continue;
    }

    const nums = row.map((r) => r.region);
    nums.forEach((n) => taken.add(n));
    // How far apart the letters are set, in ems, so the field that replaces them can be
    // tracked out to match instead of collapsing to normal spacing. Measured between the
    // individual letter shapes, not between the regions: a line split into two words has
    // one gap between its regions and that gap is the word space, which says nothing
    // about tracking. Across every shape in the row the letter gaps outnumber the word
    // gaps, so the median is a letter gap. Taken against the font size, with capitals as
    // ~0.72 of it; ~0.08em of every gap is the side bearings any font has, not tracking.
    const letters = row.flatMap((r) => shapesOf.get(r.region) ?? []).sort((a, b) => a[0] - b[0]);
    const letterGaps = letters.slice(1).map((b, i) => b[0] - letters[i][2]);
    const capHeight = letters.length ? median(letters.map((b) => b[3] - b[1])) : 0;
    const tracking = letterGaps.length && capHeight > 0
      ? Math.max(0, +(median(letterGaps) / (capHeight / 0.72) - 0.08).toFixed(2))
      : 0;
    // Styling from the leftmost box the model actually called text; the row's first box
    // as a fallback, with the fields a text region needs filled in.
    const { words: _words, ...first } = row.find((r) => r.is_text === true) ?? row[0];
    const confidences = row.map((r) => r.confidence).filter((c): c is number => typeof c === 'number');
    joined.push({
      ...first,
      region: Math.min(...nums),
      is_text: true,
      text_content: text,
      xpaths: row.flatMap((r) => r.xpaths),
      glyph_paths: shapes,
      class_uuids: [...new Set(row.flatMap((r) => r.class_uuids))].sort(),
      bbox: [
        Math.min(...row.map((r) => r.bbox[0])), Math.min(...row.map((r) => r.bbox[1])),
        Math.max(...row.map((r) => r.bbox[2])), Math.max(...row.map((r) => r.bbox[3])),
      ],
      replaceable: row.some((r) => r.replaceable === true),
      letter_spacing: tracking,
      ...(confidences.length ? { confidence: Math.min(...confidences) } : {}),
      // Kept so a result can be traced back to the boxes the model was shown.
      joined_regions: nums,
    });
    console.log(`[text-detect] joined regions ${nums.join(', ')} into one line: ${JSON.stringify(text)} (tracking ~${tracking}em)`);
  }
  if (joined.length === 0) return regions;
  return [...regions.filter((r) => !taken.has(r.region)), ...joined].sort((a, b) => a.region - b.region);
}

// Split lines the model read box by box but did not report in `lines`.
//
// joinLines only acts on a line the model names, and a small model does not name them
// reliably: asked the same question eight times about one tagline, qwen3-vl:8b-instruct
// read all eleven letters correctly every time and reported the line in five. So after
// the call the row is looked for here as well, from what the model said about each box
// and where the boxes are:
//
//   • every box is outlined shapes the model read as text, with one letter per shape —
//     a reading that doesn't account for its shapes is not one to build a line from;
//   • they share a colour, role, weight and slant, sit on one baseline band and are of
//     comparable height;
//   • they are typically no more than LINE_GAP_EM apart, and no gap is wider than a word
//     space at that tracking (WORD_GAP × the typical gap).
//
// The limit is 1.25em rather than 1: the tagline this was written for is tracked at
// about 1em, and edge to edge its letters measure 0.86–1.07em apart because narrow
// letters (I, L) leave more room than wide ones. Its word space is 2.16em.
//
// What comes out is a line for joinLines, not a joined region, so the same count — the
// row's shapes against the line's letters — still decides whether anything is joined.
const LINE_GAP_EM = 1.25;
const WORD_GAP = 2.5;    // widest gap still inside a line, in typical gaps
const SPACE_GAP = 1.5;   // a gap this much wider than typical is a word space

function unreportedLines(regions: DetectedTextRegion[]): Array<{ regions: number[]; text_content: string }> {
  const height = (r: DetectedTextRegion) => Math.max(1e-6, r.bbox[3] - r.bbox[1]);
  const mid = (r: DetectedTextRegion) => (r.bbox[1] + r.bbox[3]) / 2;
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const pool = regions
    .filter((r) => r.source === 'outlined_paths' && r.is_text === true && !r.joined_regions
      && typeof r.text_content === 'string' && letterCount(r.text_content) === r.glyph_paths)
    .sort((a, b) => a.bbox[0] - b.bbox[0]);

  const lines: Array<{ regions: number[]; text_content: string }> = [];
  const used = new Set<number>();
  for (const seed of pool) {
    if (used.has(seed.region)) continue;
    const row = pool.filter((r) => !used.has(r.region)
      && r.fill === seed.fill && r.role === seed.role
      && r.font_weight === seed.font_weight && r.italic === seed.italic
      && mid(r) >= seed.bbox[1] && mid(r) <= seed.bbox[3]
      && height(r) <= height(seed) * 2 && height(seed) <= height(r) * 2);
    row.forEach((r) => used.add(r.region));
    if (row.length < 2) continue;

    // Capitals as ~0.72 of the font size, as in joinLines.
    const em = median(row.map(height)) / 0.72;
    const gaps = row.slice(1).map((r, i) => r.bbox[0] - row[i].bbox[2]);
    const typical = median(gaps);
    const nums = row.map((r) => r.region);
    if (typical > LINE_GAP_EM * em || Math.max(...gaps) > WORD_GAP * Math.max(typical, 1e-6)) {
      console.log(`[text-detect] regions ${nums.join(', ')} share a row but are too far apart to be one line `
        + `(typically ${(typical / em).toFixed(2)}em, at most ${(Math.max(...gaps) / em).toFixed(2)}em)`);
      continue;
    }
    // A box holding several letters is a word, so the gap beside it is a word space;
    // between single letters only a gap clearly wider than the rest is.
    const text = row.map((r, i) => {
      const spaced = i > 0
        && (r.glyph_paths > 1 || row[i - 1].glyph_paths > 1 || gaps[i - 1] > SPACE_GAP * typical);
      return (spaced ? ' ' : '') + (r.text_content as string).trim();
    }).join('');
    console.log(`[text-detect] regions ${nums.join(', ')} read as one line the model did not report: ${JSON.stringify(text)}`);
    lines.push({ regions: nums, text_content: text });
  }
  return lines;
}

export async function detectSvgText(
  svgString: string,
  opts: { layers?: LayerRef[]; model?: string; effort?: 'low' | 'medium' | 'high'; fontSuggestions?: number } = {},
): Promise<{ regions: DetectedTextRegion[]; fonts: string[]; stats: TextDetectStats | null }> {
  const layers = opts.layers ?? [];
  const layerLabel = new Map(layers.map((l) => [l.id, l.label]));
  const { host, svg } = mountSvg(svgString);
  try {
    const els = collect(svg, new Set(layerLabel.keys()));
    let candidates = [
      ...els.filter((e) => e.kind === 'text').map((e) => ({
        els: [e], bbox: e.bbox, fill: e.fill, source: 'live_text' as const, svgText: e.text,
      })),
      ...clusterGlyphs(els.filter((e) => e.kind === 'path'), svg.height.baseVal.value)
        .map((c) => ({ els: c, bbox: unionBox(c), fill: mainFill(c), source: 'outlined_paths' as const })),
    ];
    // Outlined clusters that cannot be lettering are dropped before the cap below, so a
    // busy illustration spends its 150 on shapes that might be text.
    const dropped = { speck: 0, sliver: 0, line: 0 };
    candidates = candidates.filter((c) => {
      const why = c.source === 'outlined_paths' ? notLettering(c.els, c.bbox) : null;
      if (why) dropped[why]++;
      return !why;
    });
    if (dropped.speck + dropped.sliver + dropped.line > 0) {
      console.log(`[text-detect] left out ${dropped.speck} speck(s), ${dropped.sliver} sliver(s) and ${dropped.line} drawn line(s) that cannot be lettering`);
    }
    // Still more than one call can carry (a busy illustration whose clusters are real
    // pairs): keep the likeliest text — live <text>, then the clusters with the most
    // glyphs — rather than have the route refuse the lot. Reading order is kept.
    if (candidates.length > MAX_REGIONS) {
      console.warn(`[text-detect] ${candidates.length} candidate regions; sending the ${MAX_REGIONS} likeliest to be text`);
      const keep = new Set(
        candidates.map((c, i) => ({ i, live: c.source === 'live_text', n: c.els.length }))
          .sort((a, b) => Number(b.live) - Number(a.live) || b.n - a.n || a.i - b.i)
          .slice(0, MAX_REGIONS).map((c) => c.i),
      );
      candidates = candidates.filter((_, i) => keep.has(i));
    }
    const regions: Region[] = candidates.map((r, i) => ({ ...r, region: i + 1 }));
    if (!regions.length) return { regions: [], fonts: [], stats: null };

    const images = await renderPngs(svg, regions);
    const brief = regions.map((r) => ({
      region: r.region, source: r.source, fill: r.fill, glyph_paths: r.els.length,
      subpaths: r.els.reduce((n, e) => n + e.subpaths, 0),
      ...(r.svgText ? { svg_text: r.svgText } : {}),
    }));

    const startedAt = performance.now();
    const resp = await fetch(PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: opts.model, effort: opts.effort, clean: images.clean, annotated: images.annotated, regions: brief,
        font_suggestions: opts.fontSuggestions,
      }),
    });
    if (!resp.ok) throw new Error(`Text detection failed: ${resp.status} ${await resp.text()}`);
    const answer = await resp.json() as {
      regions?: Array<{ region: number } & Record<string, unknown>>; fonts?: string[]; error?: { message?: string };
      lines?: Array<{ regions?: unknown; text_content?: unknown }>;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number; load_ms?: number; read_ms?: number; write_ms?: number } | null;
    };
    const seconds = (performance.now() - startedAt) / 1000;
    // The local model's answer is streamed behind a keep-alive, so its status is sent
    // before the outcome is known and a failure arrives as a 200 with an `error` body.
    if (answer.error || !Array.isArray(answer.regions)) {
      throw new Error(`Text detection failed: ${answer.error?.message ?? 'no regions in the answer'}`);
    }
    const { regions: judged, fonts } = answer;

    // Render px → the SVG's own user units, which is what the reference reports.
    const vb = svg.viewBox.baseVal;
    const k = vb && vb.width ? vb.width / RENDER_W : 1;
    const ox = vb?.x ?? 0, oy = vb?.y ?? 0;
    const toUser = (b: BBox) => [b[0] * k + ox, b[1] * k + oy, b[2] * k + ox, b[3] * k + oy].map((v) => +v.toFixed(1));

    // Merge: exact facts from the DOM + the model's reading/style
    const byNum = Object.fromEntries(judged.map((j) => [j.region, j]));
    const merged = regions.map((r) => {
      const { region: _region, words: modelWords, ...m } = byNum[r.region] ?? ({} as Record<string, unknown>);
      // Non-text regions come back in a short form (see the route's prompt); the fields
      // it leaves out are the same for all of them, so they are filled in here.
      if (m.is_text === false) Object.assign(m, { text_content: '', role: 'decorative', replaceable: false, ...m });
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
    const usage = answer.usage ?? null;
    const stats: TextDetectStats = {
      model: answer.model ?? opts.model ?? '',
      seconds,
      regions: regions.length,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      phases: usage && typeof usage.write_ms === 'number'
        ? { load: (usage.load_ms ?? 0) / 1000, read: (usage.read_ms ?? 0) / 1000, write: usage.write_ms / 1000 }
        : null,
    };
    const shapesOf = new Map(regions.map((r) => [r.region, r.els.map((e) => e.bbox)]));
    // The lines the model reported first, then any it read letter by letter and left out.
    const reported = joinLines(merged, answer.lines, shapesOf);
    const joined = joinLines(reported, unreportedLines(reported), shapesOf);
    return { regions: joined, fonts: Array.isArray(fonts) ? fonts : [], stats };
  } finally {
    host.remove();
  }
}
