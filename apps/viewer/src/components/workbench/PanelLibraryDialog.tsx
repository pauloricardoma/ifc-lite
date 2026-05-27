/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Eye, EyeOff, MoveRight } from 'lucide-react';
import type { WorkbenchPanelId, WorkbenchZoneId } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useViewerStore } from '@/store';
import { listWorkbenchPanels, ZONE_LABEL } from './panelRegistry';

interface PanelLibraryDialogProps {
  open: boolean;
  onClose: () => void;
  onEdit: (panelId: WorkbenchPanelId) => void;
}

export function PanelLibraryDialog({ open, onClose, onEdit }: PanelLibraryDialogProps) {
  const layout = useViewerStore((s) => s.workbenchLayout);
  const setChrome = useViewerStore((s) => s.setWorkbenchPanelChrome);
  const movePanel = useViewerStore((s) => s.moveWorkbenchPanel);
  const panels = listWorkbenchPanels(layout);

  const showInZone = (panelId: string, zone: WorkbenchZoneId) => {
    setChrome(panelId, { hidden: false });
    movePanel(panelId, zone);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Panel library</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-3">
          <div className="space-y-2">
            {panels.map((panel) => (
              <div key={panel.id} className="rounded border bg-background p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-sm">{panel.title}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {panel.kind} · {panel.zone ? ZONE_LABEL[panel.zone] : 'not docked'}
                      {panel.hidden ? ' · hidden' : ''}
                    </div>
                    <code className="mt-1 block text-[10px] text-muted-foreground break-all">{panel.id}</code>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={() => onEdit(panel.id)}>
                      Edit
                    </Button>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={panel.hidden ? 'Show panel' : 'Hide panel'}
                      onClick={() => setChrome(panel.id, { hidden: !panel.hidden })}
                    >
                      {panel.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {(['left', 'right', 'bottom'] as const).map((zone) => (
                    <Button key={zone} type="button" size="sm" variant="secondary" onClick={() => showInZone(panel.id, zone)}>
                      <MoveRight className="mr-1 h-3.5 w-3.5" />
                      {ZONE_LABEL[zone]}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
