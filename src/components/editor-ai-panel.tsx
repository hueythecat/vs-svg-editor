import React from 'react';

import {
  C, FONT_STACK, SHADOW, inputStyle, labelStyle, sectionLabelStyle,
} from '@/lib/design-tokens';
import type {
  AiActionType, AiBundle, FontBundle, LlmProvider, TaxonomyBundle,
} from './editor-types';
import { ChevronIcon, CloseIcon, SparklesIcon } from './svg-icons';

// The AI surface of the design (handoff §1.8): a gradient pill bottom-right.
//
// In the prototype the pill only ever opens the upsell. Here it keeps that behaviour
// for gated assets (edit === 0) and otherwise opens this panel, which holds the AI
// tools that already exist in the app — model choice, whole-image Customise, per-layer
// actions and the taxonomy pass — restyled onto the light palette.

const TAXONOMY_COLOURS: Record<string, string> = {
  text:       '#b45309',
  background: '#4b5563',
  icon:       '#0369a1',
  graphic:    '#0369a1',
  decoration: '#7c3aed',
  shape:      '#047857',
  image:      '#be123c',
};

const sectionStyle: React.CSSProperties = {
  padding: '12px 14px',
  borderTop: `1px solid ${C.borderRow}`,
};

const secondaryButton = (disabled: boolean): React.CSSProperties => ({
  width: '100%',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
  border: `1px solid ${C.borderInput}`,
  background: disabled ? C.rowHover : C.surface,
  color: disabled ? C.disabled : C.textSecondary,
  fontSize: 12.5, fontWeight: 600, fontFamily: FONT_STACK,
  padding: '8px 12px', borderRadius: 8,
  cursor: disabled ? 'default' : 'pointer',
});

const spinner = (
  <span
    style={{
      width: 12, height: 12, borderRadius: '50%', flex: 'none',
      border: `2px solid ${C.borderInput}`, borderTopColor: C.accent,
      animation: 'ed-spin .8s linear infinite',
    }}
  />
);

// ── Pill ─────────────────────────────────────────────────────────────────────

// The pill runs the customise pass itself — it is the action, not a menu. The caret on
// its right edge is the way into the AI tools panel (model, per-layer actions,
// taxonomy), which would otherwise have no trigger. That panel is dev-only, so with
// showTools false the caret and its divider go and the pill is simply a button.
export const AiPill = React.memo(function AiPill({
  onCustomise, onOpenTools, loading, done, toolsOpen, showTools,
  gated = false, ready = true, cooldown = false,
}: {
  onCustomise: () => void;
  onOpenTools: () => void;
  loading: boolean;
  done: boolean;
  toolsOpen: boolean;
  showTools: boolean;
  gated?: boolean;
  ready?: boolean;
  cooldown?: boolean;
}) {
  // Two states divert the click to a modal rather than the pass: `gated` (edit === 0 —
  // the upsell) and `cooldown` (customised too recently — the cooldown message). Both
  // must stay live-looking and clickable no matter what the loading/done flags say.
  // Disabling either would swallow the click and leave the user with no explanation.
  //
  // `ready` is the one thing that overrides them: until the SVG is on the canvas there
  // is nothing to customise and nothing to explain, so the pill starts inert.
  const diverted = gated || cooldown;
  const spent = done && !diverted;
  const busy = loading && !diverted;
  const inert = !ready || busy || spent;
  const label = busy ? 'Customising…' : spent ? 'Customised' : 'Customise';
  return (
    <div
      style={{
        position: 'absolute', right: 16, bottom: 16, zIndex: 15,
        display: 'flex', alignItems: 'center',
        // Once the pass has run, the pill is spent for this artwork — drop the accent
        // gradient for flat grey and lose the lift, so it reads as disabled rather than
        // as a button that's simply been relabelled.
        background: inert && !busy ? C.disabled : C.accentGrad,
        borderRadius: 11,
        boxShadow: inert && !busy ? 'none' : SHADOW.aiPill,
        fontFamily: FONT_STACK,
        opacity: busy ? 0.85 : inert ? 0.75 : 1,
      }}
    >
      <button
        type="button"
        onClick={onCustomise}
        disabled={inert}
        title={
          !ready ? 'Waiting for the artwork to load'
            : gated ? 'Unlock AI editing'
            : cooldown ? 'This artwork was customised recently — try again later'
            : spent ? 'This image has already been customised'
            : 'Run the AI customise pass'
        }
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'transparent', border: 'none',
          // Tighter on the right when the caret follows it, even padding when it doesn't.
          padding: showTools ? '11px 13px 11px 15px' : '11px 15px',
          cursor: inert ? 'default' : 'pointer',
          fontFamily: FONT_STACK,
        }}
      >
        {busy ? (
          <span
            style={{
              width: 13, height: 13, borderRadius: '50%', flex: 'none',
              border: '2px solid rgba(255,255,255,.45)', borderTopColor: '#fff',
              animation: 'ed-spin .8s linear infinite',
            }}
          />
        ) : (
          <span style={{ color: '#fff', display: 'flex' }}><SparklesIcon size={13} /></span>
        )}
        <span style={{ color: '#fff', fontSize: 12.5, fontWeight: 700 }}>{label}</span>
      </button>

      {showTools && (
        <>
          <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.3)', flex: 'none' }} />

          <button
            type="button"
            onClick={onOpenTools}
            title="AI tools"
            style={{
              display: 'flex', alignItems: 'center',
              background: 'transparent', border: 'none',
              padding: '11px 12px', cursor: 'pointer', color: '#fff',
            }}
          >
            <ChevronIcon size={12} direction={toolsOpen ? 'down' : 'up'} />
          </button>
        </>
      )}
    </div>
  );
});

// ── Panel ────────────────────────────────────────────────────────────────────

export const AiPanel = React.memo(function AiPanel({
  open, onClose,
  llmProvider, llmOptions, onSelectLlmProvider,
  ai, fonts, taxonomy,
  selectedLayer, backgroundLayerId,
  onRunAiAction, onApplyFontGlobally, onUseSuggestedFont, onRunTaxonomy,
}: {
  open: boolean;
  onClose: () => void;
  llmProvider: LlmProvider;
  llmOptions: ReadonlyArray<{ value: LlmProvider; label: string }>;
  onSelectLlmProvider: (provider: LlmProvider) => void;
  ai: AiBundle;
  fonts: FontBundle;
  taxonomy: TaxonomyBundle;
  selectedLayer: string | null;
  backgroundLayerId: string | null;
  onRunAiAction: (action?: AiActionType, query?: string) => void;
  onApplyFontGlobally: (fontName: string) => void;
  onUseSuggestedFont: (font: string) => void;
  onRunTaxonomy: () => void;
}) {
  if (!open) return null;

  const busy = ai.loading || fonts.customiseLoading || fonts.imageFontsLoading;
  const layerActionsDisabled = ai.loading || !selectedLayer || selectedLayer === backgroundLayerId;

  return (
    <div
      className="ed-scroll"
      style={{
        position: 'absolute', right: 16, bottom: 66, width: 252, zIndex: 16,
        background: C.surface,
        border: `1px solid ${C.borderPanel}`,
        borderRadius: 12,
        boxShadow: SHADOW.inspector,
        maxHeight: 'calc(100vh - 220px)',
        overflowY: 'auto',
        overflowX: 'hidden',
        fontFamily: FONT_STACK,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px 10px' }}>
        <span
          style={{
            width: 22, height: 22, borderRadius: 6, flex: 'none',
            background: C.accentGradDiag, color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <SparklesIcon size={12} />
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.textPrimary, flex: 1 }}>AI tools</span>
        <button
          type="button"
          className="ed-ghost"
          onClick={onClose}
          title="Close"
          style={{ border: 'none', background: 'transparent', color: C.textFaint, padding: 2, borderRadius: 6, cursor: 'pointer', display: 'flex' }}
        >
          <CloseIcon size={13} />
        </button>
      </div>

      {/* Model */}
      <div style={{ padding: '0 14px 12px' }}>
        <label style={labelStyle}>Model</label>
        <select
          className="ed-input"
          value={llmProvider}
          disabled={busy}
          onChange={(e) => onSelectLlmProvider(e.target.value as LlmProvider)}
          style={{ ...inputStyle, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1 }}
        >
          {llmOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Whole-image results. Customise itself is run from the pill, not from here. */}
      <div style={sectionStyle}>
        <span style={{ ...sectionLabelStyle, display: 'block', marginBottom: 8 }}>This image</span>
        {fonts.customiseLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {spinner}
            <span style={{ fontSize: 12, color: C.textMuted }}>Analysing…</span>
          </div>
        ) : fonts.customiseFonts.length > 0 ? (
          <div>
            <label style={labelStyle}>Apply font globally</label>
            <select
              className="ed-input"
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) {
                  onApplyFontGlobally(e.target.value);
                  e.target.value = '';
                }
              }}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              <option value="" disabled>Choose a font…</option>
              {fonts.customiseFonts.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>
              ))}
            </select>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 11.5, color: C.textFaint, lineHeight: 1.5 }}>
            {fonts.customiseDone
              ? 'Customise found no fonts to apply.'
              : 'Run Customise from the pill to detect text and suggest fonts.'}
          </p>
        )}
      </div>

      {/* Per-layer actions */}
      <div style={sectionStyle}>
        <span style={{ ...sectionLabelStyle, display: 'block', marginBottom: 8 }}>Selected layer</span>
        <select
          className="ed-input"
          value=""
          disabled={layerActionsDisabled}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'strip-text') onRunAiAction('strip-text');
            else if (v === 'suggest-font') onRunAiAction('suggest-font');
            else if (v === 'remove-specific-text') { ai.setShowRemoveTextInput(true); ai.setRemoveTextQuery(''); }
            else if (v === 'check-text') { ai.setTextCheckResult(null); onRunAiAction('check-text'); }
          }}
          style={{
            ...inputStyle,
            cursor: layerActionsDisabled ? 'default' : 'pointer',
            opacity: layerActionsDisabled ? 0.5 : 1,
          }}
        >
          <option value="" disabled hidden>
            {ai.loading
              ? 'Processing…'
              : !selectedLayer
              ? 'Select a layer first'
              : selectedLayer === backgroundLayerId
              ? 'Not available for the canvas'
              : 'Choose an action…'}
          </option>
          <option value="strip-text">Strip text</option>
          <option value="suggest-font">Suggest font</option>
          <option value="remove-specific-text">Remove specific text</option>
          <option value="check-text">Check text</option>
        </select>

        {ai.showRemoveTextInput && selectedLayer && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <input
              className="ed-input"
              type="text"
              placeholder="Text to remove…"
              value={ai.removeTextQuery}
              onChange={(e) => ai.setRemoveTextQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ai.removeTextQuery.trim() && !ai.loading) {
                  onRunAiAction('remove-specific-text', ai.removeTextQuery.trim());
                }
              }}
              disabled={ai.loading}
              autoFocus
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            />
            <button
              type="button"
              onClick={() => {
                if (ai.removeTextQuery.trim() && !ai.loading) onRunAiAction('remove-specific-text', ai.removeTextQuery.trim());
              }}
              disabled={!ai.removeTextQuery.trim() || ai.loading}
              style={{
                border: 'none', borderRadius: 8, padding: '0 12px', flex: 'none',
                background: !ai.removeTextQuery.trim() || ai.loading ? C.disabled : C.accent,
                color: '#fff', fontSize: 12.5, fontWeight: 600, fontFamily: FONT_STACK,
                cursor: !ai.removeTextQuery.trim() || ai.loading ? 'default' : 'pointer',
              }}
            >
              Remove
            </button>
          </div>
        )}

        {ai.textCheckResult && (
          <div
            style={{
              marginTop: 8, padding: '9px 10px', borderRadius: 9,
              border: `1px solid ${C.borderRow}`, background: C.rowHover,
            }}
          >
            {ai.textCheckResult.heading ? (
              <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: C.textPrimary, lineHeight: 1.4 }}>
                {ai.textCheckResult.heading}
              </p>
            ) : (
              <p style={{ margin: 0, fontSize: 11, fontStyle: 'italic', color: C.textFaint }}>No heading detected</p>
            )}
            {ai.textCheckResult.subheading && (
              <p style={{ margin: '2px 0 0', fontSize: 11.5, color: C.textMuted, lineHeight: 1.4 }}>
                {ai.textCheckResult.subheading}
              </p>
            )}
          </div>
        )}

        {ai.error && (
          <p style={{ margin: '8px 0 0', fontSize: 11, color: C.dangerText, lineHeight: 1.4, wordBreak: 'break-word' }}>
            {ai.error}
          </p>
        )}

        {ai.fontSuggestion && (
          <div style={{ marginTop: 8 }}>
            <p style={{ margin: '0 0 6px', fontSize: 11.5, color: C.textMuted, lineHeight: 1.45 }}>{ai.fontSuggestion}</p>
            {ai.suggestedFontName && (
              <button
                type="button"
                onClick={() => onUseSuggestedFont(ai.suggestedFontName!)}
                style={secondaryButton(false)}
              >
                Use “{ai.suggestedFontName}”
              </button>
            )}
          </div>
        )}
      </div>

      {/* Taxonomy */}
      <div style={sectionStyle}>
        <button
          type="button"
          className="ed-ghost"
          onClick={() => taxonomy.setOpen((o) => !o)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 6,
            border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
          }}
        >
          <span style={{ ...sectionLabelStyle, flex: 1, textAlign: 'left' }}>Taxonomy</span>
          {taxonomy.loading ? spinner : (
            <span style={{ fontSize: 10, color: C.disabled }}>{taxonomy.open ? '▲' : '▼'}</span>
          )}
        </button>

        {taxonomy.open && (
          <div style={{ marginTop: 8, maxHeight: 176, overflowY: 'auto' }} className="ed-scroll">
            {taxonomy.loading && (
              <span style={{ fontSize: 11.5, color: C.textFaint }}>Analysing…</span>
            )}
            {!taxonomy.loading && taxonomy.data === null && (
              <button
                type="button"
                onClick={onRunTaxonomy}
                style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', fontSize: 12, color: C.accent, fontFamily: FONT_STACK }}
                className="ed-link"
              >
                Analyse structure →
              </button>
            )}
            {taxonomy.data && taxonomy.data.length === 0 && (
              <p style={{ margin: 0, fontSize: 11.5, fontStyle: 'italic', color: C.textFaint }}>
                Could not analyse structure
              </p>
            )}
            {taxonomy.data?.map((group, i) => (
              <div key={`${group.type}-${i}`} style={{ marginBottom: 8 }}>
                <span
                  style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: '.5px', textTransform: 'uppercase',
                    color: TAXONOMY_COLOURS[group.type.toLowerCase()] ?? C.textSecondary,
                  }}
                >
                  {group.type}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                  {group.elements.map((desc, j) => (
                    <span key={j} style={{ fontSize: 11.5, color: C.textMuted, lineHeight: 1.4 }}>{desc}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});
