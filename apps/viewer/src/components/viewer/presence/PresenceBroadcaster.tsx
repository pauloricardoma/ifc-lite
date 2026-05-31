/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Broadcasts this client's live presence (cursor + active tool) over collab
 * awareness so peers can see where you're pointing and what you're doing.
 *
 * Renderless: it locates the viewport canvas (sibling of the overlay layers),
 * throttles mousemove, projects the cursor onto the y=0 world plane via the
 * camera callbacks, and calls `session.presence.setCursor3d` — which is itself
 * throttled to 30 Hz + stale-evicted by the collab runtime. No-op when not in a
 * room. Reads the live session via `getState()` so it never holds a stale ref
 * and never statically imports the (code-split) collab runtime.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';

/** Cursor plane: most viewer models sit near the local-frame ground (y≈0). */
const CURSOR_PLANE_Y = 0;
/** Cap raycasts to ~33 Hz; presence coalesces the rest. */
const MOVE_THROTTLE_MS = 30;

export function PresenceBroadcaster() {
  const sessionActive = useViewerStore((s) => s.collabSession !== null);
  const anchorRef = useRef<HTMLDivElement>(null);

  // Cursor: throttled mousemove → world point → presence.setCursor3d.
  useEffect(() => {
    if (!sessionActive) return;
    const anchor = anchorRef.current;
    const canvas = anchor?.parentElement?.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    let last = 0;
    const onMove = (e: MouseEvent) => {
      const now = e.timeStamp;
      if (now - last < MOVE_THROTTLE_MS) return;
      last = now;
      const { collabSession, cameraCallbacks } = useViewerStore.getState();
      if (!collabSession || !cameraCallbacks.unprojectToFloor) return;
      const world = cameraCallbacks.unprojectToFloor(e.clientX, e.clientY, CURSOR_PLANE_Y);
      collabSession.presence.setCursor3d(world ?? null);
    };
    const onLeave = () => {
      useViewerStore.getState().collabSession?.presence.setCursor3d(null);
    };

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      useViewerStore.getState().collabSession?.presence.setCursor3d(null);
    };
  }, [sessionActive]);

  // Tool: mirror the active tool so peer labels read "Anna — measure".
  const activeTool = useViewerStore((s) => s.activeTool);
  useEffect(() => {
    if (!sessionActive) return;
    useViewerStore.getState().collabSession?.presence.setTool(activeTool ?? null);
  }, [sessionActive, activeTool]);

  return <div ref={anchorRef} style={{ display: 'none' }} aria-hidden="true" />;
}
