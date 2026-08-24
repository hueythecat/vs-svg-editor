import React, { Dispatch, SetStateAction, useRef, useState } from 'react';

import type { SvgLayer } from '@/lib/svg-utils';
import { C, FONT_STACK, MONO_STACK } from '@/lib/design-tokens';
import { useT } from '@/i18n/provider';
import {
  ChevronIcon,
  DuplicateIcon, EyeIcon, EyeSlashIcon, GripIcon, ImageIcon, ShapeIcon, TrashIcon, TypeIcon,
} from './svg-icons';

// The scrollable, drag-to-reorder element list (handoff §1.7). Rows are top = front,
// so the document array is reversed for display. All the drag machinery — refs plus
// transient drag state — is panel-local and lives here; the parent only supplies data
// and callbacks.

const ICON_FOR = {
  text: TypeIcon,
  bg: ImageIcon,
  art: ShapeIcon,
} as const;

export const LayerList = React.memo(function LayerList({
  layers, hiddenLayers, selectedLayers, backgroundLayerId, textLayerIds,
  expandableLayerIds, hiddenInsideCounts, marks,
  onReorderLayers, onSetSelectedLayers, onSetSelectedLayer, onSelectOne,
  onToggleLayer, onDuplicateLayer, onDeleteLayer, onExpandLayer,
}: {
  layers: SvgLayer[];
  hiddenLayers: Set<string>;
  selectedLayers: Set<string>;
  backgroundLayerId: string | null;
  textLayerIds: Set<string>;
  expandableLayerIds: Set<string>;
  // Per layer: how many outermost pieces of artwork an AI pass hid INSIDE it. Nested
  // hidden elements are not rows of their own, so without this the row gives no sign.
  hiddenInsideCounts: Map<string, number>;
  // How each row relates to the group the list is drilled into: `inside` for the rows that
  // came out of it, `outer` for the level above it, absent for rows the breadcrumb has
  // nothing to say about. Empty at the top level, where every row is equally "here".
  marks: ReadonlyMap<string, 'inside' | 'outer'>;
  onReorderLayers: (fromId: string, toId: string, before: boolean) => void;
  onSetSelectedLayers: Dispatch<SetStateAction<Set<string>>>;
  onSetSelectedLayer: Dispatch<SetStateAction<string | null>>;
  onSelectOne: (id: string | null) => void;
  onToggleLayer: (id: string) => void;
  onDuplicateLayer: (id: string) => void;
  onDeleteLayer: (id: string) => void;
  onExpandLayer: (id: string) => void;
}) {
  const t = useT();
  const [dragLayerId, setDragLayerId]   = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<{ targetId: string; before: boolean } | null>(null);

  const layerListRef         = useRef<HTMLDivElement>(null);
  const panelDragIdRef       = useRef<string | null>(null);
  const panelDropPositionRef = useRef<{ targetId: string; before: boolean } | null>(null);
  const panelReorderDoneRef  = useRef(false);
  // A press anywhere on a row that hasn't moved far enough to be a drag yet. Dragging
  // used to start only from the grip, so a press that missed it did nothing and the
  // browser took the gesture instead — which is what dragged the page around. Any part
  // of the row can start a drag now, once the pointer has moved enough that it clearly
  // isn't a click.
  const pendingDragRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 3;

  // Range-select anchor: the last row picked *without* shift. Shift-click selects
  // everything between it and the clicked row, and the anchor deliberately stays put so
  // a second shift-click grows or shrinks the same range rather than starting a new one.
  const anchorIdRef = useRef<string | null>(null);

  // Every id from the anchor to the clicked row inclusive. Indices are taken in document
  // order; the list renders reversed, but a contiguous span is the same set either way.
  const selectRange = (toId: string) => {
    // The stored anchor is only good while it's still part of the selection — it goes
    // stale when the layer is deleted, or when the selection was replaced from the canvas
    // instead of this list. A lone selected row is an unambiguous anchor to fall back to.
    const anchorId =
      anchorIdRef.current && selectedLayers.has(anchorIdRef.current)
        ? anchorIdRef.current
        : selectedLayers.size === 1
          ? [...selectedLayers][0]
          : null;
    const from = anchorId === null ? -1 : layers.findIndex((l) => l.id === anchorId);
    const to = layers.findIndex((l) => l.id === toId);
    // No usable anchor (first click of the session, or it was since deleted) — a shift
    // click has nothing to extend from, so it behaves as a plain one.
    if (from === -1 || to === -1) {
      anchorIdRef.current = toId;
      onSelectOne(toId);
      return;
    }
    const [lo, hi] = from < to ? [from, to] : [to, from];
    onSetSelectedLayers(new Set(layers.slice(lo, hi + 1).map((l) => l.id)));
    // The clicked row is the one the inspector follows, not the anchor.
    onSetSelectedLayer(toId);
  };

  // Which row a drag is over, resolved from row geometry rather than
  // document.elementFromPoint. Hit testing only reported a target when the pointer was
  // exactly over a row, so a release in the 2px gap between rows, on the panel padding,
  // or past either end of the list silently did nothing — which is what made dropping
  // onto the top row unreliable. Falling back to the nearest row makes "drag it above
  // everything" work by dragging past the top.
  const resolveDrop = (clientY: number): { targetId: string; before: boolean } | null => {
    const container = layerListRef.current;
    const dragId = panelDragIdRef.current;
    if (!container || !dragId) return null;

    let best: { id: string; rect: DOMRect; distance: number } | null = null;
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('[data-layer-id]'))) {
      const rect = el.getBoundingClientRect();
      const distance =
        clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
      if (!best || distance < best.distance) best = { id: el.dataset.layerId!, rect, distance };
      if (distance === 0) break;
    }

    if (!best || best.id === dragId) return null;
    return { targetId: best.id, before: clientY < best.rect.top + best.rect.height / 2 };
  };

  // 12px action icon — eye / duplicate / delete. Stops propagation so it doesn't
  // also select the row.
  const action = (
    onClick: () => void,
    title: string,
    color: string,
    node: React.ReactNode,
  ) => (
    <button
      type="button"
      title={title}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
        color, display: 'flex', flex: 'none',
      }}
    >
      {node}
    </button>
  );

  return (
    <div
      ref={layerListRef}
      className="ed-scroll"
      style={{
        // Takes whatever height the panel has; the panel itself is what's bounded, so
        // the list only scrolls once it genuinely reaches the top of the viewport.
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '0 8px 8px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        fontFamily: FONT_STACK,
        // The list handles its own pointer gestures; without this the browser can pan or
        // scroll on the same drag and fight the reorder.
        touchAction: 'none',
      }}
      onPointerMove={(e) => {
        // Promote a held row into a drag once it has moved past the threshold.
        if (!panelDragIdRef.current && pendingDragRef.current) {
          const held = pendingDragRef.current;
          if (Math.abs(e.clientX - held.x) < DRAG_THRESHOLD &&
              Math.abs(e.clientY - held.y) < DRAG_THRESHOLD) return;
          layerListRef.current?.setPointerCapture(e.pointerId);
          panelDragIdRef.current = held.id;
          pendingDragRef.current = null;
        }
        if (!panelDragIdRef.current) return;
        setDragLayerId(panelDragIdRef.current);

        // Auto-scroll when dragging at either edge, so a target row that's scrolled out
        // of the panel can still be reached mid-drag.
        const container = layerListRef.current;
        if (container && container.scrollHeight > container.clientHeight) {
          const box = container.getBoundingClientRect();
          const EDGE = 24;
          if (e.clientY < box.top + EDGE) container.scrollTop -= 8;
          else if (e.clientY > box.bottom - EDGE) container.scrollTop += 8;
        }

        const pos = resolveDrop(e.clientY);
        panelDropPositionRef.current = pos;
        setDropPosition(pos);
      }}
      onPointerUp={(e) => {
        // A gesture can arrive as one jump with no intermediate move, so a row still
        // held at release counts as a drag if it travelled far enough — otherwise it was
        // a click and the selection already made on pointerdown stands.
        const held = pendingDragRef.current;
        pendingDragRef.current = null;
        if (!panelDragIdRef.current && held) {
          if (Math.abs(e.clientX - held.x) < DRAG_THRESHOLD &&
              Math.abs(e.clientY - held.y) < DRAG_THRESHOLD) return;
          panelDragIdRef.current = held.id;
        }
        if (!panelDragIdRef.current) return;
        layerListRef.current?.releasePointerCapture(e.pointerId);
        // Resolve once more from the release point: the last pointermove can lag behind
        // where the pointer actually came up.
        const pos = resolveDrop(e.clientY) ?? panelDropPositionRef.current;
        if (pos) {
          onReorderLayers(panelDragIdRef.current, pos.targetId, pos.before);
          panelReorderDoneRef.current = true;
        }
        panelDragIdRef.current = null;
        panelDropPositionRef.current = null;
        setDragLayerId(null);
        setDropPosition(null);
      }}
      onPointerCancel={() => {
        panelDragIdRef.current = null;
        panelDropPositionRef.current = null;
        setDragLayerId(null);
        setDropPosition(null);
      }}
    >
      {layers.length === 0 ? (
        <p style={{ fontSize: 12, color: C.textFaint, padding: '12px 4px', textAlign: 'center', margin: 0 }}>
          {t('layers.empty')}
        </p>
      ) : (
        [...layers].reverse().map((layer) => {
          const hidden     = hiddenLayers.has(layer.id);
          const hiddenInsideCount = hiddenInsideCounts.get(layer.id) ?? 0;
          const isSelected = selectedLayers.has(layer.id);
          const isDragged  = dragLayerId === layer.id;
          const isCanvas   = layer.id === backgroundLayerId;
          const kind       = isCanvas ? 'bg' : textLayerIds.has(layer.id) ? 'text' : 'art';
          const Icon       = ICON_FOR[kind];
          const dropBefore = dropPosition?.targetId === layer.id && dropPosition.before;
          const dropAfter  = dropPosition?.targetId === layer.id && !dropPosition.before;
          // The eye acts on the whole selection when this row is part of one, so the
          // tooltip says how many rows are going with it rather than promising a
          // single-row change. Its icon still reflects THIS row — that row is the one
          // deciding the direction the rest are driven to.
          // Rows opened out of a group are stepped in behind a rail, and the rows of the
          // level above are receded rather than hidden: they are still perfectly usable,
          // just not what was drilled into. A selected row is never receded — the
          // selection has to stay legible wherever it sits.
          const inside   = marks.get(layer.id) === 'inside';
          const receded  = marks.get(layer.id) === 'outer' && !isSelected;
          const togglesWith = isSelected && selectedLayers.size > 1 ? selectedLayers.size : 1;
          const toggleTitle = t(hidden ? 'layers.show' : 'layers.hide', { count: togglesWith });
          return (
            <div
              key={layer.id}
              data-layer-id={layer.id}
              className={isSelected ? 'ed-row-selected' : 'ed-row'}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                // Stops the browser starting its own drag of the row/page before ours
                // begins — that native gesture is what dragged the screen about.
                e.preventDefault();
                pendingDragRef.current = { id: layer.id, x: e.clientX, y: e.clientY };
                if (e.shiftKey) {
                  selectRange(layer.id);
                } else if (e.metaKey || e.ctrlKey) {
                  // Toggle a single row in or out — what shift used to do, moved to the
                  // usual modifier now that shift extends a range.
                  onSetSelectedLayers((prev) => {
                    const next = new Set(prev);
                    if (next.has(layer.id)) next.delete(layer.id); else next.add(layer.id);
                    return next;
                  });
                  onSetSelectedLayer(layer.id);
                  anchorIdRef.current = layer.id;
                } else {
                  onSelectOne(layer.id);
                  anchorIdRef.current = layer.id;
                }
              }}
              onClick={() => {
                if (panelReorderDoneRef.current) panelReorderDoneRef.current = false;
              }}
              style={{
                position: 'relative',
                display: 'flex', alignItems: 'center', gap: 7,
                padding: '7px 8px', borderRadius: 8,
                marginLeft: inside ? 11 : 0,
                border: `1px solid ${isSelected ? C.accentTintBorder : 'transparent'}`,
                background: isSelected ? C.accentTint : 'transparent',
                opacity: isDragged ? 0.35 : receded ? 0.62 : 1,
                userSelect: 'none',
                cursor: 'default',
              }}
            >
              {/* Group rail. Drawn in the gutter the row's margin opens up, and overshooting
                  the 2px row gap at both ends so consecutive rows read as one line rather
                  than a dashed column. */}
              {inside && (
                <span style={{ position: 'absolute', top: -2, bottom: -2, left: -7, width: 2, borderRadius: 1, background: C.accentTintBorder, pointerEvents: 'none' }} />
              )}
              {dropBefore && (
                <span style={{ position: 'absolute', top: -1, left: 4, right: 4, height: 2, borderRadius: 1, background: C.accent, pointerEvents: 'none' }} />
              )}
              {dropAfter && (
                <span style={{ position: 'absolute', bottom: -1, left: 4, right: 4, height: 2, borderRadius: 1, background: C.accent, pointerEvents: 'none' }} />
              )}

              {/* Open into parts. Only on rows that hold more than one, and it keeps the
                  fixed width either way so names stay aligned down the list. */}
              {expandableLayerIds.has(layer.id) ? (
                <button
                  type="button"
                  className="ed-ghost"
                  title={t('layers.expand')}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onExpandLayer(layer.id); }}
                  style={{
                    border: 'none', background: 'transparent', color: C.textFaint,
                    padding: 0, cursor: 'pointer', display: 'flex', flex: 'none',
                    width: 11, justifyContent: 'center', borderRadius: 4,
                  }}
                >
                  <ChevronIcon size={10} direction="right" />
                </button>
              ) : (
                <span style={{ width: 11, flex: 'none' }} />
              )}

              {/* Drag grip */}
              <span
                title={t('layers.drag')}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  e.preventDefault();
                  pendingDragRef.current = null;   // the grip drags at once, no threshold
                  onSelectOne(layer.id);
                  anchorIdRef.current = layer.id;
                  layerListRef.current?.setPointerCapture(e.pointerId);
                  panelDragIdRef.current = layer.id;
                  panelDropPositionRef.current = null;
                }}
                style={{ color: C.disabled, cursor: 'grab', display: 'flex', flex: 'none' }}
              >
                <GripIcon size={11} />
              </span>

              {/* Type icon */}
              <span style={{ color: hidden ? C.textHidden : C.textFaint, display: 'flex', flex: 'none' }}>
                <Icon size={13} />
              </span>

              {/* Name */}
              <span
                title={isCanvas ? t('layers.canvas') : layer.label}
                style={{
                  flex: 1, minWidth: 0,
                  fontSize: 13,
                  fontWeight: isSelected ? 600 : 400,
                  color: hidden ? C.textHidden : isSelected ? C.textPrimary : receded ? C.textFaint : C.textSecondary,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {isCanvas ? t('layers.canvas') : layer.label}
              </span>

              {/*
                Artwork an AI pass took is hidden where it sits rather than deleted, and
                what it takes is usually nested inside a layer rather than being one. So
                without this the row looks like any other while part of what it draws is
                switched off, and the only way to find out is to open it. The count is of
                the outermost hidden pieces — open the layer and each becomes a row of its
                own, switched off, ready to switch back on.
              */}
              {hiddenInsideCount > 0 && (
                <span
                  title={t('layers.hiddenInside', { count: hiddenInsideCount })}
                  style={{
                    flex: 'none', padding: '1px 5px', borderRadius: 999,
                    fontSize: 10, fontWeight: 600, lineHeight: 1.5,
                    color: C.textFaint, background: C.borderInput,
                    fontFamily: MONO_STACK,
                  }}
                >
                  {hiddenInsideCount}
                </span>
              )}

              {/* Actions */}
              <span style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 'none' }}>
                {action(
                  () => onToggleLayer(layer.id),
                  toggleTitle,
                  hidden ? C.disabled : C.accent,
                  hidden ? <EyeSlashIcon size={12} /> : <EyeIcon size={12} />,
                )}
                {action(() => onDuplicateLayer(layer.id), t('layers.duplicate'), '#8a93a3', <DuplicateIcon size={12} />)}
                {!isCanvas && action(() => onDeleteLayer(layer.id), t('layers.delete'), C.danger, <TrashIcon size={12} />)}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
});
