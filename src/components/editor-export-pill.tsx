import React from 'react';

import { C, FONT_STACK, SHADOW } from '@/lib/design-tokens';
import { DownloadIcon } from './svg-icons';

// Export, floating bottom-right of the canvas — the corner the AI Customise pill used to
// hold. It swapped places with Customise: the pass is one step inside a session, while
// Export is what ends every session, so Export is the one that earns the standing
// position over the artwork and Customise moved into the Tools tab.
//
// Flat accent rather than the accent gradient: the gradient is Customise's identity and
// stays with it, so keeping the two apart matters more here than matching the shape.
// Its label carries the partial-export count, so the pill sizes to the label.
export const ExportPill = React.memo(function ExportPill({
  label, onExport,
}: {
  label: string;
  onExport: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExport}
      style={{
        position: 'absolute', right: 16, bottom: 16, zIndex: 15,
        display: 'flex', alignItems: 'center', gap: 8,
        border: 'none', background: C.accent, color: '#fff',
        fontSize: 12.5, fontWeight: 700, fontFamily: FONT_STACK,
        padding: '11px 15px', borderRadius: 11,
        boxShadow: SHADOW.aiPill,
        cursor: 'pointer',
      }}
    >
      <DownloadIcon size={13} />
      {label}
    </button>
  );
});
