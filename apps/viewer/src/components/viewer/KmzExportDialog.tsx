/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Export Dialog for KMZ (Google Earth) export. Embeds the model as COLLADA — the
 * only format Google Earth's KML <Model> loads — placed at the model's real-world
 * location (#1427). Requires a georeferenced model.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Globe2, AlertCircle, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { toast } from '@/components/ui/toast';
import { buildKmzForModel, type KmzBuildError } from '@/lib/geo/kmz-export';
import { downloadBlob, sanitizeFilename } from '@/lib/export/download';

interface KmzExportDialogProps {
  trigger?: React.ReactNode;
}

const ERROR_MESSAGE: Record<KmzBuildError, string> = {
  'not-georeferenced':
    'This model has no georeferencing (IfcMapConversion / projected CRS), so it has no real-world location to place in Google Earth. Add a location in the Georeferencing panel first.',
  unprojectable:
    'The model is georeferenced but its coordinate system could not be projected to WGS84.',
  'no-geometry': 'This model has no geometry to export.',
};

export function KmzExportDialog({ trigger }: KmzExportDialogProps) {
  const models = useViewerStore((s) => s.models);
  const georefMutations = useViewerStore((s) => s.georefMutations);
  const legacyGeometryResult = useViewerStore((s) => s.geometryResult);
  const legacyDataStore = useViewerStore((s) => s.ifcDataStore);

  const [open, setOpen] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ success: boolean; message: string } | null>(null);

  // Models that have both geometry and a parsed store (georef is checked at export
  // time so we don't scan every store on every render). Falls back to the legacy
  // single-model slot when no federated model is registered (mirrors GLBExportDialog).
  const modelList = useMemo(() => {
    const list = Array.from(models.values())
      .filter((m) => m.geometryResult && m.ifcDataStore)
      .map((m) => ({ id: m.id, name: m.name, geometryResult: m.geometryResult!, dataStore: m.ifcDataStore! }));
    if (list.length === 0 && legacyGeometryResult && legacyDataStore) {
      list.push({ id: '__legacy__', name: 'Current Model', geometryResult: legacyGeometryResult, dataStore: legacyDataStore });
    }
    return list;
  }, [models, legacyGeometryResult, legacyDataStore]);

  useEffect(() => {
    if (modelList.length > 0 && !selectedModelId) setSelectedModelId(modelList[0].id);
  }, [modelList, selectedModelId]);

  const selectedModel = useMemo(
    () => modelList.find((m) => m.id === selectedModelId) ?? modelList[0],
    [modelList, selectedModelId],
  );

  const handleExport = useCallback(async () => {
    if (!selectedModel) return;
    setIsExporting(true);
    setExportResult(null);
    try {
      const baseName = sanitizeFilename(selectedModel.name.replace(/\.[^.]+$/, ''), { fallback: 'model' });
      const result = await buildKmzForModel({
        geometryResult: selectedModel.geometryResult,
        dataStore: selectedModel.dataStore,
        mutations: selectedModelId === '__legacy__' ? undefined : georefMutations.get(selectedModelId),
        name: baseName,
      });

      if (typeof result === 'string') {
        setExportResult({ success: false, message: ERROR_MESSAGE[result] });
        toast.error('KMZ export failed');
        return;
      }

      const blob = new Blob([new Uint8Array(result)], { type: 'application/vnd.google-earth.kmz' });
      downloadBlob(blob, `${baseName}.kmz`);
      const msg = `Exported KMZ (${(blob.size / 1024).toFixed(0)} KB)`;
      setExportResult({ success: true, message: msg });
      toast.success(msg);
      posthog.capture('export_completed', { format: 'kmz', size_kb: Math.round(blob.size / 1024) });
    } catch (err) {
      console.error('KMZ export failed:', err);
      const errMsg = `KMZ export failed: ${err instanceof Error ? err.message : 'Unknown error'}`;
      setExportResult({ success: false, message: errMsg });
      toast.error(errMsg);
    } finally {
      setIsExporting(false);
    }
  }, [selectedModel, selectedModelId, georefMutations]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm">
            <Globe2 className="h-4 w-4 mr-2" />
            Export KMZ
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe2 className="h-5 w-5" />
            Export KMZ File
          </DialogTitle>
          <DialogDescription>
            Export the model for Google Earth, placed at its real-world location. The model is
            embedded as COLLADA (the format Google Earth loads). Requires a georeferenced model.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {modelList.length > 1 && (
            <div className="flex items-center gap-4">
              <Label className="w-32">Model</Label>
              <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {modelList.map((m) => {
                    const displayName = m.name.length > 24 ? m.name.slice(0, 24) + '…' : m.name;
                    return (
                      <SelectItem key={m.id} value={m.id} title={m.name}>
                        {displayName}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex items-center gap-4">
            <Label className="w-32 text-muted-foreground">Output</Label>
            <Badge variant="secondary">Google Earth</Badge>
            <span className="text-xs text-muted-foreground">.kmz</span>
          </div>

          {exportResult && (
            <Alert variant={exportResult.success ? 'default' : 'destructive'}>
              {exportResult.success ? <Check className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              <AlertTitle>{exportResult.success ? 'Success' : 'Error'}</AlertTitle>
              <AlertDescription>{exportResult.message}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={isExporting || !selectedModel}>
            {isExporting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Exporting...
              </>
            ) : (
              <>
                <Globe2 className="h-4 w-4 mr-2" />
                Export
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
