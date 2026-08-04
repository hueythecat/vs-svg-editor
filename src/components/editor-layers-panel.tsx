import React, { Dispatch, SetStateAction } from 'react';

import type { SvgLayer } from '@/lib/svg-utils';
import { C, FONT_STACK, SHADOW, sectionLabelStyle } from '@/lib/design-tokens';
import { LayerList } from './layer-list';
import { ChevronIcon, PlusIcon } from './svg-icons';

// The floating "ELEMENTS" panel, bottom-left (handoff §1.7): a count header with an
// add-text affordance, over the drag-to-reorder layer list.
export const LayersPanel = React.memo(function LayersPanel({
  layers, hiddenLayers, selectedLayers, backgroundLayerId, textLayerIds, expandableLayerIds,
  canBackOut, onBackOut, onAddTextLayer, onReorderLayers, onSetSelectedLayers, onSetSelectedLayer, onSelectOne,
  onToggleLayer, onDuplicateLayer, onDeleteLayer, onExpandLayer,
}: {
  layers: SvgLayer[];
  hiddenLayers: Set<string>;
  selectedLayers: Set<string>;
  backgroundLayerId: string | null;
  textLayerIds: Set<string>;
  expandableLayerIds: Set<string>;
  canBackOut: boolean;
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
  return (
    <div
      style={{
        position: 'absolute',
        left: 16,
        bottom: 16,
        width: 214,
        zIndex: 15,
        // Bottom-anchored but free to grow upward to just under the toolbar, so a long
        // element list is shown in full instead of being scrolled inside 170px.
        maxHeight: 'calc(100vh - 92px)',
        display: 'flex',
        flexDirection: 'column',
        background: C.surface,
        border: `1px solid ${C.borderPanel}`,
        borderRadius: 12,
        boxShadow: SHADOW.layers,
        fontFamily: FONT_STACK,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '11px 12px 8px', flex: 'none' }}>
        {/* One way out for the whole panel, rather than a control on every row: the list
            is only ever inside one group at a time, so backing out is a property of the
            view, not of any single layer. Absent when nothing has been drilled into. */}
        {canBackOut && (
          <button
            type="button"
            className="ed-ghost"
            onClick={onBackOut}
            title="Back out of this group"
            style={{
              border: 'none', background: 'transparent', color: C.textFaint,
              padding: 0, cursor: 'pointer', display: 'flex', flex: 'none', borderRadius: 6,
            }}
          >
            <ChevronIcon size={12} direction="left" />
          </button>
        )}
        <span style={{ ...sectionLabelStyle, flex: 1 }}>Elements · {layers.length}</span>
        <button
          type="button"
          className="ed-ghost"
          onClick={onAddTextLayer}
          title="Add a text layer"
          style={{
            border: 'none', background: 'transparent', color: C.disabled,
            padding: 0, cursor: 'pointer', display: 'flex', borderRadius: 6,
          }}
        >
          <PlusIcon size={15} />
        </button>
      </div>

      <LayerList
        layers={layers}
        hiddenLayers={hiddenLayers}
        selectedLayers={selectedLayers}
        backgroundLayerId={backgroundLayerId}
        textLayerIds={textLayerIds}
        expandableLayerIds={expandableLayerIds}
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
