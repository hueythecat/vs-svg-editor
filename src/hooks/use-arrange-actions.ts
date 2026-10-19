// The toolbar's arrange actions: centre on the canvas, even out gaps, match rotation and
// rotate 90°. Each is the same shape — measure the live artwork, write a transform onto
// the parsed document, snapshot for undo, store the result — and none of them touches
// anything else in the editor, which is why they live together and apart from it.
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useLayoutEffect, useState } from 'react';

import {
  type ActiveSvg, type SvgLayer, applyTranslateDelta, bboxInRootSpace, unionBoxInRootSpace,
} from '@/lib/svg-utils';

type Options = {
  activeSvg: ActiveSvg | null;
  setActiveSvg: Dispatch<SetStateAction<ActiveSvg | null>>;
  svgCanvasRef: RefObject<HTMLDivElement | null>;
  // Every layer the selection overlay frames; the locked background is already excluded.
  selectionIds: string[];
  selectedLayers: Set<string>;
  backgroundLayerId: string | null;
  snapshotForUndo: (content: string, layers: SvgLayer[]) => void;
};

export function useArrangeActions({
  activeSvg, setActiveSvg, svgCanvasRef, selectionIds, selectedLayers, backgroundLayerId, snapshotForUndo,
}: Options) {
  // ── Center to canvas horizontal midpoint ─────────────────────────────────

  const centerLayersToCanvas = useCallback(() => {
    if (!activeSvg) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;
    const screenCTM = svgEl.getScreenCTM();
    if (!screenCTM) return;
    const inv = screenCTM.inverse();

    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const vb = (doc.documentElement.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
    if (vb.length < 4) return;
    const canvasCenterX = vb[0] + vb[2] / 2;

    // Which layers move, and by how far.
    const shifts: { id: string; dx: number }[] = [];
    if (selectionIds.length > 0) {
      // With a selection, Center acts on it and nothing else. Several layers move as
      // one block: the union box's midpoint goes to the canvas midpoint and every
      // selected layer shifts by that SAME delta, so the spacing between them survives
      // — centring each one individually would stack them all on the midline. For a
      // single layer the union is just its own box, so it centres itself.
      const box = unionBoxInRootSpace(svgEl, selectionIds);
      if (!box) return;
      const dx = canvasCenterX - (box.x + box.width / 2);
      selectionIds.forEach((id) => shifts.push({ id, dx }));
    } else {
      // Nothing selected: every layer is centred on its own.
      activeSvg.layers.forEach(({ id }) => {
        if (id === backgroundLayerId) return;
        const liveEl = svgEl.getElementById(id);
        if (!liveEl) return;
        const r = liveEl.getBoundingClientRect();
        const pt = svgEl.createSVGPoint();
        pt.x = r.left + r.width / 2;
        pt.y = r.top + r.height / 2;
        const center = pt.matrixTransform(inv);
        shifts.push({ id, dx: canvasCenterX - center.x });
      });
    }

    let changed = false;
    shifts.forEach(({ id, dx }) => {
      if (Math.abs(dx) < 0.5) return;
      const docEl = doc.getElementById(id);
      if (!docEl) return;
      const existing = docEl.getAttribute('transform') ?? '';
      docEl.setAttribute('transform', `translate(${dx.toFixed(2)},0) ${existing}`.trim());
      changed = true;
    });

    if (!changed) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content } : null));
  }, [activeSvg, selectionIds, backgroundLayerId, snapshotForUndo]);

  // ── Tidy: even out the gaps across the selection, down or across ─────────

  const tidySelectionAlong = useCallback((axis: 'x' | 'y') => {
    if (!activeSvg || selectionIds.length < 3) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;

    // Position and extent along the axis being tidied.
    const at = (b: DOMRect) => (axis === 'y' ? b.y : b.x);
    const extent = (b: DOMRect) => (axis === 'y' ? b.height : b.width);

    // Each selected layer's own box, in order along the axis.
    const items = selectionIds
      .map((id) => ({ id, box: unionBoxInRootSpace(svgEl, [id]) }))
      .filter((it): it is { id: string; box: DOMRect } => !!it.box)
      .sort((a, b) => at(a.box) - at(b.box));
    if (items.length < 3) return;

    // Distribute SPACING, not centres. Equalising the distance between centres is the
    // other thing this button could mean and it is the wrong one for type: rows of
    // different cap heights (or words of different lengths, across) end up with visibly
    // uneven whitespace between them even though their centres are evenly spread. What
    // reads as tidy is equal GAPS.
    //
    // The outermost two stay put — they are what the run is measured between, and moving
    // them would drift the whole block across the canvas.
    const first = items[0];
    const last = items[items.length - 1];
    const span = (at(last.box) + extent(last.box)) - at(first.box);
    const inked = items.reduce((sum, it) => sum + extent(it.box), 0);
    const gap = (span - inked) / (items.length - 1);

    // A negative gap means the selection overlaps along the axis: the layers are bigger,
    // added up, than the run they sit in, so there is no spacing to even out and the
    // arithmetic answers with overlap instead. Acting on that shuffles artwork into a
    // worse position than it started in — three full-height groups produced a -50 gap and
    // moved a heading below its contact block. Evening out gaps that do not exist is not a
    // thing the button can do, so it declines rather than inventing an answer.
    if (gap < 0) {
      if (__DEV__) console.log(
        `[tidy ${axis}] declined — the ${items.length} selected layer(s) overlap ` +
        `(${inked.toFixed(0)} of ink in a ${span.toFixed(0)} run), so there are no gaps to even`,
      );
      return;
    }

    const shifts: { id: string; delta: number }[] = [];
    let cursor = at(first.box) + extent(first.box) + gap;
    for (let i = 1; i < items.length - 1; i++) {
      shifts.push({ id: items[i].id, delta: cursor - at(items[i].box) });
      cursor += extent(items[i].box) + gap;
    }
    if (shifts.every(({ delta }) => Math.abs(delta) < 0.5)) return;

    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    let changed = false;
    shifts.forEach(({ id, delta }) => {
      if (Math.abs(delta) < 0.5) return;
      const docEl = doc.getElementById(id);
      if (!docEl) return;
      const existing = docEl.getAttribute('transform') ?? '';
      const move = axis === 'y' ? `translate(0,${delta.toFixed(2)})` : `translate(${delta.toFixed(2)},0)`;
      docEl.setAttribute('transform', `${move} ${existing}`.trim());
      changed = true;
    });
    if (!changed) return;

    if (__DEV__) console.log(`[tidy ${axis}] evened ${items.length} layer(s) to a ${gap.toFixed(1)} gap`);
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content } : null));
  }, [activeSvg, selectionIds, snapshotForUndo]);

  const tidySelection = useCallback(() => tidySelectionAlong('y'), [tidySelectionAlong]);
  const tidySelectionHorizontal = useCallback(() => tidySelectionAlong('x'), [tidySelectionAlong]);

  // ── Match every layer's rotation to the selected layer ────────────────────
  // Reads the selected layer's rotation (relative to the SVG root) and rotates
  // each other non-background layer about its own centre so its final rotation
  // matches. Requires exactly one selected layer as the reference.

  const matchRotationToSelected = useCallback(() => {
    if (!activeSvg || selectedLayers.size !== 1) return;
    const selId = [...selectedLayers][0];
    if (selId === backgroundLayerId) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;
    const rootCtm = svgEl.getScreenCTM();
    const selEl = svgEl.getElementById(selId) as SVGGraphicsElement | null;
    const selCtm = selEl?.getScreenCTM();
    if (!rootCtm || !selEl || !selCtm) return;

    // Rotation of an element relative to root = angle of (root⁻¹ · elementCTM).
    const rootInv = rootCtm.inverse();
    const angleOf = (m: DOMMatrix) => Math.atan2(m.b, m.a) * 180 / Math.PI;
    const targetAngle = angleOf(rootInv.multiply(selCtm));

    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    let changed = false;
    activeSvg.layers.forEach(({ id }) => {
      if (id === backgroundLayerId || id === selId) return;
      const liveEl = svgEl.getElementById(id) as SVGGraphicsElement | null;
      const docEl = doc.getElementById(id);
      const ctm = liveEl?.getScreenCTM();
      if (!liveEl || !docEl || !ctm) return;
      const delta = targetAngle - angleOf(rootInv.multiply(ctm));
      if (Math.abs(delta) < 0.01) return;
      const box = bboxInRootSpace(svgEl, liveEl);
      if (!box) return;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const existing = docEl.getAttribute('transform') ?? '';
      docEl.setAttribute(
        'transform',
        `rotate(${delta.toFixed(2)}, ${cx.toFixed(2)}, ${cy.toFixed(2)}) ${existing}`.trim(),
      );
      changed = true;
    });

    if (!changed) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content } : null));
  }, [activeSvg, selectedLayers, backgroundLayerId, snapshotForUndo]);

  // ── Rotate the selection 90° (handoff §"Toolbar actions") ─────────────────
  // Quarter-turn about each selected layer's own centre. No-op for the background.

  const rotateSelected90 = useCallback(() => {
    if (!activeSvg || !selectedLayers.size) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;

    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    let changed = false;
    [...selectedLayers].forEach((id) => {
      if (id === backgroundLayerId) return;
      const liveEl = svgEl.getElementById(id) as SVGGraphicsElement | null;
      const docEl = doc.getElementById(id);
      if (!liveEl || !docEl) return;
      const box = bboxInRootSpace(svgEl, liveEl);
      if (!box) return;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const existing = docEl.getAttribute('transform') ?? '';
      docEl.setAttribute('transform', `rotate(90, ${cx.toFixed(2)}, ${cy.toFixed(2)}) ${existing}`.trim());
      changed = true;
    });

    if (!changed) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content } : null));
  }, [activeSvg, selectedLayers, backgroundLayerId, snapshotForUndo]);

  // ── Position (X / Y fields) ───────────────────────────────────────────────
  //
  // Where the selection sits: the top-left corner of its union box, in the artwork's own
  // units (the viewBox). Measured off the live canvas after every change to the document
  // or the selection, so the fields always read what is drawn — including after a drag,
  // which writes the document once on release.
  const [selectionPosition, setSelectionPosition] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
      const box = svgEl && selectionIds.length > 0 ? unionBoxInRootSpace(svgEl, selectionIds) : null;
      setSelectionPosition(box ? { x: box.x, y: box.y } : null);
    };
    measure();
    // A text field's box changes when its web font arrives, which is often after the
    // document change that selected it — measured then, the fields would read the
    // fallback face's box.
    document.fonts?.addEventListener('loadingdone', measure);
    return () => document.fonts?.removeEventListener('loadingdone', measure);
  }, [activeSvg?.content, selectionIds, svgCanvasRef]);

  // Moves the selection so its top-left corner lands on (x, y); an axis left undefined
  // stays put. Several layers move as one block, like Center, so their spacing survives.
  const moveSelectionTo = useCallback((target: { x?: number; y?: number }) => {
    if (!activeSvg || selectionIds.length === 0) return;
    const svgEl = svgCanvasRef.current?.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) return;
    const box = unionBoxInRootSpace(svgEl, selectionIds);
    if (!box) return;
    const dx = target.x === undefined ? 0 : target.x - box.x;
    const dy = target.y === undefined ? 0 : target.y - box.y;
    if (Math.abs(dx) < 0.005 && Math.abs(dy) < 0.005) return;

    const rootCTM = svgEl.getScreenCTM();
    if (!rootCTM) return;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    let changed = false;
    for (const id of selectionIds) {
      const liveEl = svgEl.getElementById(id) as SVGGraphicsElement | null;
      const docEl = doc.getElementById(id);
      if (!liveEl || !docEl) continue;
      // The translate goes on the layer's own transform, so it acts in its PARENT's
      // space. A layer opened out of a transformed group has a parent that is scaled or
      // rotated against the canvas, and the canvas-space shift has to be carried into it.
      const parent = liveEl.parentElement as unknown as SVGGraphicsElement | null;
      const parentCTM = parent && parent !== (svgEl as unknown) ? parent.getScreenCTM() : rootCTM;
      if (!parentCTM) continue;
      const m = rootCTM.inverse().multiply(parentCTM).inverse();
      const pdx = m.a * dx + m.c * dy;
      const pdy = m.b * dx + m.d * dy;
      docEl.setAttribute('transform', applyTranslateDelta(docEl.getAttribute('transform') ?? '', +pdx.toFixed(2), +pdy.toFixed(2)));
      changed = true;
    }
    if (!changed) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (prev ? { ...prev, content } : null));
  }, [activeSvg, selectionIds, snapshotForUndo]);

  return {
    centerLayersToCanvas, tidySelection, tidySelectionHorizontal, matchRotationToSelected, rotateSelected90,
    selectionPosition, moveSelectionTo,
  };
}
