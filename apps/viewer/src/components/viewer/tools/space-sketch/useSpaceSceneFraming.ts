/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3D scene framing + isolation for the Space Sketch tool.
 *
 * On open the tool takes over the 3D view so the user actually SEES the spaces
 * they are about to sketch (IfcSpace is class-hidden by default and the
 * building shell obscures it):
 *   - turn IfcSpace visibility on,
 *   - if the model already has spaces: isolate them and frame their extent,
 *   - otherwise: frame the building shell (NOT the much larger site extent),
 *     leaving isolation alone so the walls stay visible to sketch against.
 *
 * On close it restores the prior isolation + visibility, EXCEPT after a bake
 * (`restore(true)`) where freshly-created spaces should stay visible. `restore`
 * is idempotent so the explicit close paths and the unmount cleanup can both
 * call it without double-applying.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';

interface SceneFramingArgs {
  /** Tool open AND a model present. Drives the one-shot open behavior. */
  enabled: boolean;
  /** The model's existing IfcSpace express-ids (active model). */
  existingSpaceIds: number[];
}

export function useSpaceSceneFraming({ enabled, existingSpaceIds }: SceneFramingArgs): {
  restore: (opts: { keepSpacesVisible: boolean; keepIsolation?: boolean }) => void;
} {
  // Prior 3D view state captured on open, replayed on close.
  const priorRef = useRef<{ isolated: Set<number> | null; spacesVisible: boolean } | null>(null);
  // Did THIS hook flip spaces visibility on? Only then do we restore it.
  const flippedSpacesRef = useRef(false);
  const restoredRef = useRef(false);

  // Tear down the open behavior. `keepSpacesVisible` keeps IfcSpace shown;
  // `keepIsolation` leaves the current isolation in place (used after a confirm,
  // which isolates to the freshly-created spaces so ONLY rooms stay visible)
  // instead of restoring the building.
  const restore = useCallback((opts: { keepSpacesVisible: boolean; keepIsolation?: boolean }) => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const prior = priorRef.current;
    if (!prior) return;
    const store = useViewerStore.getState();
    if (!opts.keepIsolation) store.setIsolatedEntities(prior.isolated);
    if (!opts.keepSpacesVisible && flippedSpacesRef.current && store.typeVisibility.spaces) {
      store.toggleTypeVisibility('spaces');
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const store = useViewerStore.getState();
    restoredRef.current = false;
    priorRef.current = {
      isolated: store.isolatedEntities ? new Set(store.isolatedEntities) : null,
      spacesVisible: store.typeVisibility.spaces,
    };

    // Reveal spaces so isolation / new ghosts are not class-hidden.
    if (!store.typeVisibility.spaces) {
      store.toggleTypeVisibility('spaces');
      flippedSpacesRef.current = true;
    } else {
      flippedSpacesRef.current = false;
    }

    if (existingSpaceIds.length > 0) {
      // Isolate the existing spaces (the ghost hook folds all storeys' draft
      // ghosts into this set). Only frame the camera when we're NEWLY isolating
      // them — if they're already the active isolation (e.g. re-opening the tool
      // right after a confirm left them isolated), keep the user's camera put
      // instead of jumping it to the extent again.
      const newSet = new Set(existingSpaceIds);
      const prior = priorRef.current?.isolated;
      const alreadyIsolated = !!prior && prior.size === newSet.size && [...newSet].every((id) => prior.has(id));
      store.setIsolatedEntities(newSet);
      if (!alreadyIsolated) store.cameraCallbacks.frameEntities?.(existingSpaceIds);
    } else {
      // No spaces yet: frame the building shell (not the whole georeferenced
      // site). The ghost hook isolates to the drafts the moment derive-all
      // populates them, hiding the building so only the rooms show.
      store.cameraCallbacks.frameBuildingExtent?.();
    }

    return () => {
      // Safety net for any unmount the explicit close paths didn't handle
      // (tool switched away, etc.): restore the building.
      restore({ keepSpacesVisible: false });
    };
  }, [enabled, existingSpaceIds, restore]);

  return { restore };
}
