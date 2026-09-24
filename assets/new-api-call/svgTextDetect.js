// svgTextDetect.js — browser-side preprocessing for the React SVG editor.
// The browser already renders SVG, so bboxes/transforms/CSS are resolved natively.
// Only the final API call goes through the backend proxy (keeps the API key off the client).
//
// Usage in a component:
//   const regions = await detectSvgText(svgString);   // [{ region, uuids, bbox, fill, text_content, ... }]

const RENDER_W = 1800;                  // px long-edge render
const PROXY_URL = "/api/svg-text";      // FastAPI endpoint on the Pi5
const SHAPES = "path,rect,circle,ellipse,polygon,polyline,text";

// ---------- 1. Mount the SVG off-screen at a fixed pixel width ----------
function mountSvg(svgString) {
  const host = document.createElement("div");
  host.style.cssText = `position:absolute;left:-100000px;top:0;visibility:hidden;width:${RENDER_W}px`;
  host.innerHTML = svgString;
  document.body.appendChild(host);
  const svg = host.querySelector("svg");
  const vb = svg.viewBox.baseVal;
  const aspect = vb && vb.width ? vb.height / vb.width : svg.getBBox().height / svg.getBBox().width;
  svg.setAttribute("width", RENDER_W);
  svg.setAttribute("height", Math.round(RENDER_W * aspect));
  return { host, svg };
}

// Nearest usable id: the element's own, else nearest ancestor below the root <svg>
function uuidFor(el, root) {
  for (let n = el; n && n !== root; n = n.parentElement) if (n.id) return n.id;
  return null;
}

// ---------- 2. Collect elements with pixel bboxes + computed styles ----------
function collect(svg) {
  const origin = svg.getBoundingClientRect();
  const out = [];
  for (const el of svg.querySelectorAll(SHAPES)) {
    if (el.closest("defs,clipPath,mask,symbol")) continue;
    const id = uuidFor(el, svg);
    if (!id) continue;
    const r = el.getBoundingClientRect();              // includes all transforms
    if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el);                   // resolves classes / <style> rules
    out.push({
      id,
      kind: el.tagName.toLowerCase() === "text" ? "text" : "path",
      bbox: [r.left - origin.left, r.top - origin.top, r.right - origin.left, r.bottom - origin.top],
      fill: cs.fill, stroke: cs.stroke !== "none" ? cs.stroke : null,
      text: el.tagName.toLowerCase() === "text" ? el.textContent.trim() : undefined,
      fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontSize: cs.fontSize,
    });
  }
  return out;
}

// ---------- 3. Cluster outlined glyph paths into words/lines ----------
function clusterGlyphs(paths, canvasH, maxGlyphFrac = 0.25, gapFactor = 0.8) {
  const glyphs = paths
    .filter(p => { const h = p.bbox[3] - p.bbox[1]; return h > 0 && h < canvasH * maxGlyphFrac; })
    .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  const clusters = [];
  for (const g of glyphs) {
    const [x0, y0, x1, y1] = g.bbox, h = y1 - y0;
    const c = clusters.find(c => {
      const [cx0, cy0, cx1, cy1] = c.bbox, ch = cy1 - cy0;
      const vOverlap = Math.min(y1, cy1) - Math.max(y0, cy0);
      const hGap = Math.max(x0 - cx1, cx0 - x1, 0);
      return c.fill === g.fill && vOverlap > 0.5 * Math.min(h, ch) && hGap < gapFactor * Math.max(h, ch);
    });
    if (c) {
      if (!c.ids.includes(g.id)) c.ids.push(g.id);
      c.bbox = [Math.min(c.bbox[0], x0), Math.min(c.bbox[1], y0), Math.max(c.bbox[2], x1), Math.max(c.bbox[3], y1)];
      c.count++;
    } else clusters.push({ ids: [g.id], bbox: [x0, y0, x1, y1], fill: g.fill, count: 1 });
  }
  return clusters.filter(c => c.count >= 2);
}

// ---------- 4. Render clean + annotated PNGs ----------
async function renderPngs(svg, regions) {
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  const w = svg.width.baseVal.value, h = svg.height.baseVal.value;

  const draw = annotate => {
    const cv = Object.assign(document.createElement("canvas"), { width: w, height: h });
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    if (annotate) {
      const fs = Math.max(14, Math.round(w / 90));
      ctx.font = `bold ${fs}px sans-serif`; ctx.lineWidth = 3;
      for (const r of regions) {
        const [x0, y0, x1, y1] = r.bbox;
        ctx.strokeStyle = "#ff00b4"; ctx.strokeRect(x0 - 3, y0 - 3, x1 - x0 + 6, y1 - y0 + 6);
        const ty = Math.max(fs, y0 - 6);
        ctx.strokeStyle = "#fff"; ctx.strokeText(String(r.region), x0, ty);
        ctx.fillStyle = "#ff00b4"; ctx.fillText(String(r.region), x0, ty);
      }
    }
    return cv.toDataURL("image/png").split(",")[1];
  };
  const out = { clean: draw(false), annotated: draw(true) };
  URL.revokeObjectURL(url);
  return out;
}

// ---------- 5. Main ----------
export async function detectSvgText(svgString) {
  const { host, svg } = mountSvg(svgString);
  try {
    const els = collect(svg);
    const regions = [
      ...els.filter(e => e.kind === "text").map(e => ({
        ids: [e.id], bbox: e.bbox, fill: e.fill, source: "live_text", svgText: e.text,
        fontFamily: e.fontFamily, fontWeight: e.fontWeight, fontSize: e.fontSize,
      })),
      ...clusterGlyphs(els.filter(e => e.kind === "path"), svg.height.baseVal.value)
        .map(c => ({ ...c, source: "outlined_paths" })),
    ].map((r, i) => ({ ...r, region: i + 1 }));
    if (!regions.length) return [];

    const images = await renderPngs(svg, regions);
    const brief = regions.map(r => ({ region: r.region, source: r.source, fill: r.fill, ...(r.svgText ? { svg_text: r.svgText } : {}) }));

    const resp = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clean: images.clean, annotated: images.annotated, regions: brief }),
    });
    if (!resp.ok) throw new Error(`Text detection failed: ${resp.status} ${await resp.text()}`);
    const { regions: judged } = await resp.json();

    // Merge: exact facts from the DOM + the model's reading/style
    const byNum = Object.fromEntries(judged.map(j => [j.region, j]));
    return regions.map(r => {
      const { region, ...m } = byNum[r.region] || {};
      return {
        region: r.region, uuids: r.ids, bbox: r.bbox.map(v => +v.toFixed(1)), source: r.source,
        fill: r.fill, fontFamilyInFile: r.fontFamily, fontSizeInFile: r.fontSize, ...m,
      };
    });
  } finally {
    host.remove();
  }
}
