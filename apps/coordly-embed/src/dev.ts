// Harness de dev: sobe o engine direto (sem os placeholders do web/) e deixa
// carregar um .ifc local pelo input. NÃO entra no build (só o index.html o usa).
import { ViewerEngine } from './engine.js';

const container = document.getElementById('bim-container') as HTMLElement;
const canvas = document.createElement('canvas');
canvas.style.cssText = 'width:100%;height:100%;display:block';
container.appendChild(canvas);

const log = (name: string) => (d: any) => console.log(`[dev] ${name}`, d);
const engine = new ViewerEngine(canvas, {
  onProgress: (phase, done, total) => console.log(`[dev] progress ${phase} ${done}/${total}`),
  onLoaded: log('loaded'),
  onError: (code, message) => console.error(`[dev] error ${code}: ${message}`),
  onSelect: log('select'),
  onDataModel: log('datamodel'),
  onMeasure: log('measure'),
  onViewReset: () => console.log('[dev] view-reset')
});

// ?diff=1 → não renderiza: roda o mesmo arquivo no single e no paralelo e
// compara (src/cut-diff.ts). Precisa de cross-origin isolation p/ o paralelo
// existir — o dev server do embed já manda COOP/COEP.
const diffMode = new URLSearchParams(location.search).get('diff') === '1';

engine.init().then((ok) => {
  if (!ok) { return; }
  const input = document.getElementById('ifc') as HTMLInputElement;

  if (diffMode) {
    console.log(`[dev] modo DIFF (crossOriginIsolated=${self.crossOriginIsolated})`);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) { return; }
      const { runCutDiff } = await import('./cut-diff.js');
      await runCutDiff(new Uint8Array(await file.arrayBuffer()));
    });
    return;
  }

  // `?artifacts=<pasta>` carrega os 6 artefatos de ifc-files/output/<pasta>/ pelo
  // MESMO caminho do web/ com o backend: split + range request (o vite.config
  // serve /artifacts/* com 206). `&federar=1` usa o load aditivo da federação.
  const params = new URLSearchParams(location.search);
  const artifactsDir = params.get('artifacts');
  if (artifactsDir) {
    const url = (f: string) => `/artifacts/${artifactsDir}/${f}`;
    const artifacts = {
      status: 'ready',
      urls: {
        geometry: {
          layout: 'split' as const,
          mesh: url('mesh.parquet'),
          vertex: url('vertex.parquet'),
          index: url('index.parquet'),
        },
        metadata: url('metadata.json'),
        datamodel: url('datamodel.parquet'),
      },
    };
    const t0 = performance.now();
    console.log('[dev] modo ARTEFATOS:', artifactsDir);
    const load = params.get('federar') === '1'
      ? engine.addModelFromArtifacts(artifacts, artifactsDir)
      : engine.loadFromArtifacts(artifacts);
    void load.then(() => console.log(`[dev] artefatos carregados em ${Math.round(performance.now() - t0)}ms`));
    (window as any).tree = () => engine.getSpatialTree();
    (window as any).props = (id: number) => engine.getEntityProperties(id);
    return;
  }

  // `?server=<url>` roda o MESMO caminho do web/ (parse no server + data model),
  // que é o único que popula árvore e propriedades — o client-parse não busca
  // data model. Sem o param, segue no client-parse (federação).
  const serverUrl = new URLSearchParams(location.search).get('server');
  if (serverUrl) {
    console.log('[dev] modo SERVER:', serverUrl);
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) { return; }
      const url = URL.createObjectURL(file);
      await engine.loadFromServerCached(url, serverUrl);
      URL.revokeObjectURL(url);
      // Atalhos de inspeção manual da fatia de árvore/propriedades.
      (window as any).tree = () => engine.getSpatialTree();
      (window as any).props = (id: number) => engine.getEntityProperties(id);
    });
    return;
  }

  // Federação: aceita vários .ifc e carrega aditivo (addModelFromIfc), cada um
  // com modelId = nome do arquivo. Um só arquivo = federação de 1 (mesmo caminho).
  input.multiple = true;
  input.addEventListener('change', async () => {
    const files = Array.from(input.files ?? []);
    for (const file of files) {
      const url = URL.createObjectURL(file);
      await engine.addModelFromIfc(url, file.name);
      URL.revokeObjectURL(url);
    }
  });
});
