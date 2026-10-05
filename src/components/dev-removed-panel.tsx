import { useMemo } from 'react';

import { C, FONT_STACK, MONO_STACK, SHADOW } from '@/lib/design-tokens';
import type { RemovedRecord } from './editor-types';
import { ChevronIcon, SettingsIcon } from './svg-icons';

// Dev-only viewfinder for the artwork an AI pass took out.
//
// Bringing it BACK is not this panel's job: every outermost hidden element also gets a
// layer row in the elements panel, switched off, so restoring is the ordinary eye toggle
// on an ordinary row and needs no dev surface at all. What the elements panel cannot do
// is show you a hidden thing without committing to it — the eye is on/off, and a row
// named "path (hidden)" tells you nothing about which part of the drawing it is.
//
// So this is a list you hover: point at an entry and it appears in place, outlined, for
// as long as you stay on it. That is the whole feature.
//
// Deliberately dark, like the downloads rail, so it never reads as product UI, and gated
// by SHOW_DEV_UI at the call site. Nothing here ships.
//
// Grouped by which text row claimed each element. An element no row claimed was called
// text by the bulk pass and vouched for by nothing, which is what a bad answer produces
// in bulk — those sort to the top under "Unmatched", because they are the ones worth
// looking at.

const UNMATCHED = ' unmatched'; // sorts before any real row content

export function DevRemovedPanel({
  records, previewId, open, onSetOpen, onPreview,
}: {
  records: RemovedRecord[];
  previewId: string | null;
  open: boolean;
  onSetOpen: (open: boolean) => void;
  // null clears the preview — the panel calls it on mouse leave.
  onPreview: (id: string | null) => void;
}) {
  // Only the OUTERMOST hidden elements get a row. A pass takes a <g> and its children
  // alike, so listing every record means listing the same piece of artwork many times
  // over — on one sample, 49 rows for 3 actual chunks. Each root carries the count of
  // what it covers, and hovering it previews the whole subtree.
  const { groups, roots } = useMemo(() => {
    const known = new Set(records.map((r) => r.id));
    const rootRecords = records.filter((r) => !r.parentId || !known.has(r.parentId));
    const descendants = new Map<string, number>();
    const rootOf = (r: RemovedRecord): string => {
      let cur = r;
      const seen = new Set<string>();
      while (cur.parentId && known.has(cur.parentId) && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = records.find((x) => x.id === cur.parentId) ?? cur;
      }
      return cur.id;
    };
    for (const r of records) {
      const root = rootOf(r);
      if (root !== r.id) descendants.set(root, (descendants.get(root) ?? 0) + 1);
    }
    const byRow = new Map<string, { record: RemovedRecord; covers: number }[]>();
    for (const r of rootRecords) {
      const key = r.claimedBy || UNMATCHED;
      const entry = { record: r, covers: descendants.get(r.id) ?? 0 };
      const list = byRow.get(key);
      if (list) list.push(entry); else byRow.set(key, [entry]);
    }
    return {
      groups: [...byRow.entries()].sort(([a], [b]) => a.localeCompare(b)),
      roots: rootRecords,
    };
  }, [records]);

  if (records.length === 0) return null;

  const unmatchedCount = roots.filter((r) => !r.claimedBy).length;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onSetOpen(true)}
        title="Preview the artwork the AI passes took out"
        style={{
          position: 'absolute', bottom: 16, left: 16, zIndex: 30,
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '7px 11px', borderRadius: 999,
          background: C.devSurface, border: 'none', boxShadow: SHADOW.devPill,
          color: C.devAccent, fontSize: 10, fontWeight: 700, letterSpacing: '.6px',
          fontFamily: FONT_STACK, cursor: 'pointer',
        }}
      >
        <SettingsIcon size={11} />
        HIDDEN · {roots.length}
        {unmatchedCount > 0 && (
          <span style={{ color: C.devTextMuted, fontWeight: 600 }}>({unmatchedCount} unmatched)</span>
        )}
      </button>
    );
  }

  return (
    <div
      style={{
        position: 'absolute', bottom: 16, left: 16, zIndex: 30, width: 260,
        maxHeight: '58vh', display: 'flex', flexDirection: 'column',
        background: C.devSurface, borderRadius: 12,
        boxShadow: SHADOW.devPanel, fontFamily: FONT_STACK,
      }}
      // One handler for the whole panel: leaving it must always clear the preview, or a
      // fast exit between two rows leaves an element stranded visible.
      onMouseLeave={() => onPreview(null)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '11px 12px 8px' }}>
        <span style={{ color: C.devAccent, display: 'flex' }}><SettingsIcon size={11} /></span>
        <span style={{ flex: 1, fontSize: 9, fontWeight: 700, letterSpacing: '.6px', color: C.devAccent }}>
          DEV — HIDDEN BY AI ({roots.length} of {records.length})
        </span>
        <button
          type="button"
          onClick={() => onSetOpen(false)}
          title="Collapse"
          style={{ border: 'none', background: 'transparent', color: C.devTextFaint, padding: 0, cursor: 'pointer', display: 'flex' }}
        >
          <ChevronIcon size={12} direction="left" />
        </button>
      </div>

      <p style={{ margin: 0, padding: '0 12px 8px', fontSize: 10, lineHeight: 1.45, color: C.devTextDim }}>
        Hover to show in place. Switch one back on from its row in Elements.
      </p>

      <div style={{ overflowY: 'auto', padding: '0 8px 10px' }}>
        {groups.map(([key, rows]) => {
          const unmatched = key === UNMATCHED;
          return (
            <div key={key} style={{ marginBottom: 8 }}>
              <div
                style={{
                  padding: '4px 4px 3px', fontSize: 9, fontWeight: 700,
                  letterSpacing: '.5px', textTransform: 'uppercase',
                  color: unmatched ? C.devAccent : C.devTextFaint,
                }}
                title={unmatched
                  ? 'No text row claimed these — the most likely to be artwork rather than text'
                  : `Replaced by the text field "${key}"`}
              >
                {unmatched ? `Unmatched · ${rows.length}` : `${key} · ${rows.length}`}
              </div>

              {rows.map(({ record: r, covers }) => (
                <div
                  key={r.id}
                  onMouseEnter={() => onPreview(r.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '4px 6px', borderRadius: 7,
                    background: previewId === r.id ? C.devSurfaceAlt : 'transparent',
                    cursor: 'default',
                  }}
                >
                  <span style={{ fontSize: 10, color: C.devTextMuted, fontFamily: MONO_STACK, minWidth: 46 }}>
                    {r.tag}
                  </span>
                  <span style={{ flex: 1, fontSize: 9, color: C.devTextDim, fontFamily: MONO_STACK }}>
                    {r.box ? `${Math.round(r.box.w)}×${Math.round(r.box.h)}` : 'unmeasured'}
                    {covers > 0 && ` +${covers}`}
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
