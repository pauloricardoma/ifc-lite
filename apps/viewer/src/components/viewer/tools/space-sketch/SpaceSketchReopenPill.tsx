/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The collapsed Space Sketch affordance. Shown in place of the full panel when
 * the user clicks into the 3D scene (so the model is unobstructed); clicking it
 * restores the panel. The draft session + 3D ghost preview stay live underneath
 * the whole time - only the panel chrome is swapped out.
 */

import { Layers, ChevronDown } from 'lucide-react';

interface SpaceSketchReopenPillProps {
  /** Draft room count, surfaced so the user knows work is still in progress. */
  roomCount: number;
  onReopen: () => void;
}

export function SpaceSketchReopenPill({ roomCount, onReopen }: SpaceSketchReopenPillProps) {
  return (
    <div className="absolute left-1/2 top-4 z-30 -translate-x-1/2 pointer-events-auto">
      <button
        onClick={onReopen}
        className="flex items-center gap-2 rounded-full border bg-background/95 px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur hover:bg-muted"
        title="Reopen the Space Sketch panel"
      >
        <Layers className="h-3.5 w-3.5 text-muted-foreground" />
        <span>Space Sketch</span>
        {roomCount > 0 && (
          <span className="tabular-nums text-muted-foreground">
            {roomCount} {roomCount === 1 ? 'room' : 'rooms'}
          </span>
        )}
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
    </div>
  );
}
