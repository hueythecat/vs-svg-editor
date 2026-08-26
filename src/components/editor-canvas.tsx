import React, { useMemo } from 'react';

import type { ActiveSvg } from '@/lib/svg-utils';
import { C, MONO_STACK, SHADOW, FONT_STACK, checkerStyle } from '@/lib/design-tokens';
import { useT } from '@/i18n/provider';
import { MoveIcon, ResizeIcon, RotateIcon, SparklesIcon } from './svg-icons';

// The canvas stage (handoff §1.1–1.3): a full-bleed, flex-centred area holding the
// white board, plus the selection / drag / rotate / scale overlay. Memoised and fed
// only canvas-relevant props, so it doesn't re-render when unrelated state changes
// (text-form typing, modals, AI runs, …). Refs stay owned by the parent — whose
// handlers and layout effects use them — and are only attached here.

// The board is capped rather than fixed at the prototype's 380px: real imported
// artwork has its own aspect ratio. The width is clamped by the viewport AND by the
// height budget times the artwork's aspect, so a tall or wide file always fits whole —
// nothing is ever cropped. The vertical budget leaves room for the floating toolbar.
const BOARD_MAX_W = 620;   // px
const BOARD_MAX_VW = 52;   // vw
const V_BUDGET = 150;      // px of chrome above/below the board

// Aspect ratio (w/h) of the document, read off the root <svg> tag: viewBox first, then
// width/height. A cheap string scan of the opening tag rather than a full DOM parse.
function documentAspect(content: string | undefined): number {
  if (!content) return 1;
  const rootTag = content.slice(0, content.indexOf('>') + 1);
  const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(rootTag);
  if (vb) {
    const parts = vb[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) return parts[2] / parts[3];
  }
  const w = /\bwidth\s*=\s*["']([\d.]+)/i.exec(rootTag);
  const h = /\bheight\s*=\s*["']([\d.]+)/i.exec(rootTag);
  if (w && h && Number(h[1]) > 0) return Number(w[1]) / Number(h[1]);
  return 1;
}

const handleBase: React.CSSProperties = {
  position: 'absolute',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'all',
  boxShadow: SHADOW.handle,
};

export const CanvasStage = React.memo(function CanvasStage({
  svgCanvasRef, overlayRef, sizeBadgeRef,
  onCanvasClick, onCanvasMouseDown,
  aiLoading, aiStatusMsg,
  isLoading, activeSvg,
  hiddenLayers, previewIds, previewOutlineId, backgroundLayerId,
  showSelectionOverlay, selectionIsEmptyText,
  onEmptyTextClick,
  editingTextId, textEditorRef, editingStyle, onInlineTextInput, onEndInlineEdit,
  onDragHandleMouseDown, onRotateHandleMouseDown, onScaleHandleMouseDown,
}: {
  svgCanvasRef: React.RefObject<HTMLDivElement | null>;
  overlayRef: React.RefObject<HTMLDivElement | null>;
  sizeBadgeRef: React.RefObject<HTMLSpanElement | null>;
  onCanvasClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  onCanvasMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  aiLoading: boolean;
  aiStatusMsg: string;
  isLoading: boolean;
  activeSvg: ActiveSvg | null;
  hiddenLayers: Set<string>;
  // Hidden elements to show anyway while the dev panel hovers an entry — the hovered
  // element AND everything hidden beneath it, because display:none on an ancestor cannot
  // be overridden by a descendant, and a group's ink all lives in its children.
  previewIds: Set<string>;
  // Which of those to outline: the entry itself, not every descendant.
  previewOutlineId: string | null;
  backgroundLayerId: string | null;
  showSelectionOverlay: boolean;
  selectionIsEmptyText: boolean;
  onEmptyTextClick: () => void;
  // Inline editing. `editingTextId` doubles as the flag and as the id whose glyphs are
  // hidden while the editable node stands in for them.
  editingTextId: string | null;
  textEditorRef: React.RefObject<HTMLDivElement | null>;
  // Type styling copied off the layer so the editor matches it. Size is not here — it
  // depends on the board scale, so the parent writes it straight onto the node.
  editingStyle: { fontFamily: string; fontWeight: number; color: string; letterSpacing: number };
  onInlineTextInput: () => void;
  onEndInlineEdit: () => void;
  onDragHandleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onRotateHandleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
  onScaleHandleMouseDown: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const t = useT();
  const aspect = useMemo(() => documentAspect(activeSvg?.content), [activeSvg?.content]);
  // No full-canvas background layer — or it's hidden — means the artwork exports with
  // transparency, so the board shows a checkerboard rather than implying a white fill.
  const isTransparent = !backgroundLayerId || hiddenLayers.has(backgroundLayerId);

  return (
    <div
      ref={svgCanvasRef}
      onClick={onCanvasClick}
      // Shift+click is the browser's "extend the text selection to here" gesture, and
      // SVG <text> is selectable like any other text — so shift-clicking a text layer
      // used to highlight everything between the last anchor and the click, and then
      // drag that whole selection around as a native drag. Cancelling the default on
      // mousedown stops the selection ever forming; the click event still fires, so
      // shift-select on the canvas is unaffected. Any selection made before the canvas
      // was touched is collapsed here too, so nothing is left highlighted.
      onMouseDown={(e) => {
        if (e.shiftKey) {
          e.preventDefault();
          window.getSelection()?.removeAllRanges();
        }
        // Press-and-hold inside a layer starts a move; the parent decides whether this
        // press landed on something draggable.
        onCanvasMouseDown(e);
      }}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Deliberate: keeps scrollbars away when artwork is dragged past the edge.
        overflow: 'hidden',
        // The artwork is something you select as layers, never as text — so plain
        // click-drags across it can't start a text selection either.
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}
    >
      {/* Beta badge — bottom-left. It sat top-right until the control panel took that
          corner outright; bottom-left is the one corner nothing else claims (dev rail
          top-left, panel top-right, AI pill bottom-right). */}
      <span
        style={{
          position: 'absolute', bottom: 16, left: 16, zIndex: 20,
          pointerEvents: 'none',
          padding: '2px 8px', borderRadius: 6,
          fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase',
          color: '#8a6410',
          background: 'rgba(242,176,62,.16)',
          border: '1px solid rgba(242,176,62,.45)',
          fontFamily: FONT_STACK,
        }}
      >
        {t('canvas.beta')}
      </span>

      {aiLoading && (
        <div
          style={{
            position: 'absolute', inset: 0, zIndex: 10,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(238,240,243,.72)', backdropFilter: 'blur(2px)',
            fontFamily: FONT_STACK,
          }}
        >
          <span style={{ color: C.accent, display: 'flex' }}><SparklesIcon size={34} /></span>
          <span style={{ marginTop: 12, fontSize: 13, color: C.textSecondary }}>{aiStatusMsg}</span>
        </div>
      )}

      {isLoading && !activeSvg ? (
        <div
          style={{
            width: 32, height: 32, borderRadius: '50%',
            border: `2px solid ${C.borderInput}`, borderTopColor: C.accent,
            animation: 'ed-spin .8s linear infinite',
          }}
        />
      ) : activeSvg ? (
        <>
          {/*
            Visibility is applied as CSS rather than written into the SVG, so the document
            keeps every element and hiding stays free to undo. `previewId` is subtracted
            from the rule so the dev panel can show a hidden element back in place just by
            hovering it — the element never moved, so it reappears exactly where it was,
            which is the whole point of not restructuring the DOM when a pass takes it.
            The outline makes it findable among artwork it may closely resemble.
          */}
          {(hiddenLayers.size > 0 || previewIds.size > 0 || editingTextId) && (
            <style>{
              [...hiddenLayers]
                .filter((id) => !previewIds.has(id))
                .map((id) => `.svg-canvas #${CSS.escape(id)}{display:none!important}`)
                .concat(previewOutlineId
                  ? [`.svg-canvas #${CSS.escape(previewOutlineId)}{outline:2px dashed ${C.accent};outline-offset:2px}`]
                  : [])
                // While a layer is being typed into, its glyphs give way to the editable
                // node standing over them — otherwise the old and new words overlap.
                // `visibility` rather than `display`, so the element keeps its box and
                // the overlay stays measurable and in place as the text changes.
                .concat(editingTextId
                  ? [`.svg-canvas text#${CSS.escape(editingTextId)},.svg-canvas #${CSS.escape(editingTextId)} text{visibility:hidden}`]
                  : [])
                .join('')
            }</style>
          )}

          {/* Board — every object coordinate is relative to this box. Sized so the
              whole document fits: width is capped by the viewport and by the height
              budget × aspect, and the height simply follows. No clipping. */}
          <div
            data-board="1"
            style={{
              position: 'relative',
              flex: 'none',
              width: `min(${BOARD_MAX_VW}vw, ${BOARD_MAX_W}px, calc((100vh - ${V_BUDGET}px) * ${aspect.toFixed(4)}))`,
              ...(isTransparent ? checkerStyle() : { background: C.surface }),
              boxShadow: SHADOW.board,
              display: 'flex',
            }}
          >
            <div
              className="svg-canvas"
              style={{ width: '100%' }}
              dangerouslySetInnerHTML={{ __html: activeSvg.content }}
            />
          </div>

          {/* Selection overlay — React controls existence, the parent's layout effect
              controls position. No display/left/top/width/height in JSX so React never
              overrides them. Hidden for the locked background layer. */}
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
                border: `1.5px dashed ${C.accent}`,
                boxSizing: 'border-box',
                zIndex: 5,
              }}
            >
              {/* Inline text editor. A child of the overlay so it inherits the box AND
                  the rotation the parent already computed for the layer — positioning it
                  separately would mean duplicating that matrix work. Inset by the 4px the
                  frame is padded with, so it lands on the glyphs rather than the frame. */}
              {editingTextId && (
                <div
                  ref={textEditorRef}
                  contentEditable
                  suppressContentEditableWarning
                  spellCheck={false}
                  onInput={onInlineTextInput}
                  onBlur={onEndInlineEdit}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    // Enter commits rather than inserting a line break: these layers are
                    // single-line <text>, so a break would be typed but never drawn.
                    if (e.key === 'Enter') { e.preventDefault(); onEndInlineEdit(); }
                    // Escape leaves the field. It does not revert — every keystroke has
                    // already gone into the document as one undo entry, so undo is the
                    // way back and Escape pretending otherwise would be a lie.
                    if (e.key === 'Escape') { e.preventDefault(); onEndInlineEdit(); }
                    e.stopPropagation();
                  }}
                  style={{
                    position: 'absolute', inset: 4,
                    display: 'flex', alignItems: 'center',
                    // Centred whatever the layer's text-anchor is: the overlay hugs the
                    // glyphs' own ink box, so the box IS the text's extent and centring
                    // inside it lands on the same place a start-, middle- or end-anchored
                    // string was already drawn.
                    justifyContent: 'center',
                    pointerEvents: 'auto',
                    outline: 'none',
                    whiteSpace: 'pre',
                    lineHeight: 1,
                    cursor: 'text',
                    // Overrides the canvas-wide userSelect:none — this is the one place
                    // on the board where a text selection is the point.
                    userSelect: 'text',
                    WebkitUserSelect: 'text',
                    fontFamily: editingStyle.fontFamily,
                    fontWeight: editingStyle.fontWeight,
                    color: editingStyle.color,
                    letterSpacing: `${editingStyle.letterSpacing}em`,
                  }}
                />
              )}

              {/* Rotate stem + handle */}
              <span
                style={{
                  position: 'absolute', left: '50%', top: -30,
                  width: 1.5, height: 22, marginLeft: -0.75,
                  background: C.accent, pointerEvents: 'none',
                }}
              />
              <div
                onMouseDown={onRotateHandleMouseDown}
                onClick={(e) => e.stopPropagation()}
                title={t('canvas.rotateHandle')}
                style={{
                  ...handleBase,
                  left: '50%', top: -42, marginLeft: -10,
                  width: 20, height: 20, borderRadius: '50%',
                  background: C.surface, border: `1.5px solid ${C.accent}`,
                  color: C.accent, cursor: 'grab',
                }}
              >
                <RotateIcon size={10} />
              </div>

              {/* Move handle */}
              <div
                onMouseDown={onDragHandleMouseDown}
                onClick={(e) => e.stopPropagation()}
                title={t('canvas.moveHandle')}
                style={{
                  ...handleBase,
                  top: -11, left: -11,
                  width: 22, height: 22, borderRadius: 6,
                  background: C.accent, color: '#fff', cursor: 'move',
                }}
              >
                <MoveIcon size={11} />
              </div>

              {/* Resize handle */}
              <div
                onMouseDown={onScaleHandleMouseDown}
                onClick={(e) => e.stopPropagation()}
                title={t('canvas.resizeHandle')}
                style={{
                  ...handleBase,
                  bottom: -11, right: -11,
                  width: 22, height: 22, borderRadius: 6,
                  background: C.surface, border: `1.5px solid ${C.accent}`,
                  color: C.accent, cursor: 'nwse-resize',
                }}
              >
                <ResizeIcon size={11} />
              </div>

              {/* Position + size badge — two lines, x/y over w/h, both written by the
                  parent's positioning pass as one newline-separated string (hence `pre`).
                  Anchored to the frame's bottom edge rather than offset up from it, so
                  the second line extends downwards instead of over the artwork. It exists
                  only while this overlay does — i.e. only for a selected or dragged
                  layer. */}
              <span
                ref={sizeBadgeRef}
                style={{
                  position: 'absolute', top: '100%', left: 0, marginTop: 8,
                  background: C.accent, color: '#fff',
                  fontFamily: MONO_STACK, fontSize: 10, lineHeight: 1.45,
                  padding: '3px 6px', borderRadius: 4,
                  pointerEvents: 'none', whiteSpace: 'pre',
                }}
              />
            </div>
          )}
        </>
      ) : null}
    </div>
  );
});
