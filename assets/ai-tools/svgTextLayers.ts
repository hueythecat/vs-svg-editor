// svgTextLayers.ts — work with the editableSvg returned by the svg-text service.
// All functions take the live <svg> element in the editor's canvas (web / DOM).
//
// Structure of editableSvg, per detected item tN:
//   <g data-detected-id="tN" data-detected-text="IMPERIAL" display="none"> original outline paths </g>
//      (one or more of these, left exactly where the outlines were in the layer tree)
//   <g id="editable-text">                                    <- added at the end of the root <svg>
//     <g id="editable-tN" data-source="tN" data-font-suggestion="Cinzel 600">
//       <text …>IMPERIAL</text>                               (lines)
//       <text …><textPath href="#arc-tN">IMPERIAL</textPath></text>   (arcs; path in <defs>)
//     </g>
//   </g>

const SVG_NS = "http://www.w3.org/2000/svg";

function editableGroup(svg: SVGSVGElement, id: string) {
  return svg.querySelector<SVGGElement>(`#editable-${CSS.escape(id)}`);
}
function textNode(svg: SVGSVGElement, id: string) {
  const g = editableGroup(svg, id);
  // arcs keep their characters inside <textPath>; writing to <text> would drop the curve
  return (g?.querySelector("textPath") ?? g?.querySelector("text")) as SVGTextContentElement | null;
}
function textElement(svg: SVGSVGElement, id: string) {
  return editableGroup(svg, id)?.querySelector("text") as SVGTextElement | null;
}

/** Change the words. Drops the fitted length so new text isn't squashed/stretched to the old width. */
export function setItemText(svg: SVGSVGElement, id: string, text: string) {
  const node = textNode(svg, id);
  if (!node) return;
  node.textContent = text;
  node.removeAttribute("textLength");
  node.removeAttribute("lengthAdjust");
  textElement(svg, id)?.removeAttribute("textLength");
  textElement(svg, id)?.removeAttribute("lengthAdjust");
}

/** Change font family / weight (loads the Google Font if needed). */
export function setItemFont(svg: SVGSVGElement, id: string, family: string, weight = 400, fallback = "sans-serif") {
  ensureGoogleFont(family, weight);
  const t = textElement(svg, id);
  if (!t) return;
  t.setAttribute("font-family", `'${family}', ${fallback}`);
  if (weight === 400) t.removeAttribute("font-weight");
  else t.setAttribute("font-weight", String(weight));
}

export function setItemFill(svg: SVGSVGElement, id: string, fill: string) {
  textElement(svg, id)?.setAttribute("fill", fill);
}

/** Show the original outlines instead of (or as well as) the editable text — compare / revert. */
export function showOriginal(svg: SVGSVGElement, id: string, original: boolean) {
  svg.querySelectorAll<SVGGElement>(`[data-detected-id="${CSS.escape(id)}"]`)
    .forEach(g => original ? g.removeAttribute("display") : g.setAttribute("display", "none"));
  const e = editableGroup(svg, id);
  if (e) original ? e.setAttribute("display", "none") : e.removeAttribute("display");
}

/** Reject a detection (wasn't really text): restore the outlines, remove the editable copy. */
export function rejectItem(svg: SVGSVGElement, id: string) {
  showOriginal(svg, id, true);
  editableGroup(svg, id)?.remove();
  svg.querySelector(`#arc-${CSS.escape(id)}`)?.remove();
}

/** Serialize the canvas back to an SVG string for saving. */
export function serializeSvg(svg: SVGSVGElement, { dropHiddenOriginals = false } = {}) {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  if (dropHiddenOriginals) {
    copy.querySelectorAll('[data-detected-id][display="none"]').forEach(n => n.remove());
  }
  return new XMLSerializer().serializeToString(copy);
}

const loaded = new Set<string>();
/** Load a Google Font into the page so the canvas renders it (the SVG's own @import covers the
 *  fonts chosen by the service; this covers fonts the user switches to). */
export function ensureGoogleFont(family: string, weight = 400) {
  const key = `${family}:${weight}`;
  if (loaded.has(key) || typeof document === "undefined") return;
  loaded.add(key);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@${weight}&display=swap`;
  document.head.appendChild(link);
}

/** "Lora 600" -> { family: "Lora", weight: 600 } (for the alternatives list). */
export function parseFontChoice(s: string) {
  const m = s.match(/^(.*?)\s+(\d{3})$/);
  return m ? { family: m[1], weight: Number(m[2]) } : { family: s, weight: 400 };
}
