// The selected text layer: what the Text tab shows for it, and writing edits back.
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useMemo } from 'react';

import {
  type ActiveSvg, type SvgLayer, computeArcPath, measureTextAdvance, setTextLines, textLines,
} from '@/lib/svg-utils';

// The layers panel gives each row one line. A multi-line field's newlines would break
// that row, so the label is the flattened string — the artwork still stacks.
export const layerLabel = (content: string) => content.replace(/\s*\n\s*/g, ' ').trim();

type Options = {
  activeSvg: ActiveSvg | null;
  setActiveSvg: Dispatch<SetStateAction<ActiveSvg | null>>;
  selectedLayer: string | null;
  selectedLayers: Set<string>;
  textLayerIds: Set<string>;
  snapshotForUndo: (content: string, layers: SvgLayer[]) => void;
  // Whether this edit session has already taken its undo snapshot. Owned by the
  // component, which clears it when the selection or document changes.
  textEditSnappedRef: RefObject<boolean>;
};

export function useTextLayer({
  activeSvg, setActiveSvg, selectedLayer, selectedLayers, textLayerIds, snapshotForUndo, textEditSnappedRef,
}: Options) {
  const selectedTextProps = useMemo(() => {
    if (!activeSvg) return null;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');

    if (!selectedLayer) return null;
    const el = doc.getElementById(selectedLayer);
    if (!el) return null;
    const isGroup = el.getAttribute('data-text-layer') === '1';
    const textEl = isGroup
      ? el.querySelector('text')
      : el.tagName.toLowerCase() === 'text' ? el : null;
    if (!textEl) return null;
    const textPathEl = textEl.querySelector('textPath');
    return {
      content: textPathEl ? (textPathEl.textContent ?? '') : textLines(textEl),
      font:    textEl.getAttribute('font-family') ?? 'Arial',
      size:    Number(textEl.getAttribute('font-size') ?? 48),
      weight:  Number(textEl.getAttribute('font-weight') ?? 400),
      color:         textEl.getAttribute('fill') ?? '#000000',
      curve:         isGroup ? Number(el.getAttribute('data-curve') ?? 0) : null as number | null,
      letterSpacing: parseFloat((textEl.getAttribute('letter-spacing') ?? '0').replace('em', '')) || 0,
    };
  }, [selectedLayer, activeSvg?.content]);

  // An empty text layer renders no geometry, so clicks inside its placeholder
  // selection box fall through to the background. Flag it so the overlay can
  // capture those clicks and keep the empty text layer selected instead.
  const selectionIsEmptyText = !!selectedTextProps && selectedTextProps.content.trim() === '';

  const updateTextLayer = useCallback((attrs: Partial<{ content: string; font: string; size: number; weight: number; color: string; curve: number; letterSpacing: number }>) => {
    if (!activeSvg) return;
    if (!textEditSnappedRef.current) {
      snapshotForUndo(activeSvg.content, activeSvg.layers);
      textEditSnappedRef.current = true;
    }
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');

    if (!selectedLayer) return;
    const el = doc.getElementById(selectedLayer);
    if (!el) return;
    const isGroup = el.getAttribute('data-text-layer') === '1';
    let textEl: Element | null = isGroup ? el.querySelector('text') : el;
    if (!textEl) return;

    // For non-group text elements that need a curve, promote to group first
    if (attrs.curve !== undefined && !isGroup && el.tagName.toLowerCase() === 'text' && attrs.curve !== 0) {
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const svgEl = doc.documentElement;
      const vb = svgEl.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      const vbW = vb && vb.length === 4 ? vb[2] : Number(svgEl.getAttribute('width') || 400);
      const cx = Number(el.getAttribute('x') ?? 0);
      const cy = Number(el.getAttribute('y') ?? 0);
      const halfW = vbW * 0.35;
      const gId = el.id;
      el.removeAttribute('id');
      const g = doc.createElementNS(SVG_NS, 'g');
      g.id = gId;
      g.setAttribute('data-name', el.textContent ?? '');
      g.setAttribute('data-text-layer', '1');
      g.setAttribute('data-curve', String(attrs.curve));
      g.setAttribute('data-cx', String(cx));
      g.setAttribute('data-cy', String(cy));
      g.setAttribute('data-halfw', String(halfW));
      g.setAttribute('data-fontsize', el.getAttribute('font-size') ?? '48');
      const arcId = `_arc_${gId}`;
      const defsEl2 = doc.createElementNS(SVG_NS, 'defs');
      const arcEl = doc.createElementNS(SVG_NS, 'path');
      arcEl.id = arcId;
      defsEl2.appendChild(arcEl);
      g.appendChild(defsEl2);
      const newText = doc.createElementNS(SVG_NS, 'text');
      ['font-family','font-size','font-weight','fill','letter-spacing'].forEach((a) => { const v = el.getAttribute(a); if (v) newText.setAttribute(a, v); });
      newText.setAttribute('dominant-baseline', 'middle');
      const tp = doc.createElementNS(SVG_NS, 'textPath');
      tp.setAttribute('href', `#${arcId}`); tp.setAttribute('startOffset', '50%'); tp.setAttribute('text-anchor', 'middle');
      tp.textContent = el.textContent ?? '';
      newText.appendChild(tp); g.appendChild(newText);
      el.parentNode?.replaceChild(g, el);
      // Written only now the group is in the document: measuring the string needs it
      // mounted, and this branch returns before the re-arc step at the end of the function.
      arcEl.setAttribute(
        'd',
        computeArcPath(cx, cy, attrs.curve, measureTextAdvance(doc.documentElement, gId), halfW),
      );
      const content = new XMLSerializer().serializeToString(doc.documentElement);
      setActiveSvg((prev) => prev ? { ...prev, content } : null);
      return;
    }

    if (attrs.curve !== undefined && isGroup) {
      const currentCurve = Number(el.getAttribute('data-curve') ?? 0);
      const newCurve = attrs.curve;
      el.setAttribute('data-curve', String(newCurve));
      const cx = Number(el.getAttribute('data-cx') ?? 0);
      const cy = Number(el.getAttribute('data-cy') ?? 0);
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const COPY_ATTRS = ['font-family', 'font-size', 'font-weight', 'fill', 'letter-spacing'];

      if (currentCurve === 0 && newCurve !== 0) {
        // A path is one baseline, so a multi-line field collapses to a single line when
        // it goes on the curve. Joining with spaces rather than letting the newlines
        // through keeps the words apart — SVG would render them run together.
        const content = textLines(textEl).replace(/\s*\n\s*/g, ' ');
        el.removeChild(textEl);
        const arcId = `_arc_${el.id}`;
        const defsEl = doc.createElementNS(SVG_NS, 'defs');
        const arcEl = doc.createElementNS(SVG_NS, 'path');
        arcEl.id = arcId;
        // `d` is left for the re-arc step at the end of this function, which measures the
        // text once it is in place — the arc's size follows the string it carries.
        defsEl.appendChild(arcEl);
        el.appendChild(defsEl);
        const newText = doc.createElementNS(SVG_NS, 'text');
        COPY_ATTRS.forEach((a) => { const v = textEl!.getAttribute(a); if (v) newText.setAttribute(a, v); });
        newText.setAttribute('dominant-baseline', 'middle');
        const tp = doc.createElementNS(SVG_NS, 'textPath');
        tp.setAttribute('href', `#${arcId}`); tp.setAttribute('startOffset', '50%'); tp.setAttribute('text-anchor', 'middle');
        tp.textContent = content;
        newText.appendChild(tp); el.appendChild(newText);
        textEl = newText;
      } else if (currentCurve !== 0 && newCurve === 0) {
        const tp = textEl.querySelector('textPath');
        const content = tp?.textContent ?? textEl.textContent ?? '';
        // Remove arc — may be directly in group (legacy) or inside <defs>
        const arcEl = doc.getElementById(`_arc_${el.id}`) ?? el.querySelector('path');
        if (arcEl) {
          const arcParent = arcEl.parentNode;
          arcParent?.removeChild(arcEl);
          if (arcParent && arcParent.nodeName.toLowerCase() === 'defs' && !arcParent.firstChild) {
            arcParent.parentNode?.removeChild(arcParent);
          }
        }
        el.removeChild(textEl);
        const newText = doc.createElementNS(SVG_NS, 'text');
        newText.setAttribute('y', String(cy));
        newText.setAttribute('text-anchor', 'middle'); newText.setAttribute('dominant-baseline', 'middle');
        COPY_ATTRS.forEach((a) => { const v = textEl!.getAttribute(a); if (v) newText.setAttribute(a, v); });
        setTextLines(newText, content, cx);
        el.appendChild(newText);
        textEl = newText;
      }
      // No non-zero → non-zero case here: the arc's `d` is written once at the end of
      // this function, where the text it has to fit is in its final state.
    }

    if (attrs.content !== undefined) {
      const tp = textEl.querySelector('textPath');
      // Curved text has one baseline and cannot stack; flat text re-emits its lines,
      // keeping the x it already had so editing the string never moves the field.
      if (tp) tp.textContent = attrs.content.replace(/\s*\n\s*/g, ' ');
      else setTextLines(textEl, attrs.content, Number(textEl.getAttribute('x') ?? 0));
    }
    if (attrs.font   !== undefined) textEl.setAttribute('font-family', attrs.font);
    // A font pick applies to the whole selection, not just the row the inspector is
    // pointed at — with several text layers selected the dropdown reads as acting on all
    // of them. Only the font fans out; size/weight/colour/content stay single-layer.
    // Non-text layers in the selection are skipped so a shape never picks up font-family.
    if (attrs.font !== undefined && selectedLayers.size > 1) {
      for (const id of selectedLayers) {
        if (id === selectedLayer || !textLayerIds.has(id)) continue;
        const otherEl = doc.getElementById(id);
        if (!otherEl) continue;
        // Same resolution as the primary layer above, so both behave identically: the
        // inner <text> for a text group, otherwise the element itself (font-family
        // inherits to any text inside it).
        const otherText = otherEl.getAttribute('data-text-layer') === '1'
          ? otherEl.querySelector('text')
          : otherEl;
        if (otherText) otherText.setAttribute('font-family', attrs.font);
      }
    }
    if (attrs.size   !== undefined) textEl.setAttribute('font-size', String(attrs.size));
    if (attrs.weight !== undefined) textEl.setAttribute('font-weight', String(attrs.weight));
    if (attrs.color  !== undefined) textEl.setAttribute('fill', attrs.color);
    if (attrs.letterSpacing !== undefined) {
      if (attrs.letterSpacing === 0) textEl.removeAttribute('letter-spacing');
      else textEl.setAttribute('letter-spacing', `${attrs.letterSpacing}em`);
    }

    // Re-arc. The arc's placement depends on how much room the string takes along it, so
    // it has to be recomputed after every edit that changes that — not just the curve.
    // It runs here, once, rather than inside the curve branch above, because that branch
    // executes before content/font/size/letter-spacing are applied and would measure the
    // text as it was rather than as it now is.
    const curveNow = isGroup ? Number(el.getAttribute('data-curve') ?? 0) : 0;
    const reArc =
      attrs.curve !== undefined || attrs.content !== undefined || attrs.font !== undefined ||
      attrs.size !== undefined || attrs.letterSpacing !== undefined;
    if (isGroup && curveNow !== 0 && reArc) {
      const arcEl = doc.getElementById(`_arc_${el.id}`) ?? el.querySelector('path');
      if (arcEl) {
        arcEl.setAttribute('d', computeArcPath(
          Number(el.getAttribute('data-cx') ?? 0),
          Number(el.getAttribute('data-cy') ?? 0),
          curveNow,
          measureTextAdvance(doc.documentElement, el.id),
          Number(el.getAttribute('data-halfw') ?? 100),
        ));
      }
    }

    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => {
      if (!prev) return null;
      const layers = attrs.content !== undefined
        ? prev.layers.map((l) => l.id === selectedLayer ? { ...l, label: layerLabel(attrs.content!) || l.label } : l)
        : prev.layers;
      return { ...prev, content, layers };
    });
  }, [selectedLayer, selectedLayers, textLayerIds, activeSvg, snapshotForUndo]);

  const selectionIsText = !!selectedTextProps;

  return { selectedTextProps, selectionIsText, selectionIsEmptyText, updateTextLayer };
}
