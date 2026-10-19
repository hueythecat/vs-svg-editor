import React, { RefObject, useCallback, useEffect, useState } from 'react';

import type { SelectedTextProps } from '@/lib/svg-utils';
import {
  BG_PALETTE, C, FONT_STACK, MONO_STACK, inputStyle, sectionLabelStyle,
} from '@/lib/design-tokens';
import { useT } from '@/i18n/provider';
import type { FontChoice } from '@/lib/svg-text-tools';
import type { CustomiseBundle, DocBundle, SuggestFontsState, TextLayerAttrs } from './editor-types';
import { ColorSwatchRow } from './color-swatches';
import { CustomiseButton } from './editor-ai-panel';
import {
  CenterIcon, MatchRotationIcon, NewDesignIcon, PencilIcon, PlusIcon,
  RedoIcon, RevertIcon, RotateIcon, TidyHorizontalIcon, TidyIcon, UndoIcon,
} from './svg-icons';
import { TextControls } from './text-controls';

// The two colour/type bodies of the control panel (editor-control-panel.tsx). These
// were one floating "inspector" card that switched its body on the selection; the
// tabbed handoff splits that switch across two tabs, so the same bodies now render
// side by side and the user picks which one they are looking at:
//
//   Tools → History, the arrange actions, Customise, and the Colours surface: the canvas
//           colour for the background, every colour on the layer otherwise, helper copy
//           when nothing is selected. Export is not here — it floats over the canvas
//           (editor-export-pill.tsx), in the corner Customise used to hold.
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

// Every action in this tab is an outlined button carrying its own name — icon alone
// left too much of the panel to guesswork. They size to their label rather than to a
// share of the row, so a longer translation widens the button and wraps the row instead
// of truncating; `title` still carries the full sentence, shortcut included.
function ActionButton({
  onClick, disabled, title, label, children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  label: string;
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
        display: 'flex', alignItems: 'center', gap: 5,
        border: `1px solid ${C.borderInput}`,
        background: C.surface,
        color: disabled ? C.disabled : C.textSecondary,
        fontSize: 12.5, fontFamily: FONT_STACK,
        padding: '8px 10px', borderRadius: 8,
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
      {label}
    </button>
  );
}

// Both action rows wrap: six buttons at their natural width do not fit one 272px column
// in every language.
// One axis of the position fields. Typed into freely and applied on Enter or when focus
// leaves, not per keystroke: each apply is an undo step, and "12" on the way to "120"
// would otherwise jump the artwork about. Escape puts back the measured value.
const fmtPos = (v: number) => String(Math.round(v * 10) / 10);

function PositionField({ axis, value, onCommit }: {
  axis: 'x' | 'y';
  value: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(fmtPos(value));
  // Follows the artwork when it moves some other way — a drag, Center, undo.
  useEffect(() => { setDraft(fmtPos(value)); }, [value]);
  const commit = () => {
    const v = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(v)) { setDraft(fmtPos(value)); return; }
    if (fmtPos(v) !== fmtPos(value)) onCommit(v);
  };
  return (
    <label style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: C.textMuted, fontFamily: FONT_STACK, width: 10 }}>
        {axis.toUpperCase()}
      </span>
      <input
        className="ed-input"
        type="number"
        step="any"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setDraft(fmtPos(value)); (e.target as HTMLInputElement).blur(); }
        }}
        style={{ ...inputStyle, minWidth: 0 }}
      />
    </label>
  );
}

// X and Y of the selection's top-left corner, in the artwork's own units. Shared by the
// Tools and Text tabs: a selected text field opens on the Text tab, and placing text is
// the main reason to type a position, so it is there too.
export function PositionFields({ position, onSetPosition }: {
  position: { x: number; y: number };
  onSetPosition: (target: { x?: number; y?: number }) => void;
}) {
  const t = useT();
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ ...sectionLabelStyle, marginBottom: 7 }} title={t('panel.positionTitle')}>{t('panel.position')}</div>
      <div style={{ display: 'flex', gap: 10 }}>
        <PositionField axis="x" value={position.x} onCommit={(x) => onSetPosition({ x })} />
        <PositionField axis="y" value={position.y} onCommit={(y) => onSetPosition({ y })} />
      </div>
    </div>
  );
}

const actionRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12,
};

export const ToolsTab = React.memo(function ToolsTab({
  doc, customise, selectedLayer, isBackground, layerColors,
  onReplaceColor, onEndColorEdit,
}: {
  doc: DocBundle;
  customise: CustomiseBundle;
  selectedLayer: string | null;
  isBackground: boolean;
  layerColors: string[];
  onReplaceColor: (from: string, to: string) => void;
  onEndColorEdit: () => void;
}) {
  const t = useT();
  const { rows, shown, begin, change, end } = useColorEdit(layerColors, onReplaceColor, onEndColorEdit);
  const canvasColor = rows[0] ?? '';

  return (
    <div>
      {/* ── History ────────────────────────────────────────────────────────
          Document-level rather than selection-level, so it heads the tab. The
          unsaved-changes state still reads off revert, which is live only when there is
          something to revert. */}
      <div style={{ ...sectionLabelStyle, marginBottom: 9 }}>{t('panel.history')}</div>
      <div style={actionRow}>
        <ActionButton
          onClick={doc.onUndo}
          disabled={doc.undoCount === 0}
          title={t('toolbar.undoTitle')}
          label={t('toolbar.undo')}
        >
          <UndoIcon size={13} />
        </ActionButton>
        <ActionButton
          onClick={doc.onRedo}
          disabled={doc.redoCount === 0}
          title={t('toolbar.redoTitle')}
          label={t('toolbar.redo')}
        >
          <RedoIcon size={13} />
        </ActionButton>
        <ActionButton
          onClick={doc.onReset}
          disabled={!doc.canRevert}
          title={t('toolbar.revertTitle')}
          label={t('toolbar.revert')}
        >
          <RevertIcon size={13} />
        </ActionButton>
      </div>

      {/* ── Arrange ────────────────────────────────────────────────────────
          Its own section above Colours, because Center is the one action here that
          works with nothing selected — it centres every layer. The other two need
          something to act on, so they grey out until there is a selection. */}
      <div style={{ ...sectionLabelStyle, marginBottom: 9 }}>{t('panel.arrange')}</div>
      <div style={actionRow}>
        <ActionButton
          onClick={doc.onCenter}
          title={t('toolbar.centerTitle')}
          label={t('toolbar.center')}
        >
          <CenterIcon size={13} />
        </ActionButton>
        <ActionButton
          onClick={doc.onRotate90}
          disabled={doc.transformDisabled}
          title={t('toolbar.rotate90Title')}
          label={t('toolbar.rotate90')}
        >
          <RotateIcon size={13} />
        </ActionButton>
        <ActionButton
          onClick={doc.onMatchRotation}
          disabled={doc.matchRotationDisabled}
          title={t('toolbar.matchRotationTitle')}
          label={t('toolbar.matchRotation')}
        >
          <MatchRotationIcon size={13} />
        </ActionButton>
        <ActionButton
          onClick={doc.onTidy}
          disabled={doc.tidyDisabled}
          title={t('toolbar.tidyTitle')}
          label={t('toolbar.tidy')}
        >
          <TidyIcon size={13} />
        </ActionButton>
        <ActionButton
          onClick={doc.onTidyHorizontal}
          disabled={doc.tidyDisabled}
          title={t('toolbar.tidyHorizontalTitle')}
          label={t('toolbar.tidyHorizontal')}
        >
          <TidyHorizontalIcon size={13} />
        </ActionButton>
        <ActionButton
          onClick={doc.onNewDesign}
          disabled={doc.newDesignDisabled}
          title={t('toolbar.newDesignTitle')}
          label={t('toolbar.newDesign')}
        >
          <NewDesignIcon size={13} />
        </ActionButton>
      </div>

      {doc.position && <PositionFields position={doc.position} onSetPosition={doc.onSetPosition} />}

      {/* The one AI action, directly under Arrange — it acts on the whole artwork, like
          Center does, rather than on the selection the Colours block below edits. */}
      <div style={{ marginBottom: 18 }}>
        <CustomiseButton {...customise} />
      </div>

      {/* ── Workspace ──────────────────────────────────────────────────────
          Whether the board fills the working area between the panels (on, the default)
          or keeps its default size. A view setting: the artwork and its export are
          unchanged, so it has no place in History. */}
      <div style={{ ...sectionLabelStyle, marginBottom: 9 }}>{t('panel.workspace')}</div>
      <label
        title={t('panel.canvasSizeTitle')}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18,
          fontSize: 12.5, color: C.textSecondary, fontFamily: FONT_STACK, cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={doc.workspaceFull}
          onChange={(e) => doc.onSetWorkspaceFull(e.target.checked)}
          style={{ accentColor: C.accent, width: 14, height: 14, margin: 0, cursor: 'pointer' }}
        />
        {t('panel.workspaceFill')}
      </label>

      {/* ── Colours ────────────────────────────────────────────────────────
          One headline over the whole colour surface: which layer it acts on is the
          Layers tab's job to show, and what clicking a swatch does is evident from
          doing it. Nothing selected: the same helper copy the inspector showed. Split
          across five keys rather than one, because two words inside it are emphasised —
          and where those words sit in the sentence is a property of the language, not
          of the layout. */}
      <div style={{ ...sectionLabelStyle, marginBottom: 9 }}>{t('panel.colours')}</div>
      {!selectedLayer ? (
        <TabHint>
          {t('inspector.emptyBefore')}
          <strong style={{ color: C.textSecondary, fontWeight: 600 }}>{t('inspector.emptyText')}</strong>
          {t('inspector.emptyMiddle')}
          <strong style={{ color: C.textSecondary, fontWeight: 600 }}>{t('inspector.emptyArtwork')}</strong>
          {t('inspector.emptyAfter')}
        </TabHint>
      ) : isBackground ? (
        /* ── Canvas colour ───────────────────────────────────────────────── */
        <div>
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
        /* ── Replace a colour everywhere it is used ──────────────────────── */
        <div>
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
  );
});

// ── Text tab ─────────────────────────────────────────────────────────────────

export const TextTab = React.memo(function TextTab({
  textProps, textContentRef, usedFonts, extraFonts,
  onUpdateTextLayer, onAddTextLayer,
  detected, onShowDetectedOriginal, onRejectDetected, onSuggestFonts, suggestFontsState, textPalette,
  position, onSetPosition,
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
  // Set when the selected layer is text the Python text service put in place of outlines:
  // whether it wants a second look, and whether the outlines are showing instead of it.
  detected: { review?: 'font' | 'text'; showingOriginal: boolean; fontChoices: FontChoice[] } | null;
  onShowDetectedOriginal: (original: boolean) => void;
  onRejectDetected: () => void;
  onSuggestFonts?: () => void;
  suggestFontsState: SuggestFontsState;
  textPalette: readonly string[];
  // Set while a layer is selected; the draft for new text has no position yet.
  position: { x: number; y: number } | null;
  onSetPosition: (target: { x?: number; y?: number }) => void;
}) {
  const t = useT();
  return (
    <div>
      {detected && (
        <div
          style={{
            marginBottom: 12, padding: '9px 10px', borderRadius: 8,
            border: `1px solid ${detected.review ? C.review : C.borderInput}`,
            fontFamily: FONT_STACK,
          }}
        >
          {detected.review && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 11.5, fontWeight: 600, color: C.review }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.review, flex: 'none' }} />
              {t(detected.review === 'text' ? 'text.checkIsText' : 'text.checkFont')}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.textSecondary, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={detected.showingOriginal}
                onChange={(e) => onShowDetectedOriginal(e.target.checked)}
                style={{ accentColor: C.accent, margin: 0 }}
              />
              {t('text.showOriginal')}
            </label>
            <button
              type="button"
              className="ed-ghost"
              onClick={onRejectDetected}
              title={t('text.notTextTitle')}
              style={{
                border: `1px solid ${C.borderInput}`, background: C.surface, color: C.textSecondary,
                fontSize: 11.5, fontFamily: FONT_STACK, padding: '4px 9px', borderRadius: 6, cursor: 'pointer',
              }}
            >
              {t('text.notText')}
            </button>
          </div>
        </div>
      )}
      <TextControls
        selectedTextProps={textProps}
        textContentRef={textContentRef}
        usedFonts={usedFonts}
        extraFonts={extraFonts}
        onUpdateTextLayer={onUpdateTextLayer}
        onSuggestFonts={onSuggestFonts}
        suggestFontsState={suggestFontsState}
        palette={textPalette}
        fontChoices={detected?.fontChoices}
      />

      {position && <PositionFields position={position} onSetPosition={onSetPosition} />}

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
