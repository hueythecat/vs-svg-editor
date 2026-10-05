// Drag-to-reorder in the layer list: moving a layer's element in the document so the
// stacking order on the canvas follows the order of the rows.
import { type Dispatch, type SetStateAction, useCallback } from 'react';

import { type ActiveSvg, type SvgLayer } from '@/lib/svg-utils';

type Options = {
  activeSvg: ActiveSvg | null;
  setActiveSvg: Dispatch<SetStateAction<ActiveSvg | null>>;
  snapshotForUndo: (content: string, layers: SvgLayer[]) => void;
};

export function useLayerReorder({ activeSvg, setActiveSvg, snapshotForUndo }: Options) {
  const reorderLayers = useCallback((fromId: string, toId: string, panelBefore: boolean) => {
    if (!activeSvg || fromId === toId) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);

    // Work in panel order (reversed document order: panel[0] = topmost layer)
    const panelLayers = [...activeSvg.layers].reverse();
    const fromPanelIdx = panelLayers.findIndex((l) => l.id === fromId);
    const toPanelIdx   = panelLayers.findIndex((l) => l.id === toId);
    if (fromPanelIdx === -1 || toPanelIdx === -1) return;

    let insertPanelIdx = panelBefore ? toPanelIdx : toPanelIdx + 1;
    const newPanel = [...panelLayers];
    const [moved] = newPanel.splice(fromPanelIdx, 1);
    if (fromPanelIdx < insertPanelIdx) insertPanelIdx--;
    newPanel.splice(insertPanelIdx, 0, moved);

    const newDocLayers = [...newPanel].reverse();

    // Reorder the SVG DOM by moving fromEl to its new document position
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const svg = doc.documentElement;
    const fromEl = doc.getElementById(fromId);
    if (!fromEl) return;

    const newFromDocIdx = newDocLayers.findIndex((l) => l.id === fromId);
    const nextDocId = newFromDocIdx < newDocLayers.length - 1 ? newDocLayers[newFromDocIdx + 1].id : null;
    const nextEl = nextDocId ? doc.getElementById(nextDocId) : null;

    // Layers are not always direct children of <svg>: a file that wraps its drawing in
    // one group has its layers taken from inside that wrapper. Move within the element's
    // own parent, so reordering can't hoist it out of a wrapper whose class or transform
    // it is being drawn under.
    const parent = fromEl.parentNode;
    if (!parent) return;
    if (nextEl && nextEl.parentNode === parent) {
      parent.insertBefore(fromEl, nextEl);
    } else if (!nextEl && parent === svg) {
      svg.appendChild(fromEl);
    } else if (!nextEl) {
      parent.appendChild(fromEl);
    } else {
      // Different parents — there is no single position that means "between these two",
      // so the drop is ignored rather than moved somewhere arbitrary.
      console.log('[layers] reorder across different parents ignored');
      return;
    }

    const content = new XMLSerializer().serializeToString(svg);
    setActiveSvg((prev) => (prev ? { ...prev, content, layers: newDocLayers } : null));
  }, [activeSvg, snapshotForUndo]);

  return reorderLayers;
}
