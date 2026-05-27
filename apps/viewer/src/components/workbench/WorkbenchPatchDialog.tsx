/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useState } from 'react';
import { Check, Wand2, X } from 'lucide-react';
import type { WorkbenchPatch } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useViewerStore } from '@/store';

const PATCH_EVENT = 'ifc-lite:preview-workbench-patch';

export function WorkbenchPatchDialog() {
  const applyPatch = useViewerStore((s) => s.applyWorkbenchPatch);
  const [patch, setPatch] = useState<WorkbenchPatch | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const candidate = event.detail;
      if (isWorkbenchPatch(candidate)) setPatch(candidate);
    };
    window.addEventListener(PATCH_EVENT, handler);
    return () => window.removeEventListener(PATCH_EVENT, handler);
  }, []);

  if (!patch) return null;
  return (
    <Dialog open={!!patch} onOpenChange={(next) => !next && setPatch(null)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            Preview workbench patch
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded border bg-muted/30 p-3 text-sm">
            <div><span className="font-medium">Patch:</span> <code>{patch.id}</code></div>
            <div><span className="font-medium">Author:</span> {patch.author}</div>
            <div><span className="font-medium">Operations:</span> {patch.operations.length}</div>
          </div>
          <ScrollArea className="max-h-[360px] rounded border">
            <div className="divide-y">
              {patch.operations.map((operation, index) => (
                <div key={`${operation.op}-${index}`} className="p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{operation.op}</div>
                  <pre className="mt-1 overflow-x-auto text-[11px]">{JSON.stringify(operation, null, 2)}</pre>
                </div>
              ))}
            </div>
          </ScrollArea>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPatch(null)}>
              <X className="mr-1 h-3.5 w-3.5" />
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                applyPatch(patch);
                setPatch(null);
              }}
            >
              <Check className="mr-1 h-3.5 w-3.5" />
              Apply patch
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function previewWorkbenchPatch(patch: WorkbenchPatch) {
  window.dispatchEvent(new CustomEvent(PATCH_EVENT, { detail: patch }));
}

function isWorkbenchPatch(value: unknown): value is WorkbenchPatch {
  if (!value || typeof value !== 'object') return false;
  const patch = value as Partial<WorkbenchPatch>;
  return typeof patch.id === 'string'
    && typeof patch.author === 'string'
    && typeof patch.createdAt === 'string'
    && Array.isArray(patch.operations);
}
