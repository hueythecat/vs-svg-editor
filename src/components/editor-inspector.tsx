import React, { RefObject, useCallback, useState } from 'react';

import type { SelectedTextProps } from '@/lib/svg-utils';
import {
  BG_PALETTE, C, FONT_STACK, MONO_STACK, labelStyle, sectionLabelStyle,
} from '@/lib/design-tokens';
import { useT } from '@/i18n/provider';
import type { DocBundle, TextLayerAttrs } from './editor-types';
import { ColorSwatchRow } from './color-swatches';
import {
  CenterIcon, CloseIcon, DownloadIcon, PencilIcon, PlusIcon,
  RedoIcon, RevertIcon, RotateIcon, UndoIcon,
} from './svg-icons';
import { TextControls } from './text-controls';

// The two colour/type bodies of the control panel (editor-control-panel.tsx). These
// were one floating "inspector" card that switched its body on the selection; the
// tabbed handoff splits that switch across two tabs, so the same bodies now render
// side by side and the user picks which one they are looking at:
//
//   Tools → the document head (file, history, Export), the arrange actions, and the
//           colour surface: canvas colour for the background, find & replace for any
//           other layer, helper copy when nothing is selected.
//   Text  → the type form (text-controls.tsx), plus Add text layer, which stays
//           available with nothing selected.
//
// Neither renders its own card — the shell owns the frame, the scrolling and the
// padding.

// A colour edit is a *session*: the "from" colour is frozen while the native picker is
// open, so live dragging keeps replacing the same original colour (one undo entry,
// applied from one baseline) instead of chasing the colour it just wrote. The row list
// is frozen alongside it so React doesn't unmount the row — and with it the open
// picker — the instant the underlying colour changes.
function useColorEdit(colors: string[], onReplaceColor: (from: string, to: string) => void, onEndColorEdit: () => void) {
  const [session, setSession] = useState<{ from: string; to: string; frozen: string[] } | null>(null);

  const begin = useCallback((from: string) => {
    setSession({ from, to: from, frozen: colors });
  }, [colors]);

  const change = useCallback((from: string, to: string) => {
    setSession((cur) => (cur && cur.from === from ? { ...cur, to } : { from, to, frozen: colors }));
    onReplaceColor(from, to);
  }, [colors, onReplaceColor]);

  const end = useCallback(() => {
    setSession(null);
    onEndColorEdit();
  }, [onEndColorEdit]);

  const rows = session ? session.frozen : colors;
  const shown = (c: string) => (session && session.from === c ? session.to : c);

  return { rows, shown, begin, change, end };
}

// Dashed hint block — what the Tools tab shows when nothing is selected.
function TabHint({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0, padding: '12px 12px',
        border: `1px dashed ${C.borderInput}`, borderRadius: 9,
        fontSize: 12, lineHeight: 1.6, color: C.textFaint,
      }}
    >
      {children}
    </p>
  );
}

// ── Tools tab ────────────────────────────────────────────────────────────────

// 14px icon button for the file row — full colour when live, the disabled grey when its
// stack is empty. Same treatment the floating toolbar used.
function IconButton({
  onClick, disabled, title, color, children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  color?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="ed-ghost"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'flex', flex: 'none', alignItems: 'center',
        border: 'none', background: 'transparent',
        padding: 4, borderRadius: 6,
        color: disabled ? C.disabledIcon : (color ?? C.textSecondary),
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

// Outlined action button for the arrange row.
const arrangeButton = (disabled: boolean): React.CSSProperties => ({
  flex: 1,
  minWidth: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
  border: `1px solid ${C.borderInput}`,
  background: C.surface,
  color: disabled ? C.disabled : C.textSecondary,
  fontSize: 12.5, fontFamily: FONT_STACK,
  padding: '9px 8px', borderRadius: 8,
  cursor: disabled ? 'default' : 'pointer',
  whiteSpace: 'nowrap',
});

export const ToolsTab = React.memo(function ToolsTab({
  doc, selectedLayer, selectedLayerName, isBackground, layerColors,
  onReplaceColor, onEndColorEdit, onDeselect,
}: {
  doc: DocBundle;
  selectedLayer: string | null;
  selectedLayerName: string;
  isBackground: boolean;
  layerColors: string[];
  onReplaceColor: (from: string, to: string) => void;
  onEndColorEdit: () => void;
  onDeselect: () => void;
}) {
  const t = useT();
  const { rows, shown, begin, change, end } = useColorEdit(layerColors, onReplaceColor, onEndColorEdit);
  const canvasColor = rows[0] ?? '';

  return (
    <div>
      {/* History. Document-level rather than selection-level, so it heads the tab above
          Export. The unsaved-changes state still reads off revert, which is live only
          when there is something to revert. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 14 }}>
        <IconButton onClick={doc.onUndo} disabled={doc.undoCount === 0} title={t('toolbar.undo')}>
          <UndoIcon size={14} />
        </IconButton>
        <IconButton onClick={doc.onRedo} disabled={doc.redoCount === 0} title={t('toolbar.redo')}>
          <RedoIcon size={14} />
        </IconButton>
        <IconButton onClick={doc.onReset} disabled={!doc.isDirty} title={t('toolbar.revertTitle')}>
          <RevertIcon size={14} />
        </IconButton>
      </div>

      {/* ── Export ─────────────────────────────────────────────────────────── */}
      <button
        type="button"
        onClick={doc.onExport}
        style={{
          width: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          border: 'none', background: C.accent, color: '#fff',
          fontSize: 12.5, fontWeight: 600, fontFamily: FONT_STACK,
          padding: 10, borderRadius: 8, cursor: 'pointer', marginBottom: 18,
        }}
      >
        <DownloadIcon size={13} />
        {doc.exportLabel}
      </button>

      {/* ── Arrange ────────────────────────────────────────────────────────
          Its own section rather than part of the selection block below, because
          Center is the one action here that works with nothing selected — it
          centres every layer. The other two need something to act on. */}
      <div style={{ ...sectionLabelStyle, marginBottom: 9 }}>{t('panel.arrange')}</div>
      <div style={{ display: 'flex', gap: 7, marginBottom: 18 }}>
        <button
          type="button"
          className="ed-ghost"
          onClick={doc.onCenter}
          title={t('toolbar.centerTitle')}
          style={arrangeButton(false)}
        >
          <CenterIcon size={13} />
          {t('toolbar.center')}
        </button>
        <button
          type="button"
          className="ed-ghost"
          onClick={doc.onRotate90}
          disabled={doc.transformDisabled}
          title={t('toolbar.rotate90Title')}
          style={arrangeButton(doc.transformDisabled)}
        >
          <RotateIcon size={13} />
          90°
        </button>
        <IconButton
          onClick={doc.onMatchRotation}
          disabled={doc.matchRotationDisabled}
          title={t('toolbar.matchRotationTitle')}
        >
          <RotateIcon size={15} />
        </IconButton>
      </div>

      {/* ── Selection ──────────────────────────────────────────────────────
          Nothing selected: the same helper copy the inspector showed. Split across
          five keys rather than one, because two words inside it are emphasised — and
          where those words sit in the sentence is a property of the language, not of
          the layout. */}
      {!selectedLayer ? (
        <TabHint>
          {t('inspector.emptyBefore')}
          <strong style={{ color: C.textSecondary, fontWeight: 600 }}>{t('inspector.emptyText')}</strong>
          {t('inspector.emptyMiddle')}
          <strong style={{ color: C.textSecondary, fontWeight: 600 }}>{t('inspector.emptyArtwork')}</strong>
          {t('inspector.emptyAfter')}
        </TabHint>
      ) : (
      <div>
      {/* What the colours below act on, and the way to stop acting on it. The ✕
          deselects rather than closing anything — the panel itself is permanent now. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 9 }}>
        <span
          style={{
            ...sectionLabelStyle, flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
          title={selectedLayerName}
        >
          {t('panel.selection', { name: selectedLayerName })}
        </span>
        <button
          type="button"
          className="ed-ghost"
          onClick={onDeselect}
          title={t('inspector.deselect')}
          style={{
            border: 'none', background: 'transparent', color: C.textFaint,
            padding: 2, borderRadius: 6, cursor: 'pointer', display: 'flex', flex: 'none',
          }}
        >
          <CloseIcon size={12} />
        </button>
      </div>

      {isBackground ? (
        /* ── Canvas colour ───────────────────────────────────────────────── */
        <div>
          <label style={labelStyle}>{t('inspector.canvasColor')}</label>
          {canvasColor ? (
            <ColorSwatchRow
              palette={BG_PALETTE}
              value={shown(canvasColor)}
              onPick={(c) => { begin(canvasColor); change(canvasColor, c); end(); }}
              onCustomInput={(c) => change(canvasColor, c)}
              onCustomPointerDown={() => begin(canvasColor)}
              onCustomBlur={end}
            />
          ) : (
            <p style={{ fontSize: 12, lineHeight: 1.6, color: C.textFaint, margin: 0 }}>
              {t('inspector.noBackgroundFill')}
            </p>
          )}
        </div>
      ) : (
        /* ── Find & replace colours ──────────────────────────────────────── */
        <div>
          <label style={labelStyle}>{t('inspector.findReplace')}</label>
          <p style={{ fontSize: 11, color: C.textFaint, margin: '0 0 8px', lineHeight: 1.5 }}>
            {t('inspector.findReplaceHint')}
          </p>
          {rows.length === 0 ? (
            <p style={{ fontSize: 12, lineHeight: 1.6, color: C.textFaint, margin: 0 }}>
              {t('inspector.noColours')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {rows.map((c) => {
                const value = shown(c);
                return (
                  <label
                    key={c}
                    className="ed-row"
                    style={{
                      position: 'relative',
                      display: 'flex', alignItems: 'center', gap: 10,
                      border: `1px solid ${C.borderRow}`, borderRadius: 9,
                      padding: '6px 8px', cursor: 'pointer',
                    }}
                  >
                    <span
                      style={{
                        width: 22, height: 22, borderRadius: 6, flex: 'none', background: value,
                        border: value.toLowerCase() === '#ffffff' ? `1px solid ${C.borderInput}` : 'none',
                      }}
                    />
                    <span style={{ flex: 1, fontFamily: MONO_STACK, fontSize: 11, letterSpacing: '.3px', color: C.textSecondary }}>
                      {value.toUpperCase()}
                    </span>
                    <span style={{ color: C.textFaint, display: 'flex' }}>
                      <PencilIcon size={12} />
                    </span>
                    <input
                      type="color"
                      value={value}
                      onPointerDown={() => begin(c)}
                      onChange={(e) => change(c, e.target.value)}
                      onBlur={end}
                      style={{
                        position: 'absolute', inset: 0, width: '100%', height: '100%',
                        opacity: 0, border: 'none', padding: 0, cursor: 'pointer',
                      }}
                    />
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
      </div>
      )}
    </div>
  );
});

// ── Text tab ─────────────────────────────────────────────────────────────────

export const TextTab = React.memo(function TextTab({
  textProps, textContentRef, usedFonts, extraFonts,
  onUpdateTextLayer, onAddTextLayer,
}: {
  // Never null: with a text layer selected these are its live attributes, with nothing
  // selected they are the draft Add text layer will use. The tab has no empty state —
  // the same controls are always here, only what they write to changes.
  textProps: SelectedTextProps;
  textContentRef: RefObject<HTMLInputElement | null>;
  usedFonts: string[];
  extraFonts: string[];
  onUpdateTextLayer: (attrs: Partial<TextLayerAttrs>) => void;
  onAddTextLayer: () => void;
}) {
  const t = useT();
  return (
    <div>
      <TextControls
        selectedTextProps={textProps}
        textContentRef={textContentRef}
        usedFonts={usedFonts}
        extraFonts={extraFonts}
        onUpdateTextLayer={onUpdateTextLayer}
      />

      {/* Commits the draft above when nothing is selected; adds a fresh layer from those
          same values when something is. */}
      <button
        type="button"
        className="ed-ghost"
        onClick={onAddTextLayer}
        title={t('layers.addText')}
        style={{
          width: '100%',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          border: `1px solid ${C.borderInput}`, background: C.surface,
          color: C.textSecondary, fontSize: 12.5, fontFamily: FONT_STACK,
          padding: '9px 12px', borderRadius: 8, cursor: 'pointer',
        }}
      >
        <PlusIcon size={13} />
        {t('text.addLayer')}
      </button>
    </div>
  );
});
