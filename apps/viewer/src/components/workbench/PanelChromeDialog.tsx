/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { PersonalPanelDefinition } from '@ifc-lite/extensions';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useViewerStore } from '@/store';
import { getWorkbenchPanelTitle } from './panelRegistry';

interface PanelChromeDialogProps {
  panelId: string | null;
  onClose: () => void;
}

export function PanelChromeDialog({ panelId, onClose }: PanelChromeDialogProps) {
  const layout = useViewerStore((s) => s.workbenchLayout);
  const setChrome = useViewerStore((s) => s.setWorkbenchPanelChrome);
  const updatePersonal = useViewerStore((s) => s.updateWorkbenchPersonalPanel);
  const removePersonal = useViewerStore((s) => s.removeWorkbenchPersonalPanel);
  const panel = panelId ? layout.personalPanels[panelId] : undefined;
  const initialTitle = useMemo(() => panelId ? getWorkbenchPanelTitle(layout, panelId) : '', [layout, panelId]);
  const [title, setTitle] = useState(initialTitle);
  const [accent, setAccent] = useState('');
  const [markdown, setMarkdown] = useState('');

  useEffect(() => {
    if (!panelId) return;
    const personal = layout.personalPanels[panelId];
    setTitle(getWorkbenchPanelTitle(layout, panelId));
    setAccent(layout.panelChrome[panelId]?.accent ?? '');
    setMarkdown(readMarkdown(personal));
  }, [layout, panelId]);

  const handleSave = () => {
    if (!panelId) return;
    const nextTitle = title.trim() || initialTitle || panelId;
    setChrome(panelId, { title: nextTitle, accent: accent.trim() || undefined });
    if (panel) {
      updatePersonal({
        ...panel,
        title: nextTitle,
        widget: { type: 'Markdown', content: markdown },
        updatedAt: new Date().toISOString(),
      });
    }
    onClose();
  };

  return (
    <Dialog open={!!panelId} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit panel chrome</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="panel-title">Title</Label>
            <Input id="panel-title" value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="panel-accent">Accent token</Label>
            <Input
              id="panel-accent"
              value={accent}
              onChange={(event) => setAccent(event.currentTarget.value)}
              placeholder="e.g. fire, qa, review"
            />
          </div>
          {panel && (
            <div className="space-y-1.5">
              <Label htmlFor="panel-markdown">Personal panel Markdown</Label>
              <textarea
                id="panel-markdown"
                value={markdown}
                onChange={(event) => setMarkdown(event.currentTarget.value)}
                rows={9}
                className="w-full rounded border bg-background px-2 py-1.5 text-sm font-mono"
              />
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            {panel ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => {
                  removePersonal(panel.id);
                  onClose();
                }}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" />
                Delete panel
              </Button>
            ) : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
              <Button type="button" size="sm" onClick={handleSave}>Save</Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function readMarkdown(panel: PersonalPanelDefinition | undefined): string {
  const widget = panel?.widget;
  if (!widget || typeof widget !== 'object' || Array.isArray(widget)) return '';
  const content = widget.content;
  return typeof content === 'string' ? content : '';
}
