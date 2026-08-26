import React, { Dispatch, SetStateAction } from 'react';

import type { SvgLayer } from '@/lib/svg-utils';
import { C, FONT_STACK, sectionLabelStyle } from '@/lib/design-tokens';
import { useT } from '@/i18n/provider';
import { LayerList } from './layer-list';
import { ChevronIcon, PlusIcon } from './svg-icons';

// The Layers tab of the control panel (editor-control-panel.tsx): an "ELEMENTS · n"
// count header with an add-text affordance, over the drag-to-reorder layer list.
//
// This was the floating bottom-left panel; the tabbed handoff folds it into the shared
// card, so it no longer draws its own frame. It still owns the column layout, because
// the list underneath is the one part of the panel that scrolls — the header and the
// breadcrumb stay put while it does.
export const LayersTab = React.memo(function LayersTab({
  layers, hiddenLayers, selectedLayers, backgroundLayerId, textLayerIds, expandableLayerIds,
  hiddenInsideCounts,
  drillLabel, drillMarks, onBackOut, onAddTextLayer, onReorderLayers, onSetSelectedLayers, onSetSelectedLayer, onSelectOne,
  onToggleLayer, onDuplicateLayer, onDeleteLayer, onExpandLayer,
}: {
  layers: SvgLayer[];
  hiddenLayers: Set<string>;
  selectedLayers: Set<string>;
  backgroundLayerId: string | null;
  textLayerIds: Set<string>;
  expandableLayerIds: Set<string>;
  hiddenInsideCounts: Map<string, number>;
  // The group the list is drilled into, and how each row relates to it. Null / empty at
  // the top level, which is what the breadcrumb's presence keys off.
  drillLabel: string | null;
  drillMarks: ReadonlyMap<string, 'inside' | 'outer'>;
  onBackOut: () => void;
  onAddTextLayer: () => void;
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
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        flex: '0 1 auto',
        fontFamily: FONT_STACK,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '11px 12px 8px', flex: 'none' }}>
        <span style={{ ...sectionLabelStyle, flex: 1 }}>{t('layers.heading', { count: layers.length })}</span>
        <button
          type="button"
          className="ed-ghost"
          onClick={onAddTextLayer}
          title={t('layers.addText')}
          style={{
            border: 'none', background: 'transparent', color: C.disabled,
            padding: 0, cursor: 'pointer', display: 'flex', borderRadius: 6,
          }}
        >
          <PlusIcon size={15} />
        </button>
      </div>

      {/* Breadcrumb — the one piece of context for the whole list, and the one way out,
          rather than a control on every row: the list is only ever inside one group at a
          time, so both are properties of the view and not of any single layer. Absent at
          the top level, where there is nothing to be inside of and nowhere to go back to.

          The whole strip is the button, so the target is a readable width rather than a
          12px chevron, and it says which group it leaves — the name it will put back in
          the list on the way out. */}
      {drillLabel !== null && (
        <button
          type="button"
          className="ed-ghost"
          onClick={onBackOut}
          title={t('layers.backOut', { name: drillLabel })}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            margin: '0 8px 6px', padding: '4px 6px',
            border: 'none', borderRadius: 7, background: C.accentTintAlt,
            color: C.textMuted, cursor: 'pointer', textAlign: 'left',
            fontFamily: FONT_STACK, fontSize: 11.5, flex: 'none',
          }}
        >
          <ChevronIcon size={11} direction="left" />
          <span style={{ flex: 'none' }}>{t('layers.inside')}</span>
          <span
            style={{
              flex: 1, minWidth: 0, fontWeight: 600, color: C.accent,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {drillLabel}
          </span>
        </button>
      )}

      <LayerList
        layers={layers}
        marks={drillMarks}
        hiddenLayers={hiddenLayers}
        selectedLayers={selectedLayers}
        backgroundLayerId={backgroundLayerId}
        textLayerIds={textLayerIds}
        expandableLayerIds={expandableLayerIds}
        hiddenInsideCounts={hiddenInsideCounts}
        onExpandLayer={onExpandLayer}
        onReorderLayers={onReorderLayers}
        onSetSelectedLayers={onSetSelectedLayers}
        onSetSelectedLayer={onSetSelectedLayer}
        onSelectOne={onSelectOne}
        onToggleLayer={onToggleLayer}
        onDuplicateLayer={onDuplicateLayer}
        onDeleteLayer={onDeleteLayer}
      />
    </div>
  );
});
