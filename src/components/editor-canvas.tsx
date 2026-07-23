import React from 'react';

import type { ActiveSvg } from '@/lib/svg-utils';
import { SparklesIcon } from './svg-icons';

// The canvas stage: the rendered SVG plus the selection / drag / rotate / scale
// overlay. Memoised and fed only canvas-relevant props, so it no longer re-renders
// when unrelated state changes (text-form typing, font suggestions, modals, the
// download dropdown, …). Refs stay owned by the parent — whose handlers and layout
// effects use them — and are only attached here.
export const CanvasStage = React.memo(function CanvasStage({
  svgCanvasRef, overlayRef, subOverlayRef,
  onCanvasClick,
  aiLoading, aiStatusMsg,
  isLoading, activeSvg,
  hiddenLayers,
  showSelectionOverlay, selectionIsEmptyText, selectionIsTextLayer,
  selectedLayersSize,
  onEmptyTextClick,
  onDragHandleMouseDown, onRotateHandleMouseDown, onScaleHandleMouseDown,
}: {
  svgCanvasRef: React.RefObject<HTMLDivElement | null>;
  overlayRef: React.RefObject<HTMLDivElement | null>;
  subOverlayRef: React.RefObject<HTMLDivElement | null>;
  onCanvasClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  aiLoading: boolean;
  aiStatusMsg: string;
  isLoading: boolean;
  activeSvg: ActiveSvg | null;
  hiddenLayers: Set<string>;
  showSelectionOverlay: boolean;
  selectionIsEmptyText: boolean;
  selectionIsTextLayer: boolean;
  selectedLayersSize: number;
  onEmptyTextClick: () => void;
  onDragHandleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onRotateHandleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onScaleHandleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      ref={svgCanvasRef}
      onClick={onCanvasClick}
      className="relative flex-1 overflow-auto flex items-center justify-center min-w-0"
      style={{
        backgroundImage: 'radial-gradient(circle, #3f3f46 1px, transparent 1px)',
        backgroundSize: '20px 20px',
      }}
    >
      {/* Beta badge, pinned to the canvas top-left. Inline styles (not NativeWind
          classes) so it renders regardless of which Tailwind utilities are built. */}
      <span
        style={{
          position: 'absolute', top: 10, left: 10, zIndex: 20,
          pointerEvents: 'none',
          padding: '2px 8px', borderRadius: 6,
          fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: '#fcd34d',
          background: 'rgba(245,158,11,0.12)',
          border: '1px solid rgba(245,158,11,0.35)',
        }}
      >
        Beta
      </span>
      {aiLoading && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-950/60 backdrop-blur-[2px]">
          <SparklesIcon className="size-10 text-indigo-400 animate-pulse" />
          <span className="mt-3 text-sm text-zinc-300 tracking-wide">{aiStatusMsg}</span>
        </div>
      )}

      {isLoading && !activeSvg ? (
        <div className="w-8 h-8 rounded-full border-2 border-zinc-700 border-t-zinc-400 animate-spin" />
      ) : activeSvg ? (
        <>
          {hiddenLayers.size > 0 && (
            <style>{
              [...hiddenLayers]
                .map((id) => `.svg-canvas #${CSS.escape(id)}{display:none!important}`)
                .join('')
            }</style>
          )}
          <div
            className="svg-canvas"
            style={{ width: '80%' }}
            dangerouslySetInnerHTML={{ __html: activeSvg.content }}
          />
          {/* Selection overlay — React controls existence, layout effect controls position.
              No display/left/top/width/height in JSX so React never overrides them.
              Hidden for the locked background layer. */}
          {showSelectionOverlay && (
            <div
              ref={overlayRef}
              data-sel-overlay
              // An empty text layer has no clickable geometry, so let its placeholder
              // box catch clicks (re-focusing the input) instead of falling through and
              // selecting the background. Non-empty layers stay click-through so
              // glyph/sub-text clicks still work.
              onClick={selectionIsEmptyText ? onEmptyTextClick : undefined}
              style={{
                position: 'absolute',
                pointerEvents: selectionIsEmptyText ? 'auto' : 'none',
                outline: '2px dashed #3b82f6',
                boxSizing: 'border-box',
                zIndex: 5,
              }}
            >
              {/* Sub-layer highlight (amber) — display toggled by layout effect */}
              <div
                ref={subOverlayRef}
                style={{
                  position: 'absolute',
                  outline: '2px dashed #f59e0b',
                  boxSizing: 'border-box',
                  pointerEvents: 'none',
                }}
              />
              {/* Drag handle — single-layer selection only */}
              {selectedLayersSize === 1 && (
                <div
                  onMouseDown={onDragHandleMouseDown}
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute',
                    right: -8,
                    top: -8,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: '#3b82f6',
                    border: '2px solid white',
                    cursor: 'grab',
                    pointerEvents: 'all',
                  }}
                />
              )}
              {/* Rotate handle — single-layer selection only. Sits on a stalk above the
                  top-centre of the selection box. */}
              {selectedLayersSize === 1 && (
                <>
                  <div
                    style={{
                      position: 'absolute',
                      left: '50%',
                      top: -24,
                      width: 1,
                      height: 24,
                      marginLeft: -0.5,
                      background: '#3b82f6',
                      pointerEvents: 'none',
                    }}
                  />
                  <div
                    onMouseDown={onRotateHandleMouseDown}
                    onClick={(e) => e.stopPropagation()}
                    title="Drag to rotate (hold Shift to snap to 15°)"
                    style={{
                      position: 'absolute',
                      left: '50%',
                      top: -32,
                      marginLeft: -8,
                      width: 16,
                      height: 16,
                      borderRadius: '50%',
                      background: 'white',
                      border: '2px solid #3b82f6',
                      cursor: 'grab',
                      pointerEvents: 'all',
                    }}
                  />
                </>
              )}
              {/* Scale handle — bottom-right corner, non-text layers only. Uniform
                  scale about the layer's centre. */}
              {selectedLayersSize === 1 && !selectionIsTextLayer && (
                <div
                  onMouseDown={onScaleHandleMouseDown}
                  onClick={(e) => e.stopPropagation()}
                  title="Drag to scale"
                  style={{
                    position: 'absolute',
                    right: -7,
                    bottom: -7,
                    width: 14,
                    height: 14,
                    borderRadius: 2,
                    background: 'white',
                    border: '2px solid #3b82f6',
                    cursor: 'nwse-resize',
                    pointerEvents: 'all',
                  }}
                />
              )}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
});
