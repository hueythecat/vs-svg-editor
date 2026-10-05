// Opening a review asset by uuid — the /<uuid> deep link and the dev rail's dropdown —
// and everything that follows from it being a review asset: its AI gate, the customise
// cooldown, the per-session cache, and telling the host once it has been customised.
//
// Lifted out of svg-drop-zone as one piece because nothing else in the editor reads any
// of it: the component hands in how to open a sample and where the cooldown is shown,
// and gets back the three things it wires up.
import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from 'react';

import type { OpenedSample } from '@/components/dev-rail';
import { isIgnoreCanCustomise, isIgnoreHasCustomised } from '@/lib/dev-flags';
import {
  type ReviewCheck, cooldownRemaining, formatRemaining, parseCustomiseNext,
} from '@/lib/review-cooldown';

type Options = {
  // The uuid in the URL, if any — opened once on mount.
  reviewUuid?: string;
  // Which review asset is on the canvas. Owned by the component, not here: applyParsed
  // clears it on every load, and this hook is built on top of applyParsed (via
  // openSample), so it can't also be what applyParsed reaches into.
  openReviewUuidRef: RefObject<string | null>;
  openSample: (sample: OpenedSample) => Promise<void> | void;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setCooldownActive: Dispatch<SetStateAction<boolean>>;
  setCooldownUntil: Dispatch<SetStateAction<string | undefined>>;
};

export function useReviewAsset({
  reviewUuid, openReviewUuidRef, openSample, setIsLoading, setCooldownActive, setCooldownUntil,
}: Options) {
  // A uuid identifies a review asset. The check endpoint says what it resolves to —
  // { message: 'success', id, can_edit } — and on a successful answer the numeric id
  // goes through /api/review/<id>, the same download the dev rail's id box uses, and
  // opens like any other sample.
  // can_edit only decides whether the AI/customise pass is allowed: it becomes the
  // asset's `edit` gate, so can_edit: 0 still opens the artwork on the canvas and
  // sends the customise click to the upsell instead.
  // Both responses are logged under [review…] so a load can be traced without reaching
  // for the network tab.
  //
  // A callback rather than effect-only code because two things open a uuid: the
  // /<uuid> path (the effect below) and the dev rail's list dropdown. Both must take
  // this exact route, cooldown and edit gate included — a second implementation would
  // be a second set of rules to keep in sync.
  //
  // Returns the sample it opened so the dev rail can add a preview card for it, the
  // same way its own fetches do — or null when nothing was opened, so a failed
  // selection doesn't leave a card pointing at artwork that never loaded.
  //
  // Reopening a uuid this session replays what was already resolved instead of asking
  // again — the same artwork the preview card shows, so the two can't disagree. The
  // check response is kept rather than the conclusions drawn from it, so the cooldown
  // is re-derived on each replay and the dev toggles still apply. A successful
  // customise drops the entry: the host rewrites the SVG, so the copy held here stops
  // being the artwork.
  const reviewCacheRef = useRef(new Map<string, { sample: OpenedSample; check: ReviewCheck }>());

  // The asset's AI gate. Anything other than can_edit: 1 sends the Customise click to
  // the upsell; the dev toggle opens it as editable instead. Derived rather than stored
  // — asked at call time on both paths — so flipping the toggle changes the next open,
  // including a reopen served from the cache.
  const resolveEdit = useCallback((check: ReviewCheck): 0 | 1 => {
    if (check.can_edit === 1) return 1;
    if (isIgnoreCanCustomise()) {
      console.log(`[review] ${check.id} can_edit=${check.can_edit} — ignored (dev toggle), opening editable`);
      return 1;
    }
    return 0;
  }, []);

  // The cooldown basis remembered from the asset list: the most recent customised_at
  // that wasn't cancelled. Customising one asset puts them all on cooldown, so this is
  // a single account-level moment rather than anything per asset. Null until the list
  // has loaded — a /<uuid> deep link may never load it, and there's no list at all in
  // a production build, so the check response stays the fallback.
  const [listCooldown, setListCooldown] =
    useState<{ lastCustomised: number | null; cooldownHours: number } | null>(null);

  const onReviewListLoaded = useCallback(
    (info: { lastCustomised: number | null; cooldownHours: number }) => {
      console.log(
        '[review/list] cooldown basis:',
        info.lastCustomised ? new Date(info.lastCustomised).toISOString() : 'none',
        `(${info.cooldownHours}h)`,
      );
      setListCooldown(info);
    },
    [],
  );

  // Applied on both paths (fresh check and cache replay), so an asset's cooldown reads
  // the same however it was opened.
  const applyCooldown = useCallback((check: ReviewCheck) => {
    // Asked at call time, not captured in a dep: flipping the toggle applies to the
    // next asset opened without this callback having to be rebuilt.
    if (isIgnoreHasCustomised()) {
      console.log(`[review] ${check.id} cooldown ignored (dev toggle)`);
      return;
    }

    // Prefer the list's account-level moment. It's the more reliable of the two: the
    // host's own customise_next doesn't move when an already-customised asset is
    // customised again, so it can report a window that has long expired.
    if (listCooldown) {
      // cooldownRemaining measures against the moment it unlocks, so turn the moment it
      // was customised into that: last customise + the cooldown window.
      const { lastCustomised, cooldownHours } = listCooldown;
      const unlocksAt =
        lastCustomised === null ? null : lastCustomised + cooldownHours * 3_600_000;
      const left = cooldownRemaining(unlocksAt, cooldownHours);
      console.log(
        `[review] ${check.id} last customise (any asset) ${
          lastCustomised ? new Date(lastCustomised).toISOString() : 'none'
        } ->`,
        left === null ? 'no cooldown' : `${Math.round(left / 60_000)} min left`,
      );
      if (left !== null) {
        setCooldownUntil(formatRemaining(left));
        setCooldownActive(true);
      }
      return;
    }

    if (check.has_customised !== 1) return;
    const left = cooldownRemaining(
      parseCustomiseNext(check.customise_next),
      check.cooldown_hours ?? 24,
    );
    console.log(
      `[review] ${check.id} has_customised=1 customise_next=${check.customise_next} ->`,
      left === null ? 'cooldown expired' : `${Math.round(left / 60_000)} min left`,
    );
    if (left !== null) {
      setCooldownUntil(formatRemaining(left));
      setCooldownActive(true);
    }
  }, [listCooldown]);

  const openReviewUuid = useCallback(async (uuid: string): Promise<OpenedSample | null> => {
    // Already resolved this session — reopen from what's held rather than repeating the
    // check and download. applyParsed clears the cooldown as part of loading, so the
    // cooldown is re-applied after, exactly as the fresh path does.
    const cached = reviewCacheRef.current.get(uuid);
    if (cached) {
      console.log(`[review] ${uuid} — reopening from cache, no requests made`);
      setIsLoading(true);
      // Re-derive the gate rather than replaying the stored one, so flipping the dev
      // toggle takes effect on a cached asset too.
      const sample = { ...cached.sample, edit: resolveEdit(cached.check) };
      await openSample(sample);
      openReviewUuidRef.current = uuid;
      applyCooldown(cached.check);
      return sample;
    }

    // Hold the loading state across both requests so the drop zone doesn't flash up
    // in between — opening an asset should look like it's opening artwork from the start.
    setIsLoading(true);
    try {
      const res = await fetch(`/api/review/check/${uuid}`, { method: 'POST' });
      const check = (await res.json()) as ReviewCheck;
      console.log(`[review/check] ${uuid} -> ${res.status}`, check);

      if (!res.ok || check.message !== 'success' || !check.id) {
        console.log('[review] check unsuccessful — nothing to load');
        setIsLoading(false);
        return null;
      }
      // An asset that has been customised has had its SVG rewritten upstream, so a
      // cached copy is the wrong artwork rather than merely a stale one. `fresh=1`
      // makes the proxy bypass its caches, and cache: 'reload' does the same for this
      // request, so re-selecting a customised asset always shows what's there now.
      // The dev toggle only suppresses the cooldown, never this: whatever the host
      // holds is still the artwork to open.
      const customised = check.has_customised === 1;
      const dl = await fetch(
        `/api/review/${check.id}${customised ? '?fresh=1' : ''}`,
        customised ? { cache: 'reload' } : undefined,
      );
      const data = (await dl.json()) as { svg?: string | null; error?: { message?: string } };
      console.log(
        `[review/download] ${check.id}${customised ? ' (fresh)' : ''} -> ${dl.status}`,
        data.svg ? `${data.svg.length} chars of SVG` : data,
      );

      if (!dl.ok || !data.svg) {
        setIsLoading(false);
        return null;
      }

      // Same hand-off as the dev rail: inline the SVG as a data: URI so openSample
      // can re-read it with fetch().text(), exactly like a static sample src.
      const edit = resolveEdit(check);
      console.log(`[review] ${check.id} opening with edit=${edit} (can_edit=${check.can_edit})`);
      const sample: OpenedSample = {
        label: `Review ${check.id}`,
        name: `vectorstock_${check.id}.svg`,
        src: `data:image/svg+xml,${encodeURIComponent(data.svg)}`,
        edit,
      };
      await openSample(sample);
      openReviewUuidRef.current = uuid;
      reviewCacheRef.current.set(uuid, { sample, check });

      // Record the cooldown, don't announce it. Opening an asset isn't the moment to
      // interrupt with a restriction on an action nobody has asked for yet — the
      // message belongs to the Customise click, which is where runCustomise raises it.
      applyCooldown(check);
      return sample;
    } catch (err) {
      console.log(`[review] ${uuid} failed:`, err);
      setIsLoading(false);
      return null;
    }
  }, [openSample, applyCooldown, resolveEdit]);

  const reviewLoadedRef = useRef<string | null>(null);

  useEffect(() => {
    // The ref makes this once-per-uuid: an effect re-run (StrictMode's double mount,
    // a re-render changing openReviewUuid) must not fire the requests again.
    if (!reviewUuid || reviewLoadedRef.current === reviewUuid) return;
    reviewLoadedRef.current = reviewUuid;
    void openReviewUuid(reviewUuid);
  }, [reviewUuid, openReviewUuid]);

  // Tell the review host the asset has been customised, once the pass has actually
  // succeeded. Only meaningful for a /<uuid> deep link — a dropped file or a sample has
  // no uuid to report against. Fire-and-forget and self-contained: the artwork on the
  // canvas is already correct, so a failed notification must not surface as a failed
  // customise. Logged under [review/customised] like the other review calls.
  const notifyCustomised = useCallback(async () => {
    // The uuid of whatever is on the canvas, not the one in the URL: an asset opened
    // from the dev rail's dropdown has no uuid in the path, and keying off `reviewUuid`
    // meant those runs silently notified nothing.
    const uuid = openReviewUuidRef.current;
    if (!uuid) return;
    // The host rewrites the SVG for a customised asset, so the copy held for this uuid
    // is no longer the artwork — drop it and let the next open fetch it fresh.
    reviewCacheRef.current.delete(uuid);
    try {
      const res = await fetch(`/api/review/customised/${uuid}`, { method: 'POST' });
      const data = (await res.json()) as { message?: string; error?: { message?: string } };
      console.log(`[review/customised] ${uuid} -> ${res.status}`, data);
      if (!res.ok || data.message !== 'success') {
        console.log('[review/customised] upstream did not report success');
      }
    } catch (err) {
      console.log(`[review/customised] ${uuid} failed:`, err);
    }
  }, []);

  return { openReviewUuid, onReviewListLoaded, notifyCustomised };
}
