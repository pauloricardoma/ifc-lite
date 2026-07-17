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
  onError: (code, message) => console.error(`[dev] error ${code}: ${message}`)
});

engine.init().then((ok) => {
  if (!ok) { return; }
  const input = document.getElementById('ifc') as HTMLInputElement;
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) { return; }
    const url = URL.createObjectURL(file);
    await engine.loadFromIfc(url);
    URL.revokeObjectURL(url);
  });
});
