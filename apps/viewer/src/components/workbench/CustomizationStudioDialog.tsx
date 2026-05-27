/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { LayoutDashboard, Wand2 } from 'lucide-react';
import { listCustomizationTemplates, simulateWorkbenchPatch } from '@ifc-lite/customization';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useViewerStore } from '@/store';
import { previewWorkbenchPatch } from './WorkbenchPatchDialog';

interface CustomizationStudioDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CustomizationStudioDialog({ open, onClose }: CustomizationStudioDialogProps) {
  const layout = useViewerStore((s) => s.workbenchLayout);
  const templates = listCustomizationTemplates();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            Customization Studio
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[180px,1fr]">
          <aside className="space-y-1 rounded border bg-muted/20 p-2 text-sm">
            <div className="rounded bg-background px-2 py-1.5 font-medium">Templates</div>
            <div className="px-2 py-1.5 text-muted-foreground">Panels</div>
            <div className="px-2 py-1.5 text-muted-foreground">Automations</div>
            <div className="px-2 py-1.5 text-muted-foreground">History</div>
            <div className="px-2 py-1.5 text-muted-foreground">AI plans</div>
          </aside>
          <ScrollArea className="max-h-[62vh] pr-3">
            <div className="space-y-3">
              {templates.map((template) => {
                const patch = template.plan.patch;
                const simulation = patch ? simulateWorkbenchPatch(layout, patch) : undefined;
                return (
                  <div key={template.id} className="rounded border bg-background p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 font-medium">
                          <LayoutDashboard className="h-4 w-4 text-primary" />
                          {template.name}
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{template.description}</p>
                        <div className="mt-2 text-xs text-muted-foreground">
                          {simulation?.changes.length ?? 0} operation{simulation?.changes.length === 1 ? '' : 's'}
                          {simulation && simulation.warnings.length > 0 ? ` · ${simulation.warnings.length} warning(s)` : ''}
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        disabled={!patch}
                        onClick={() => {
                          if (patch) previewWorkbenchPatch(patch);
                          onClose();
                        }}
                      >
                        Preview
                      </Button>
                    </div>
                    {simulation && (
                      <div className="mt-3 rounded bg-muted/30 p-2">
                        {simulation.changes.slice(0, 4).map((change, index) => (
                          <div key={`${change.operation}-${index}`} className="text-xs">
                            <span className="font-medium">{change.label}</span>
                            {change.detail ? <span className="text-muted-foreground"> — {change.detail}</span> : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
