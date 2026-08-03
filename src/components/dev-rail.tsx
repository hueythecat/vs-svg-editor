import React, { useCallback, useEffect, useState } from 'react';

import { C, FONT_STACK, SHADOW } from '@/lib/design-tokens';
import { clearAiCache, isAiCacheEnabled, setAiCacheEnabled } from '@/lib/ai-cache';
import {
  isIgnoreCooldownPrompt, isIgnoreHasCustomised,
  setIgnoreCooldownPrompt, setIgnoreHasCustomised,
} from '@/lib/dev-flags';
import { ChevronIcon, SettingsIcon } from './svg-icons';

type Sample = { label: string; name: string; src: string; edit?: 0 | 1 };

// What a review-uuid open hands back, so the rail can add a preview card for artwork
// the parent resolved. Exported because the parent builds it — same shape as Sample,
// named for what it is at that end.
export type OpenedSample = Sample;

// Custom drag MIME so a preview dragged onto the canvas can be told apart from an OS
// file drop. The drop handler in svg-drop-zone reads this same key.
export const SAMPLE_DRAG_MIME = 'application/x-svg-sample';

// One row of /api/review/list — the review host's own asset list. Only the fields the
// dropdown needs are typed; the upstream sends more (user_id, cancelled, timestamps…).
type ReviewListItem = {
  id?: number;
  name?: string;
  art_id?: number;
  edit_uuid?: string;
  can_customise?: number;
  has_customised?: number;
};

// One option per artwork. The host currently refuses a second entry for an art id it
// already holds — that's the message: "failed" the id box tolerates — but the dropdown
// shouldn't depend on it: two rows for one art_id would list the same artwork twice
// under different uuids, and picking either would be a coin toss on which is current.
// The newest row wins, decided by the row id rather than array position so it doesn't
// rest on the order the host happens to send. Rows sharing a uuid collapse too — those
// are the same entry outright, and would collide as React keys.
const dedupeReviewList = (rows: ReviewListItem[]): ReviewListItem[] => {
  const newest = new Map<string, ReviewListItem>();
  for (const row of rows) {
    // art_id is the identity; fall back to the uuid so a row missing one still stands
    // on its own rather than every such row folding into a single entry.
    const key = row.art_id != null ? `art:${row.art_id}` : `uuid:${row.edit_uuid}`;
    const held = newest.get(key);
    if (!held || (row.id ?? 0) > (held.id ?? 0)) newest.set(key, row);
  }
  const seenUuid = new Set<string>();
  return [...newest.values()].filter((r) => {
    if (seenUuid.has(r.edit_uuid!)) return false;
    seenUuid.add(r.edit_uuid!);
    return true;
  });
};

// The internal/dev affordance from the handoff §1.4 — deliberately dark so it never
// reads as user UI, collapsing to a small pill at the top-left of the canvas.

interface DevRailProps<S extends Sample> {
  samples: ReadonlyArray<S>;
  activeSample: string | null;
  isLoading: boolean;
  // Expanded state is owned by the parent so it can collapse the rail once artwork
  // lands on the canvas — including for loads the rail didn't start (file drop, browse).
  open: boolean;
  onSetOpen: (open: boolean) => void;
  onOpenSample: (sample: S) => void;
  // Opens a download that was fetched and extracted at runtime (src is a data: URI).
  onOpenFetched?: (sample: Sample) => void;
  // Opens a review asset by uuid — the same path the /<uuid> deep link takes, check
  // call and cooldown included. The dropdown's selection action. Resolves with the
  // sample it opened (null if nothing loaded) so the rail can preview it.
  onOpenReviewUuid?: (uuid: string) => Promise<OpenedSample | null>;
}

export function DevRail<S extends Sample>({
  samples, activeSample, isLoading, open, onSetOpen, onOpenSample, onOpenFetched,
  onOpenReviewUuid,
}: DevRailProps<S>) {
  const [selectedDownload, setSelectedDownload] = useState<string>('');
  const [reviewList, setReviewList] = useState<ReviewListItem[]>([]);
  const [listStatus, setListStatus] = useState<string | null>('Loading…');
  const [reviewId, setReviewId] = useState('');
  const [fetchStatus, setFetchStatus] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchedSamples, setFetchedSamples] = useState<Sample[]>([]);
  // Mirrors the persisted preference. Nothing else re-renders off it — the AI passes ask
  // the cache module directly at call time — so it stays local to the rail. Lazy initial
  // state: reading storage during SSR would throw, and this only ever renders client-side.
  const [cacheOn, setCacheOn] = useState(() => isAiCacheEnabled());
  // Same arrangement for the has_customised override: local mirror of the persisted
  // preference, which the review load path reads directly at call time.
  const [ignoreCustomised, setIgnoreCustomised] = useState(() => isIgnoreHasCustomised());
  const [ignoreCooldown, setIgnoreCooldown] = useState(() => isIgnoreCooldownPrompt());

  // The dropdown's contents come from the review host, not a hardcoded list, so it
  // always reflects what's actually there to open. Fetched once the rail is expanded —
  // no point calling while it's a collapsed pill — and once only, since a re-open
  // shouldn't re-request.
  // Returns the rows as well as storing them: the id box needs to search the refreshed
  // list straight away, and the state set here isn't readable until the next render.
  const loadList = useCallback(async (): Promise<ReviewListItem[]> => {
    try {
      const res = await fetch('/api/review/list');
      const data = (await res.json()) as {
        message?: string; uuids?: ReviewListItem[]; error?: { message?: string };
      };
      console.log(`[review/list] -> ${res.status}`, data);
      if (!res.ok || data.message !== 'success' || !Array.isArray(data.uuids)) {
        setListStatus(data.error?.message ?? `List failed (${res.status})`);
        return [];
      }
      // Only rows carrying a uuid are selectable — the uuid is the whole point.
      const items = dedupeReviewList(data.uuids.filter((u) => !!u.edit_uuid));
      if (items.length !== data.uuids.length) {
        console.log(`[review/list] ${data.uuids.length} row(s) -> ${items.length} option(s) after de-dupe`);
      }
      setReviewList(items);
      setListStatus(items.length ? null : 'No review assets');
      return items;
    } catch (err) {
      setListStatus(err instanceof Error ? err.message : 'List failed');
      return [];
    }
  }, []);

  const listLoadedRef = React.useRef(false);
  useEffect(() => {
    if (!open || listLoadedRef.current) return;
    listLoadedRef.current = true;
    void loadList();
  }, [open, loadList]);

  // Picking from the list dropdown. The parent owns the open — it runs the same check /
  // download / cooldown path as a /<uuid> deep link — and hands back what it opened, so
  // the asset also lands in the previews below, exactly like an id-box fetch. De-duped
  // by name so re-selecting refreshes its card rather than stacking duplicates.
  const openFromList = useCallback(async (uuid: string) => {
    const sample = await onOpenReviewUuid?.(uuid);
    if (!sample) return;
    setFetchedSamples((prev) => [sample, ...prev.filter((s) => s.name !== sample.name)]);
  }, [onOpenReviewUuid]);

  // The id box registers a vectorstock art id for review rather than pulling artwork
  // straight down: /api/review/test/<id> makes the host create an entry for it, which
  // gives it an edit_uuid and puts it in the list. So the list is refreshed and the new
  // row opened through the normal uuid path — the id box ends up somewhere identical to
  // picking from the dropdown, instead of a parallel way to get artwork on the canvas.
  //
  // An id the host already knows answers message: "failed". That isn't an error worth
  // reporting: its row is in the list either way, so the refreshed list — not the
  // message — decides whether there's something to open.
  const fetchReview = async () => {
    const id = reviewId.trim();
    if (!id) return;
    if (!/^\d+$/.test(id)) {
      setFetchStatus('Numbers only');
      return;
    }

    setFetchStatus(null);
    setFetching(true);
    try {
      // Same placeholder pacing as before: hold the overlay for at least 1s so the
      // request reads as a deliberate step rather than an instant flash.
      const [res] = await Promise.all([
        fetch(`/api/review/test/${id}`),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
      const data = (await res.json()) as { message?: string; error?: { message?: string } };
      console.log(`[review/test] ${id} -> ${res.status}`, data);
      if (!res.ok) {
        setFetchStatus(data.error?.message ?? `Request failed (${res.status})`);
        return;
      }

      const items = await loadList();
      const match = items.find((u) => String(u.art_id) === id);
      if (!match?.edit_uuid) {
        setFetchStatus(data.message === 'success' ? 'Registered, but not in the list' : 'Unknown id');
        return;
      }

      setSelectedDownload(match.edit_uuid);
      // Clear only once there's something to open — a failed id stays put to be
      // corrected, rather than the next id typed being appended to it.
      setReviewId('');
      await openFromList(match.edit_uuid);
    } catch (err) {
      setFetchStatus(err instanceof Error ? err.message : 'Fetch failed');
    } finally {
      setFetching(false);
    }
  };

  // There's an id to send and nothing already in flight — drives the FETCH button's
  // active styling, and matches its disabled condition so the two can't disagree.
  const armed = !fetching && reviewId.trim().length > 0;

  // The previews are two lists sharing one strip: assets fetched this session on top,
  // the bundled samples under them. A bundled sample whose file name matches a fetched
  // one is the same artwork — several bundled ids are registered on the review host —
  // so it would sit there as a second card for the same thing, both lit as active.
  // The fetched copy wins: it's the live asset, carrying its own edit flag and whatever
  // the host holds now, where the bundled file is a fixed snapshot.
  const fetchedNames = new Set(fetchedSamples.map((s) => s.name));
  const staticSamples = samples.filter((s) => !fetchedNames.has(s.name));

  const renderCard =(sample: Sample, onOpen: () => void) => {
    const isActive = activeSample === sample.name;
    return (
      <button
        key={sample.name}
        type="button"
        onClick={onOpen}
        disabled={isLoading}
        // Dragging the preview onto the canvas opens it. draggable sits on the button
        // so the whole tile is the drag handle; the payload is read back in handleDrop.
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(SAMPLE_DRAG_MIME, JSON.stringify(sample));
          e.dataTransfer.effectAllowed = 'copy';
        }}
        className="ed-dev-card"
        style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          padding: 5, borderRadius: 8, textAlign: 'left',
          background: C.devSurfaceAlt,
          border: isActive ? `1.5px solid ${C.accent}` : '1.5px solid transparent',
          cursor: isLoading ? 'wait' : 'pointer',
          opacity: isLoading ? 0.5 : 1,
          fontFamily: FONT_STACK,
        }}
      >
        <span
          style={{
            // Square frame (rather than a short fixed height) so contain-fitted art
            // scales up to the full card width instead of being pinned to a 48px height.
            width: '100%', aspectRatio: '1 / 1', borderRadius: 5, overflow: 'hidden',
            background: 'repeating-linear-gradient(45deg, #2b3038 0 4px, #22262e 4px 8px)',
            display: 'block',
          }}
        >
          <img
            src={sample.src}
            alt={sample.label}
            // Suppress the native image drag so only the button's drag fires (carrying
            // our custom payload rather than the image URL).
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: 'contain', padding: 2, boxSizing: 'border-box' }}
          />
        </span>
        <span
          style={{
            fontSize: 10, lineHeight: 1.2,
            color: isActive ? '#8f9bff' : C.devTextMuted,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {sample.label}
        </span>
      </button>
    );
  };

  return (
    <>
      {/* Full-viewport "Fetching asset" overlay shown while a download is being pulled. */}
      {fetching && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
            background: 'rgba(16,19,24,.46)', backdropFilter: 'blur(2px)',
          }}
        >
          <div
            style={{
              width: 34, height: 34, borderRadius: '50%',
              border: `3px solid ${C.borderInput}`, borderTopColor: C.accent,
              animation: 'ed-spin .8s linear infinite',
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 600, color: '#fff', fontFamily: FONT_STACK }}>Fetching asset…</span>
        </div>
      )}

      {open ? (
        <div
          style={{
            position: 'absolute', top: 16, left: 16, zIndex: 30, width: 198,
            background: C.devSurface, borderRadius: 12,
            boxShadow: SHADOW.devPanel,
            fontFamily: FONT_STACK,
          }}
        >
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '11px 12px 8px' }}>
            <span style={{ color: C.devAccent, display: 'flex' }}><SettingsIcon size={11} /></span>
            <span style={{ flex: 1, fontSize: 9, fontWeight: 700, letterSpacing: '.6px', color: C.devAccent }}>
              DEV — DOWNLOADS
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

          {/* Review assets select — populated from /api/review/list. Picking one runs
              the same path as opening the app at /<uuid>, so what the dropdown does and
              what a deep link does can't drift apart. */}
          <div style={{ padding: '0 12px 10px' }}>
            <select
              value={selectedDownload}
              disabled={isLoading || reviewList.length === 0}
              onChange={(e) => {
                const uuid = e.target.value;
                setSelectedDownload(uuid);
                if (uuid) void openFromList(uuid);
              }}
              style={{
                width: '100%', boxSizing: 'border-box',
                background: C.devSurfaceAlt, color: C.devText,
                border: `1px solid ${C.devBorder}`, borderRadius: 7,
                fontSize: 11, padding: '6px 7px', outline: 'none', cursor: 'pointer',
                fontFamily: FONT_STACK,
              }}
            >
              <option value="">{listStatus ?? 'Select a vector…'}</option>
              {reviewList.map((item) => (
                <option key={item.edit_uuid} value={item.edit_uuid}>
                  {item.art_id} — {item.name}
                </option>
              ))}
            </select>
            {/* Review id — anything on the review host (API_HOST), not just the bundled zips.
                Enter submits so an id can be pasted and fired without reaching for the
                button. */}
            <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={reviewId}
                placeholder="Review id…"
                disabled={fetching}
                onChange={(e) => setReviewId(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') fetchReview();
                }}
                style={{
                  flex: 1, minWidth: 0, boxSizing: 'border-box',
                  background: C.devSurfaceAlt, color: C.devText,
                  border: `1px solid ${C.devBorder}`, borderRadius: 7,
                  fontSize: 11, padding: '6px 7px', outline: 'none',
                  fontFamily: FONT_STACK,
                }}
              />
              {/* Lights up as soon as there's an id to send — the accent fill is the
                  cue that Enter/click will now do something, versus the flat dim state
                  when the box is empty or a fetch is already running. */}
              <button
                type="button"
                onClick={fetchReview}
                disabled={!armed}
                title="Fetch this id from the review endpoint"
                style={{
                  border: `1px solid ${armed ? C.accent : C.devBorder}`,
                  background: armed ? C.accent : C.devSurfaceAlt,
                  color: armed ? '#fff' : C.devTextDim,
                  borderRadius: 7, padding: '3px 8px',
                  fontSize: 9, fontWeight: 700, letterSpacing: '.4px',
                  cursor: armed ? 'pointer' : 'default',
                  opacity: armed ? 1 : 0.45,
                  fontFamily: FONT_STACK, flex: 'none',
                  transition: 'background .12s, border-color .12s, color .12s, opacity .12s',
                }}
              >
                FETCH
              </button>
            </div>
            {fetchStatus && (
              <span style={{ display: 'block', marginTop: 5, fontSize: 10, color: C.devTextMuted, lineHeight: 1.3 }}>
                {fetchStatus}
              </span>
            )}
          </div>

          {/* AI response cache — a customise/strip run is ~10s and a paid call, so this
              is on by default and only turned off to force a genuine request. */}
          <div style={{ padding: '0 12px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <label
              title="Reuse the stored AI response when the same artwork is run again"
              style={{
                flex: 1, display: 'flex', alignItems: 'center', gap: 7,
                fontSize: 10, color: C.devTextMuted, cursor: 'pointer', userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={cacheOn}
                onChange={(e) => {
                  setCacheOn(e.target.checked);
                  setAiCacheEnabled(e.target.checked);
                }}
                style={{ accentColor: C.accent, width: 12, height: 12, margin: 0, cursor: 'pointer', flex: 'none' }}
              />
              Cache AI responses
            </label>
            <button
              type="button"
              onClick={clearAiCache}
              title="Drop every stored AI response"
              style={{
                border: `1px solid ${C.devBorder}`, background: C.devSurfaceAlt,
                color: C.devTextDim, borderRadius: 6, padding: '3px 7px',
                fontSize: 9, fontWeight: 700, letterSpacing: '.4px',
                cursor: 'pointer', fontFamily: FONT_STACK, flex: 'none',
              }}
            >
              CLEAR
            </button>
          </div>

          {/* has_customised override — the real cooldown is a 24h lockout, so one live
              customise run would otherwise retire an asset for the day. */}
          <div style={{ padding: '0 12px 10px' }}>
            <label
              title="Treat every asset as never customised — no cooldown is recorded on load"
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                fontSize: 10, color: C.devTextMuted, cursor: 'pointer', userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={ignoreCustomised}
                onChange={(e) => {
                  setIgnoreCustomised(e.target.checked);
                  setIgnoreHasCustomised(e.target.checked);
                }}
                style={{ accentColor: C.accent, width: 12, height: 12, margin: 0, cursor: 'pointer', flex: 'none' }}
              />
              Ignore has_customised
            </label>

            <label
              title="Run the customise pass even when the asset is inside its cooldown"
              style={{
                display: 'flex', alignItems: 'center', gap: 7, marginTop: 7,
                fontSize: 10, color: C.devTextMuted, cursor: 'pointer', userSelect: 'none',
              }}
            >
              <input
                type="checkbox"
                checked={ignoreCooldown}
                onChange={(e) => {
                  setIgnoreCooldown(e.target.checked);
                  setIgnoreCooldownPrompt(e.target.checked);
                }}
                style={{ accentColor: C.accent, width: 12, height: 12, margin: 0, cursor: 'pointer', flex: 'none' }}
              />
              Ignore cooldown prompt
            </label>
          </div>

          {/* Samples */}
          <div style={{ padding: '0 12px 4px' }}>
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.6px', color: C.devTextDim }}>SAMPLES</span>
          </div>
          <div
            className="ed-scroll"
            style={{
              maxHeight: 360, overflowY: 'auto', overflowX: 'hidden',
              padding: '6px 12px 12px',
              display: 'flex', flexDirection: 'column', gap: 6,
            }}
          >
            {fetchedSamples.map((sample) => renderCard(sample, () => onOpenFetched?.(sample)))}
            {staticSamples.map((sample) => renderCard(sample, () => onOpenSample(sample)))}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onSetOpen(true)}
          title="Dev tools"
          style={{
            position: 'absolute', top: 16, left: 16, zIndex: 30,
            display: 'flex', alignItems: 'center', gap: 6,
            background: C.devSurface, border: 'none', borderRadius: 10,
            padding: '8px 11px', boxShadow: SHADOW.devPill, cursor: 'pointer',
            fontFamily: FONT_STACK,
          }}
        >
          <span style={{ color: C.devAccent, display: 'flex' }}><SettingsIcon size={12} /></span>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.6px', color: C.devTextMuted }}>DEV</span>
          <span style={{ color: C.devTextFaint, display: 'flex' }}><ChevronIcon size={11} direction="right" /></span>
        </button>
      )}
    </>
  );
}
