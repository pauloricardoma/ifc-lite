/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collaboration presence layer (M1, plan §7.4).
 *
 * Mounts `@ifc-lite/collab`'s `mountPresenceInViewer` bridge over the
 * viewport when a collab session is active. The bridge appends its own
 * `pointer-events:none` canvas overlay into the viewport container and
 * forwards local mousemove as a presence cursor, so peers' cursors and
 * selections render without touching the WebGPU render loop.
 *
 * The collab runtime is lazy-imported so nothing loads until a session
 * exists (the feature ships dark — plan §7.8). When collab is disabled
 * `collabSession` is always null and this renders an inert marker.
 *
 * M1 uses the bridge's 2D-cursor fallback (no `raycastToWorld`), which is
 * accurate when peers share a view. 3D-anchored cursors (re-projected per
 * camera) are a follow-up once a renderer screen→world hook is wired here.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';

export function CollabPresenceLayer() {
  const session = useViewerStore((s) => s.collabSession);
  const markerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!session) return;
    // The viewport wrapper is `position:relative` and tagged `data-viewport`;
    // the bridge needs it as the overlay container + mousemove source.
    const container = markerRef.current?.closest('[data-viewport]');
    if (!(container instanceof HTMLElement)) return;

    let teardown: (() => void) | null = null;
    let disposed = false;
    void (async () => {
      const { mountPresenceInViewer } = await import('@ifc-lite/collab');
      if (disposed) return;
      teardown = mountPresenceInViewer({ session, container, viewport: '3d' });
    })();

    return () => {
      disposed = true;
      teardown?.();
    };
  }, [session]);

  // Invisible marker — used only to locate the [data-viewport] container.
  return <span ref={markerRef} className="hidden" aria-hidden="true" />;
}
