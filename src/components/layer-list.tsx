import React, { Dispatch, SetStateAction, useRef, useState } from 'react';

import type { SvgLayer } from '@/lib/svg-utils';
import { cn } from '@/lib/utils';
import { DuplicateIcon, EyeIcon, EyeSlashIcon, GripIcon, TrashIcon } from './svg-icons';

// The scrollable, drag-to-reorder layer list (plus sub-layer rows for multi-text
// groups). All the drag/reorder machinery — refs + transient drag state — is
// panel-local and lives here, so the parent only supplies data and callbacks.
// Extracted from layers-panel.tsx and memoised.
export const LayerList = React.memo(function LayerList({
  layers, hiddenLayers, selectedLayers, backgroundLayerId, subLayerMap, selectedSubElId,
  onReorderLayers, onSetSelectedLayers, onSetSelectedLayer, onSelectOne,
  onToggleLayer, onDuplicateLayer, onDeleteLayer, onSetSelectedSubElId,
}: {
  layers: SvgLayer[];
  hiddenLayers: Set<string>;
  selectedLayers: Set<string>;
  backgroundLayerId: string | null;
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

  return (
    <div
      ref={layerListRef}
      className="flex flex-col overflow-y-auto py-1 flex-1"
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
        <p className="text-xs text-zinc-600 px-3 py-4 text-center">No named layers found</p>
      ) : (
        [...layers].reverse().map((layer) => {
          const hidden     = hiddenLayers.has(layer.id);
          const isSelected = selectedLayers.has(layer.id);
          const isDragged  = dragLayerId === layer.id;
          const isCanvas   = layer.id === backgroundLayerId;
          const isDuplicate = layer.id.startsWith('_layer_copy_');
          const dropBefore = dropPosition?.targetId === layer.id && dropPosition.before;
          const dropAfter  = dropPosition?.targetId === layer.id && !dropPosition.before;
          return (
            <React.Fragment key={layer.id}>
              <div
                data-layer-id={layer.id}
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
                className={cn(
                  'relative group flex items-center gap-2 px-2 py-1.5 mx-1 rounded-md transition-colors select-none',
                  isSelected ? 'bg-zinc-700/60 ring-1 ring-inset ring-zinc-600' : 'hover:bg-zinc-800/60',
                  hidden && 'opacity-40',
                  isDragged && 'opacity-25',
                )}
              >
                {dropBefore && (
                  <div className="pointer-events-none absolute top-0 left-1 right-1 h-0.5 -translate-y-1/2 rounded-full bg-blue-500 z-10" />
                )}
                {dropAfter && (
                  <div className="pointer-events-none absolute bottom-0 left-1 right-1 h-0.5 translate-y-1/2 rounded-full bg-blue-500 z-10" />
                )}

                {/* Drag handle */}
                <span
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    onSelectOne(layer.id);
                    layerListRef.current?.setPointerCapture(e.pointerId);
                    panelDragIdRef.current = layer.id;
                    panelDropPositionRef.current = null;
                  }}
                  className="shrink-0 cursor-grab opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-300 transition-opacity"
                >
                  <GripIcon className="size-2" />
                </span>

                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onToggleLayer(layer.id); }}
                  title={hidden ? 'Show layer' : 'Hide layer'}
                  className="shrink-0 text-zinc-500 hover:text-zinc-200 transition-colors"
                >
                  {hidden ? <EyeSlashIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                </button>

                <span className="text-xs text-zinc-300 truncate leading-snug flex-1 min-w-0">
                  {isCanvas ? 'Canvas' : layer.label}
                </span>
                {isCanvas && (
                  <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wider text-zinc-500 bg-zinc-800 px-1 py-0.5 rounded">
                    bg
                  </span>
                )}

                <button
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onDuplicateLayer(layer.id); }}
                  title="Duplicate layer"
                  className="shrink-0 text-zinc-500 hover:text-zinc-200 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <DuplicateIcon className="size-3.5" />
                </button>
                {isDuplicate && (
                  <button
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onDeleteLayer(layer.id); }}
                    title="Delete layer"
                    className="shrink-0 text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <TrashIcon className="size-3.5" />
                  </button>
                )}
              </div>

              {/* Sub-layer rows for multi-text groups */}
              {subLayerMap.get(layer.id)?.map((sub) => {
                const isSubSelected = selectedSubElId === sub.id;
                return (
                  <button
                    key={sub.id}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectOne(layer.id);
                      onSetSelectedSubElId(sub.id);
                    }}
                    className={cn(
                      'w-full flex items-center gap-1.5 pl-8 pr-2 py-1 rounded-md text-left transition-colors',
                      isSubSelected
                        ? 'bg-amber-500/15 ring-1 ring-inset ring-amber-500/40'
                        : 'hover:bg-zinc-800/60'
                    )}
                  >
                    <span className="shrink-0 size-1.5 rounded-full bg-zinc-600" />
                    <span className={cn(
                      'text-[11px] truncate leading-snug flex-1 min-w-0',
                      isSubSelected ? 'text-amber-300' : 'text-zinc-500'
                    )}>
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
