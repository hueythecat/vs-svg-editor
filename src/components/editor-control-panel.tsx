import React, { Dispatch, RefObject, SetStateAction } from 'react';

import type { SelectedTextProps, SvgLayer } from '@/lib/svg-utils';
import { C, FONT_STACK, SHADOW } from '@/lib/design-tokens';
import { useT } from '@/i18n/provider';
import type { DocBundle, TextLayerAttrs } from './editor-types';
import { ToolsTab, TextTab } from './editor-inspector';
import { LayersTab } from './editor-layers-panel';

// One floating control panel, top-right, holding what used to be two separate floating
// panels — the inspector and the elements list — behind three folder tabs
// (assets/UI/design_handoff_tabbed_panel). The handoff is a guide to the *shell*: the
// tab treatment, the card and the auto-follow behaviour. What sits inside each tab is
// this editor's existing panels, not the prototype's controls, so nothing the app could
// already do was traded for the layout.
//
// Only one tab is mounted at a time, which is also why the card's height follows its
// content: a short tab gives a short card.

export type ControlTab = 'tools' | 'text' | 'layers';

const TAB_KEYS: ReadonlyArray<[ControlTab, string]> = [
  ['tools', 'panel.tabTools'],
  ['text', 'panel.tabText'],
  ['layers', 'panel.tabLayers'],
];

// Folder-tab, not a pill: the active tab is a lidless box that merges into the body by
// painting its bottom border the surface colour over the divider below the row.
function tabStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    background: active ? C.surface : 'transparent',
    border: `1px solid ${active ? C.borderPanel : 'transparent'}`,
    borderBottomColor: active ? C.surface : 'transparent',
    borderRadius: '8px 8px 0 0',
    padding: '9px 4px',
    fontSize: 12,
    fontFamily: FONT_STACK,
    fontWeight: active ? 700 : 500,
    color: active ? C.textPrimary : C.textFaint,
    cursor: 'pointer',
    position: 'relative',
    zIndex: 1,
  };
}

export const EditorControlPanel = React.memo(function EditorControlPanel({
  tab, onSelectTab,
  // Tools
  doc, selectedLayer, selectedLayerName, isBackground, layerColors,
  onReplaceColor, onEndColorEdit, onDeselect,
  // Text
  textProps, textContentRef, usedFonts, extraFonts, onUpdateTextLayer, onAddTextLayer,
  // Layers
  layers, hiddenLayers, selectedLayers, backgroundLayerId, textLayerIds, expandableLayerIds,
  hiddenInsideCounts, drillLabel, drillMarks, onBackOut, onReorderLayers,
  onSetSelectedLayers, onSetSelectedLayer, onSelectOne,
  onToggleLayer, onDuplicateLayer, onDeleteLayer, onExpandLayer,
}: {
  tab: ControlTab;
  onSelectTab: (tab: ControlTab) => void;

  doc: DocBundle;
  selectedLayer: string | null;
  selectedLayerName: string;
  isBackground: boolean;
  layerColors: string[];
  onReplaceColor: (from: string, to: string) => void;
  onEndColorEdit: () => void;
  onDeselect: () => void;

  // The selected text layer's attributes, or the draft for the next one — the Text tab
  // is always live, so this is never null.
  textProps: SelectedTextProps;
  textContentRef: RefObject<HTMLInputElement | null>;
  usedFonts: string[];
  extraFonts: string[];
  onUpdateTextLayer: (attrs: Partial<TextLayerAttrs>) => void;
  onAddTextLayer: () => void;

  layers: SvgLayer[];
  hiddenLayers: Set<string>;
  selectedLayers: Set<string>;
  backgroundLayerId: string | null;
  textLayerIds: Set<string>;
  expandableLayerIds: Set<string>;
  hiddenInsideCounts: Map<string, number>;
  drillLabel: string | null;
  drillMarks: ReadonlyMap<string, 'inside' | 'outer'>;
  onBackOut: () => void;
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

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        width: 272,
        zIndex: 15,
        maxHeight: 'calc(100vh - 32px)',
        // Height follows content: the body is `flex:0 1 auto` so a short tab gives a
        // short card, and only overflow scrolls.
        display: 'flex',
        flexDirection: 'column',
        background: C.surface,
        border: `1px solid ${C.borderPanel}`,
        borderRadius: 12,
        boxShadow: SHADOW.inspector,
        overflow: 'hidden',
        fontFamily: FONT_STACK,
      }}
    >
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, padding: '12px 12px 0', flex: 'none' }}>
        {TAB_KEYS.map(([key, labelKey]) => (
          <button
            key={key}
            type="button"
            // Only the inactive tabs take the hover tint — the active one is already
            // the surface colour, and tinting it would read as un-selecting it.
            className={tab === key ? undefined : 'ed-ghost'}
            onClick={() => onSelectTab(key)}
            style={tabStyle(tab === key)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      {/* Divider the active tab sits over, merging it into the body below. */}
      <div style={{ height: 1, background: C.borderPanel, marginTop: -1, flex: 'none' }} />

      {/* Body. The Layers tab scrolls its own list, so it gets the box unpadded and
          unscrolled — nesting two scrollers there would trap the drag-to-reorder
          auto-scroll inside the outer one. */}
      {tab === 'layers' ? (
        <LayersTab
          layers={layers}
          hiddenLayers={hiddenLayers}
          selectedLayers={selectedLayers}
          backgroundLayerId={backgroundLayerId}
          textLayerIds={textLayerIds}
          expandableLayerIds={expandableLayerIds}
          hiddenInsideCounts={hiddenInsideCounts}
          drillLabel={drillLabel}
          drillMarks={drillMarks}
          onBackOut={onBackOut}
          onAddTextLayer={onAddTextLayer}
          onReorderLayers={onReorderLayers}
          onSetSelectedLayers={onSetSelectedLayers}
          onSetSelectedLayer={onSetSelectedLayer}
          onSelectOne={onSelectOne}
          onToggleLayer={onToggleLayer}
          onDuplicateLayer={onDuplicateLayer}
          onDeleteLayer={onDeleteLayer}
          onExpandLayer={onExpandLayer}
        />
      ) : (
        <div
          className="ed-scroll"
          style={{
            flex: '0 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            // Deliberate: removes a stray horizontal scrollbar the full-width inputs
            // and swatch rows could induce.
            overflowX: 'hidden',
            padding: 14,
          }}
        >
          {tab === 'tools' ? (
            <ToolsTab
              doc={doc}
              selectedLayer={selectedLayer}
              selectedLayerName={selectedLayerName}
              isBackground={isBackground}
              layerColors={layerColors}
              onReplaceColor={onReplaceColor}
              onEndColorEdit={onEndColorEdit}
              onDeselect={onDeselect}
            />
          ) : (
            <TextTab
              textProps={textProps}
              textContentRef={textContentRef}
              usedFonts={usedFonts}
              extraFonts={extraFonts}
              onUpdateTextLayer={onUpdateTextLayer}
              onAddTextLayer={onAddTextLayer}
            />
          )}
        </div>
      )}
    </div>
  );
});
