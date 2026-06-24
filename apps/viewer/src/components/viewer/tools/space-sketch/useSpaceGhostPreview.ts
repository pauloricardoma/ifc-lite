/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live 3D preview of the Space Sketch draft rooms across EVERY storey.
 *
 * Renders each draft room (on any storey, not just the active one) as a
 * semi-transparent ghost mesh in the 3D scene WITHOUT committing an IfcSpace, so
 * the 2D plan and the model stay coupled while editing and the building stays
 * hidden behind the rooms on every floor. Ghosts reuse the exact same outline +
 * floor elevation + height the eventual create feeds `addSpace`, so a ghost
 * lands pixel-identical to the space it previews - only tinted differently.
 *
 * The 3D view is isolated to (existing spaces ∪ all draft ghosts) so ONLY the
 * rooms show; the building is hidden as long as there is any room to show.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { buildElementMesh } from '@/store/slices/addElementMeshes';
import type { AddElementSpaceParams } from '@/store/slices/addElementSlice';

/** Draft ghost tint (RGBA 0..1): a cool blue, clearly distinct from the warm
 *  green of a committed IfcSpace, at a low alpha so the model reads through. */
const GHOST_COLOR: [number, number, number, number] = [0.25, 0.62, 0.95, 0.16];

/** Reserved high id band for ghost meshes — far above any real express/global
 *  id, so a ghost can never collide with (or be removed alongside) a real
 *  entity. Always allocate fresh; never reuse. */
let ghostIdSeq = 0x70000000;
function nextGhostId(): number {
  return ghostIdSeq++;
}

/** One draft room to preview: its boundary outline (plan, metres) + the storey
 *  floor elevation and floor-to-ceiling height for the extrusion. */
export interface GhostSpec {
  corners: [number, number][];
  floorElev: number;
  height: number;
}

interface GhostPreviewArgs {
  /** Tool open AND a model is present — gates all ghost work. */
  enabled: boolean;
  /** Every draft room across every storey (memoised by the overlay). */
  ghosts: GhostSpec[];
  /** Existing IfcSpace ids — the isolation base the ghosts are added to. */
  isolationBase: number[];
}

export function useSpaceGhostPreview({ enabled, ghosts, isolationBase }: GhostPreviewArgs): {
  clearGhosts: () => void;
} {
  const ghostIdsRef = useRef<number[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseRef = useRef<number[]>(isolationBase);
  baseRef.current = isolationBase;

  // Isolate the 3D view to the spaces (existing base + current draft ghosts) so
  // the building is hidden and only the rooms show. With nothing to show at all
  // (no spaces and no ghosts) isolation is cleared so the view is not blank.
  const syncIsolation = useCallback(() => {
    const store = useViewerStore.getState();
    const ids = [...baseRef.current, ...ghostIdsRef.current];
    store.setIsolatedEntities(ids.length > 0 ? new Set(ids) : null);
  }, []);

  // Drop every ghost from the scene's overlay channel. The close path owns
  // isolation afterwards, so this leaves isolation alone.
  const clearGhosts = useCallback(() => {
    if (ghostIdsRef.current.length === 0) return;
    useViewerStore.getState().cameraCallbacks.clearSpaceOverlayMeshes?.();
    ghostIdsRef.current = [];
  }, []);

  const rebuild = useCallback(() => {
    const store = useViewerStore.getState();
    if (!enabled) {
      store.cameraCallbacks.clearSpaceOverlayMeshes?.();
      ghostIdsRef.current = [];
      syncIsolation();
      return;
    }
    const meshes: ReturnType<typeof buildElementMesh>[] = [];
    const newIds: number[] = [];
    for (const g of ghosts) {
      if (g.corners.length < 3) continue;
      const id = nextGhostId();
      const params: AddElementSpaceParams = { Width: 0, Depth: 0, Height: g.height };
      const mesh = buildElementMesh({
        type: 'space',
        globalId: id,
        storeyElevation: g.floorElev,
        payload: {
          type: 'space',
          params,
          corners: g.corners.map(([x, y]) => [x, y, 0] as [number, number, number]),
        },
      });
      if (!mesh) continue;
      mesh.color = [...GHOST_COLOR]; // fresh array — never mutate shared COLORS
      meshes.push(mesh);
      newIds.push(id);
    }
    // Replace the overlay in ONE scene operation (no geometryResult churn).
    store.cameraCallbacks.setSpaceOverlayMeshes?.(meshes.filter((m): m is NonNullable<typeof m> => m !== null));
    ghostIdsRef.current = newIds;
    syncIsolation();
  }, [enabled, ghosts, syncIsolation]);

  // Debounced rebuild whenever the draft set changes.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      rebuild();
    }, 80);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [rebuild]);

  // Final cleanup: synchronously drop all ghosts on unmount so none linger.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      clearGhosts();
    };
  }, [clearGhosts]);

  return { clearGhosts };
}
