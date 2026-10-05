// Changing the shape of the layer list: duplicating a layer (or several, as a group),
// opening a group into its parts and folding it back, and deleting.
//
// One hook because they share everything — the document, undo, the selection they leave
// behind, and the bookkeeping for what an AI pass hid inside the layers they move.
import { type Dispatch, type RefObject, type SetStateAction, useCallback } from 'react';

import type { RemovedRecord } from '@/components/editor-types';
import { t } from '@/i18n';
import { ancestorChain, groupLabelFor, remapClonedIds, wrapInAncestorChain } from '@/lib/layer-dom';
import {
  type ActiveSvg, type SvgLayer, applyTranslateDelta, canExpandLayer, collapsibleParent, expansionTarget,
  isSyntheticLayerId,
} from '@/lib/svg-utils';

type Options = {
  activeSvg: ActiveSvg | null;
  setActiveSvg: Dispatch<SetStateAction<ActiveSvg | null>>;
  backgroundLayerId: string | null;
  selectedLayers: Set<string>;
  snapshotForUndo: (content: string, layers: SvgLayer[]) => void;
  selectOne: (id: string | null) => void;
  setSelectedLayer: Dispatch<SetStateAction<string | null>>;
  setSelectedLayers: Dispatch<SetStateAction<Set<string>>>;
  setExpandDepth: Dispatch<SetStateAction<number>>;
  setHiddenLayers: Dispatch<SetStateAction<Set<string>>>;
  setRemovedRecords: Dispatch<SetStateAction<RemovedRecord[]>>;
  // Names a group had before it was opened, so folding it back restores them.
  expandedLabelsRef: RefObject<Map<string, string>>;
  // What the AI passes are holding hidden — a deleted layer takes its entries with it.
  removedIdsRef: RefObject<Set<string>>;
  removedRecordsRef: RefObject<RemovedRecord[]>;
};

export function useLayerStructure({
  activeSvg, setActiveSvg, backgroundLayerId, selectedLayers, snapshotForUndo, selectOne,
  setSelectedLayer, setSelectedLayers, setExpandDepth, setHiddenLayers, setRemovedRecords,
  expandedLabelsRef, removedIdsRef, removedRecordsRef,
}: Options) {
  // Duplicate a layer: deep-clone it, give the clone fresh ids, nudge it so it's visibly
  // offset, insert it just above the original in paint order, and select it.
  const duplicateLayer = useCallback((layerId: string) => {
    if (!activeSvg) return;
    const srcLayer = activeSvg.layers.find((l) => l.id === layerId);
    if (!srcLayer) return;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const el = doc.getElementById(layerId);
    if (!el) return;
    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const clone = el.cloneNode(true) as Element;
    const newId = `_layer_copy_${Date.now()}`;
    remapClonedIds(clone, newId, layerId);
    clone.setAttribute('transform', applyTranslateDelta(clone.getAttribute('transform') ?? '', 12, 12));
    el.parentNode?.insertBefore(clone, el.nextSibling);
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    const newLayer: SvgLayer = { id: newId, label: t('layers.copySuffix', { label: srcLayer.label }) };
    setActiveSvg((prev) => {
      if (!prev) return null;
      const idx = prev.layers.findIndex((l) => l.id === layerId);
      const layers = [...prev.layers];
      layers.splice(idx < 0 ? layers.length : idx + 1, 0, newLayer);
      return { ...prev, content, layers };
    });
    setSelectedLayer(newId);
    setSelectedLayers(new Set([newId]));
  }, [activeSvg, snapshotForUndo]);

  // Duplicate several layers at once: every selected element is cloned into ONE new <g>,
  // which becomes a single new layer row. That is what a shift-selection paste should
  // give — the pieces stay together, so they drag, rotate and scale as one thing, and the
  // panel gains one row rather than N rows the user has to re-select to move again.
  //
  // The group is appended at the end of the root <svg>: with the sources sitting anywhere
  // in the tree there is no single position that means "just above the originals", so it
  // goes on top of everything. Hoisting to the root would otherwise strip the wrappers
  // each source was drawn under, so every clone is re-wrapped in copies of its own
  // ancestor chain and lands exactly on its original, before the group's nudge.
  const duplicateLayersAsGroup = useCallback((layerIds: string[]) => {
    if (!activeSvg) return;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const root = doc.documentElement;
    const found = layerIds
      .map((id) => ({ id, el: doc.getElementById(id) as Element | null }))
      .filter((e): e is { id: string; el: Element } => !!e.el);
    // Ids that went stale between copy and paste — a layer deleted in between, say — just
    // drop out. With one element left there is nothing to nest, so it is a plain duplicate.
    if (found.length < 2) {
      if (found.length === 1) duplicateLayer(found[0].id);
      return;
    }
    // Paint order, not selection order: the clones have to stack the way the originals do,
    // and the selection is built in whatever order the rows were shift-clicked.
    found.sort((a, b) =>
      a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const groupId = `_layer_copy_${Date.now()}`;
    const group = doc.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.setAttribute('id', groupId);
    group.setAttribute('transform', 'translate(12, 12)');
    found.forEach(({ id, el }, i) => {
      const clone = el.cloneNode(true) as Element;
      // A namespace per clone, so two copies of the same sublayer can't collide.
      remapClonedIds(clone, `${groupId}__${i}`, id);
      group.appendChild(wrapInAncestorChain(clone, ancestorChain(el, root)));
    });
    root.appendChild(group);

    const content = new XMLSerializer().serializeToString(root);
    const firstLabel = activeSvg.layers.find((l) => l.id === found[0].id)?.label ?? t('layers.defaultLabel');
    const newLayer: SvgLayer = { id: groupId, label: `${firstLabel} +${found.length - 1} copy` };
    console.log(`[layers] pasted ${found.length} layers as group ${groupId}`);
    // Last in document order is topmost, which is where the group was appended.
    setActiveSvg((prev) => (prev ? { ...prev, content, layers: [...prev.layers, newLayer] } : null));
    selectOne(groupId);
  }, [activeSvg, duplicateLayer, snapshotForUndo, selectOne]);

  // Open a layer into its parts: the row is replaced by one row per visual child, in
  // document order. Files often deliver a whole logo as a single group, which leaves one
  // row standing for a dozen separable pieces; this drills into it on demand rather than
  // guessing at load, so a layer list that already suits an asset is never disturbed.
  //
  // The DOM is not restructured — the children stay inside their parent, so transforms,
  // classes and inherited paint go on applying. Only the layer list changes, which is
  // also why this is one-way: undo puts the single row back.
  //
  // `focusIndex` picks which of the new rows to select — the part a canvas double-click
  // landed on. Without one nothing is selected, since the expanded row no longer exists.
  const expandLayer = useCallback((layerId: string, focusIndex?: number) => {
    if (!activeSvg) return;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const el = doc.getElementById(layerId);
    if (!canExpandLayer(el)) return;

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    // Through any single-child wrappers, so opening a wrapped group lands on the level
    // that actually has alternatives rather than on another identical row.
    const kids = expansionTarget(el);
    const stamp = Date.now();

    // Remember what this row was called before it stops being one. Backing out folds into
    // the children's own parent, which is the wrapper the walk above ended on rather than
    // the element the row pointed at, so the name is recorded against every element in
    // between — each is a level the list can come back to, and all of them are the same
    // piece of artwork under the one name. Wrappers are given an id where they have none,
    // since the id is the only handle that survives the re-parse on the way back.
    const srcLabel = activeSvg.layers.find((l) => l.id === layerId)?.label;
    if (srcLabel) {
      let wrapper: Element | null = kids[0]?.parentElement ?? null;
      for (let up = 0; wrapper && up < 16; up++, wrapper = wrapper.parentElement) {
        if (!wrapper.id) wrapper.id = `_grp_${stamp}_${up}`;
        expandedLabelsRef.current.set(wrapper.id, srcLabel);
        if (wrapper === el) break;
      }
    }
    // What an AI pass took, keyed by element, so opening the layer it came out of names
    // it rather than falling through to "g 8". These rows are the way hidden artwork is
    // switched back on, and a positional label gives no way to tell which is which — on
    // a diagram of eight stacked labels, eight rows reading "g 1".."g 8" are unusable.
    const removedByEl = new Map(removedRecordsRef.current.map((r) => [r.id, r]));
    const newLayers: SvgLayer[] = kids.map((kid, i) => {
      if (!kid.id) kid.id = `_sub_${stamp}_${i}`;
      const claimedBy = removedByEl.get(kid.id)?.claimedBy;
      const label =
        kid.getAttribute('data-name')?.trim() ||
        (claimedBy ? `${claimedBy} (original)` : null) ||
        (!isSyntheticLayerId(kid.id) ? kid.id : null) ||
        `${kid.tagName.toLowerCase().replace(/.*:/, '')} ${i + 1}`;
      return { id: kid.id, label };
    });

    const content = new XMLSerializer().serializeToString(doc.documentElement);
    console.log(`[layers] expanded ${layerId} into ${newLayers.length} sublayers`);
    setExpandDepth((d) => d + 1);
    setActiveSvg((prev) => {
      if (!prev) return null;
      const idx = prev.layers.findIndex((l) => l.id === layerId);
      const layers = [...prev.layers];
      layers.splice(idx < 0 ? layers.length : idx, idx < 0 ? 0 : 1, ...newLayers);
      return { ...prev, content, layers };
    });
    // The expanded layer no longer exists as a row, so selecting it would dangle.
    selectOne(focusIndex !== undefined ? newLayers[focusIndex]?.id ?? null : null);
  }, [activeSvg, snapshotForUndo, selectOne]);

  // The way back out of a group that was drilled into: fold this row and every sibling
  // row taken from the same group back into one row for the group itself. The inverse of
  // expandLayer, and equally a layer-list-only change — the elements never moved, so
  // there is nothing to put back.
  //
  // It steps out one level at a time, so repeatedly backing out walks up the wrappers.
  // That can land on the single wrapper an asset started as; expanding again reopens it.
  const collapseLayer = useCallback((layerId: string) => {
    if (!activeSvg) return;
    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');
    const layerIds = new Set(activeSvg.layers.map((l) => l.id));
    const parent = collapsibleParent(doc.getElementById(layerId), layerIds);
    if (!parent) return;

    // Everything currently listed that lives inside this group folds away together —
    // leaving some of its children as rows and not others would be a half-open group.
    const absorbed = activeSvg.layers.filter((l) => {
      const el = doc.getElementById(l.id);
      return !!el && parent.contains(el);
    });
    if (!absorbed.length) return;

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    if (!parent.id) parent.id = `_grp_${Date.now()}`;

    // Ids this app generated are plumbing, not names — showing one turns "Layer 3" into
    // "_layer_2" on the way back out. Fall back to the same positional naming parseSvg
    // uses, which restores the name the row had before it was opened.
    const firstIdx = activeSvg.layers.findIndex((l) => l.id === absorbed[0].id);
    const label = groupLabelFor(parent, firstIdx < 0 ? activeSvg.layers.length : firstIdx, expandedLabelsRef.current);

    const content = new XMLSerializer().serializeToString(doc.documentElement);
    const absorbedIds = new Set(absorbed.map((l) => l.id));

    console.log(`[layers] collapsed ${absorbed.length} row(s) into ${parent.id}`);
    // Back up one level. Floored at zero so a collapse reached some other way — a row
    // deleted out from under the list, say — cannot drive it negative and re-offer
    // back-out at the root.
    setExpandDepth((d) => Math.max(0, d - 1));
    setActiveSvg((prev) => {
      if (!prev) return null;
      const first = prev.layers.findIndex((l) => absorbedIds.has(l.id));
      const layers = prev.layers.filter((l) => !absorbedIds.has(l.id));
      layers.splice(first < 0 ? layers.length : first, 0, { id: parent.id, label });
      return { ...prev, content, layers };
    });
    selectOne(parent.id);
  }, [activeSvg, snapshotForUndo, selectOne]);

  // Delete layers (their elements and their layers-list entries). Undoable, as one
  // step: a multi-row delete is one action to the person who asked for it, so one undo
  // has to put all of it back rather than making them press it once per layer.
  const deleteLayers = useCallback((requestedIds: string[]) => {
    if (!activeSvg) return;
    // The background layer is locked everywhere else — the overlay won't frame it and
    // the handles won't move it — so it can't be the one thing a delete does reach.
    const ids = requestedIds.filter((id) => id !== backgroundLayerId);
    if (!ids.length) return;

    const doc = new DOMParser().parseFromString(activeSvg.content, 'image/svg+xml');

    // Removing a group takes its descendants out of the document with it, so they have
    // to leave the layers list too. Expanding a group lists its children as rows of
    // their own: without this, deleting the group leaves those rows behind pointing at
    // elements that no longer exist, and the export count keeps counting them.
    //
    // Collected from the document rather than the layers list because the list only
    // holds what is currently expanded, while the removal takes the whole subtree.
    const gone = new Set<string>();
    for (const id of ids) {
      const el = doc.getElementById(id);
      if (!el) continue;
      gone.add(id);
      for (const child of el.querySelectorAll('[id]')) gone.add(child.id);
      el.remove();
    }
    // Nothing resolved to a real element — don't snapshot an edit that didn't happen,
    // which would otherwise cost the user an undo press that appears to do nothing.
    if (!gone.size) return;

    snapshotForUndo(activeSvg.content, activeSvg.layers);
    const content = new XMLSerializer().serializeToString(doc.documentElement);
    setActiveSvg((prev) => (
      prev ? { ...prev, content, layers: prev.layers.filter((l) => !gone.has(l.id)) } : null
    ));

    const withoutGone = (prev: Set<string>) => {
      const next = new Set([...prev].filter((id) => !gone.has(id)));
      return next.size === prev.size ? prev : next;
    };
    setSelectedLayer((cur) => (cur && gone.has(cur) ? null : cur));
    setSelectedLayers(withoutGone);
    // Hidden ids for elements that are gone would keep the overlay and the export count
    // reasoning about artwork that no longer exists. Unlike dropSelectionOutside there
    // is no exemption for AI-hidden nested ids here: those elements have been removed
    // from the document outright, not merely filtered out of the rows.
    setHiddenLayers(withoutGone);
    // A restore entry for a deleted element would offer to bring back something with
    // nowhere to go. Mirrors the pruning toggleLayer does when a row is shown again.
    setRemovedRecords((prev) => {
      if (!prev.some((r) => gone.has(r.id))) return prev;
      removedIdsRef.current = new Set([...removedIdsRef.current].filter((x) => !gone.has(x)));
      return prev.filter((r) => !gone.has(r.id));
    });
  }, [activeSvg, backgroundLayerId, snapshotForUndo]);

  // The row's trash button. Deleting a row that is part of a multi-row selection takes
  // the whole selection, matching toggleLayer: with several rows selected, an action on
  // one of them is read as an action on all of them. Clicking the trash on a row
  // *outside* the selection still deletes only that row — it isn't what was selected.
  const deleteLayer = useCallback((layerId: string) => {
    const ids = selectedLayers.size > 1 && selectedLayers.has(layerId) ? [...selectedLayers] : [layerId];
    deleteLayers(ids);
  }, [selectedLayers, deleteLayers]);

  return { duplicateLayer, duplicateLayersAsGroup, expandLayer, collapseLayer, deleteLayers, deleteLayer };
}
