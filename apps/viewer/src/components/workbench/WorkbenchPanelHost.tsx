/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useCallback, useMemo } from 'react';
import { X } from 'lucide-react';
import { BUILTIN_PANEL_IDS, type WorkbenchZoneId } from '@ifc-lite/extensions';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AddElementPanel } from '@/components/viewer/AddElementPanel';
import { BCFPanel } from '@/components/viewer/BCFPanel';
import { ExtensionsPanel } from '@/components/extensions/ExtensionsPanel';
import { GanttPanel } from '@/components/viewer/schedule/GanttPanel';
import { HierarchyPanel } from '@/components/viewer/HierarchyPanel';
import { IDSPanel } from '@/components/viewer/IDSPanel';
import { LensPanel } from '@/components/viewer/LensPanel';
import { ListPanel } from '@/components/viewer/lists/ListPanel';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { ScriptPanel } from '@/components/viewer/ScriptPanel';
import { WidgetRenderer, type WidgetRendererContext } from '@/components/extensions/widget/WidgetRenderer';
import { useOptionalExtensionHost } from '@/sdk/ExtensionHostProvider';
import { useViewerStore } from '@/store';

export function WorkbenchPanelHost({ panelId, zone }: { panelId: string; zone: WorkbenchZoneId }) {
  const closePanel = useClosePanel(panelId, zone);
  const personal = useViewerStore((s) => s.workbenchLayout.personalPanels[panelId]);
  const ctx = usePersonalWidgetContext();
  if (personal) {
    return (
      <ScrollArea className="h-full">
        <div className="p-3">
          <WidgetRenderer node={personal.widget as unknown as Parameters<typeof WidgetRenderer>[0]['node']} ctx={ctx} />
        </div>
      </ScrollArea>
    );
  }
  switch (panelId) {
    case BUILTIN_PANEL_IDS.hierarchy: return <HierarchyPanel />;
    case BUILTIN_PANEL_IDS.properties: return <PropertiesPanel />;
    case BUILTIN_PANEL_IDS.bcf: return <BCFPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.ids: return <IDSPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.lens: return <LensPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.extensions: return <ExtensionsPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.addElement: return <AddElementPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.lists: return <ListPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.script: return <ScriptPanel onClose={closePanel} />;
    case BUILTIN_PANEL_IDS.gantt: return <GanttPanel onClose={closePanel} />;
    default: return <EmptyPanel panelId={panelId} />;
  }
}

function useClosePanel(panelId: string, zone: WorkbenchZoneId): () => void {
  return useCallback(() => {
    const state = useViewerStore.getState();
    if (panelId === BUILTIN_PANEL_IDS.bcf) state.setBcfPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.ids) state.setIdsPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.lens) state.setLensPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.extensions) state.setExtensionsPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.lists) state.setListPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.script) state.setScriptPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.gantt) state.setGanttPanelVisible(false);
    if (panelId === BUILTIN_PANEL_IDS.addElement) state.setActiveTool('select');
    state.setWorkbenchActiveTab(zone, zone === 'right' ? BUILTIN_PANEL_IDS.properties : undefined);
  }, [panelId, zone]);
}

function usePersonalWidgetContext(): WidgetRendererContext {
  const host = useOptionalExtensionHost();
  return useMemo(() => ({
    state: {},
    invokeCommand: (commandId: string) => {
      host?.runCommand(commandId).catch((err) => {
        console.warn('[WorkbenchPanelHost] personal panel command failed:', err);
      });
    },
  }), [host]);
}

function EmptyPanel({ panelId }: { panelId: string }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-xs text-muted-foreground">
      <X className="mr-2 h-4 w-4" />
      Panel unavailable: {panelId}
    </div>
  );
}
