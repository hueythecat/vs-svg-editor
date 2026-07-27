import React, { Dispatch, SetStateAction, useRef, useState } from 'react';

import type { SvgLayer } from '@/lib/svg-utils';
import { C, FONT_STACK } from '@/lib/design-tokens';
import {
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
  layers, hiddenLayers, selectedLayers, backgroundLayerId, textLayerIds, subLayerMap, selectedSubElId,
  onReorderLayers, onSetSelectedLayers, onSetSelectedLayer, onSelectOne,
  onToggleLayer, onDuplicateLayer, onDeleteLayer, onSetSelectedSubElId,
}: {
  layers: SvgLayer[];
  hiddenLayers: Set<string>;
  selectedLayers: Set<string>;
  backgroundLayerId: string | null;
  textLayerIds: Set<string>;
  subLayerMap: Map<string, Array<{ id: string; label: string }>>;
  selectedSubElId: string | null;
  onReorderLayers: (fromId: string, toId: string, before: boolean) => void;
  onSetSelectedLayers: Dispatch<SetStateAction<Set<string>>>;
  onSetSelectedLayer: Dispatch<SetStateAction<string | null>>;
  onSelectOne: (id: string | null) => void;
  onToggleLayer: (id: string) => void;
  onDuplicateLayer: (id: string) => void;
  onDeleteLayer: (id: string) => void;
  onSetSelectedSubElId: Dispatch<SetStateAction<string | null>>;
}) {
  const [dragLayerId, setDragLayerId]   = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<{ targetId: string; before: boolean } | null>(null);

  const layerListRef         = useRef<HTMLDivElement>(null);
  const panelDragIdRef       = useRef<string | null>(null);
  const panelDropPositionRef = useRef<{ targetId: string; before: boolean } | null>(null);
  const panelReorderDoneRef  = useRef(false);

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
      }}
      onPointerMove={(e) => {
        if (!panelDragIdRef.current) return;
        setDragLayerId(panelDragIdRef.current);
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const row = under?.closest('[data-layer-id]') as HTMLElement | null;
        if (!row || row.dataset.layerId === panelDragIdRef.current) {
          panelDropPositionRef.current = null;
          setDropPosition(null);
          return;
        }
        const rect = row.getBoundingClientRect();
        const pos = { targetId: row.dataset.layerId!, before: e.clientY < rect.top + rect.height / 2 };
        panelDropPositionRef.current = pos;
        setDropPosition(pos);
      }}
      onPointerUp={(e) => {
        if (!panelDragIdRef.current) return;
        layerListRef.current?.releasePointerCapture(e.pointerId);
        const pos = panelDropPositionRef.current;
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
          No named layers found
        </p>
      ) : (
        [...layers].reverse().map((layer) => {
          const hidden     = hiddenLayers.has(layer.id);
          const isSelected = selectedLayers.has(layer.id);
          const isDragged  = dragLayerId === layer.id;
          const isCanvas   = layer.id === backgroundLayerId;
          const kind       = isCanvas ? 'bg' : textLayerIds.has(layer.id) ? 'text' : 'art';
          const Icon       = ICON_FOR[kind];
          const dropBefore = dropPosition?.targetId === layer.id && dropPosition.before;
          const dropAfter  = dropPosition?.targetId === layer.id && !dropPosition.before;
          return (
            <React.Fragment key={layer.id}>
              <div
                data-layer-id={layer.id}
                className={isSelected ? 'ed-row-selected' : 'ed-row'}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  if (e.shiftKey) {
                    onSetSelectedLayers((prev) => {
                      const next = new Set(prev);
                      if (next.has(layer.id)) next.delete(layer.id); else next.add(layer.id);
                      return next;
                    });
                    onSetSelectedLayer(layer.id);
                  } else {
                    onSelectOne(layer.id);
                  }
                }}
                onClick={() => {
                  if (panelReorderDoneRef.current) panelReorderDoneRef.current = false;
                }}
                style={{
                  position: 'relative',
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '7px 8px', borderRadius: 8,
                  border: `1px solid ${isSelected ? C.accentTintBorder : 'transparent'}`,
                  background: isSelected ? C.accentTint : 'transparent',
                  opacity: isDragged ? 0.35 : 1,
                  userSelect: 'none',
                  cursor: 'default',
                }}
              >
                {dropBefore && (
                  <span style={{ position: 'absolute', top: -1, left: 4, right: 4, height: 2, borderRadius: 1, background: C.accent, pointerEvents: 'none' }} />
                )}
                {dropAfter && (
                  <span style={{ position: 'absolute', bottom: -1, left: 4, right: 4, height: 2, borderRadius: 1, background: C.accent, pointerEvents: 'none' }} />
                )}

                {/* Drag grip */}
                <span
                  title="Drag to reorder"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    onSelectOne(layer.id);
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
                  title={isCanvas ? 'Canvas' : layer.label}
                  style={{
                    flex: 1, minWidth: 0,
                    fontSize: 13,
                    fontWeight: isSelected ? 600 : 400,
                    color: hidden ? C.textHidden : isSelected ? C.textPrimary : C.textSecondary,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {isCanvas ? 'Canvas' : layer.label}
                </span>

                {/* Actions */}
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 'none' }}>
                  {action(
                    () => onToggleLayer(layer.id),
                    hidden ? 'Show layer' : 'Hide layer',
                    hidden ? C.disabled : C.accent,
                    hidden ? <EyeSlashIcon size={12} /> : <EyeIcon size={12} />,
                  )}
                  {action(() => onDuplicateLayer(layer.id), 'Duplicate layer', '#8a93a3', <DuplicateIcon size={12} />)}
                  {!isCanvas && action(() => onDeleteLayer(layer.id), 'Delete layer', C.danger, <TrashIcon size={12} />)}
                </span>
              </div>

              {/* Sub-layer rows for multi-text groups */}
              {subLayerMap.get(layer.id)?.map((sub) => {
                const isSubSelected = selectedSubElId === sub.id;
                return (
                  <button
                    key={sub.id}
                    type="button"
                    className={isSubSelected ? 'ed-row-selected' : 'ed-row'}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectOne(layer.id);
                      onSetSelectedSubElId(sub.id);
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 7,
                      width: '100%', textAlign: 'left',
                      padding: '5px 8px 5px 26px', borderRadius: 8,
                      border: `1px solid ${isSubSelected ? C.accentTintBorder : 'transparent'}`,
                      background: isSubSelected ? C.accentTint : 'transparent',
                      cursor: 'pointer', fontFamily: FONT_STACK,
                    }}
                  >
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.disabled, flex: 'none' }} />
                    <span
                      style={{
                        flex: 1, minWidth: 0, fontSize: 11.5,
                        color: isSubSelected ? C.textPrimary : C.textFaint,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >
                      {sub.label}
                    </span>
                  </button>
                );
              })}
            </React.Fragment>
          );
        })
      )}
    </div>
  );
});
