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
  onSelect: log('select')
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
