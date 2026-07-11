// Streaming decoder do parquet padrão (container [len][mesh][len][vertex][len][index])
// POR ROW GROUP, usando parquet-wasm 0.7.2 (ParquetFile + Blob).
//
// Por quê: decodificar as tabelas vertex/index INTEIRAS num readParquet
// descomprime muito além dos ~4GB do wasm32 → trap "unreachable" nos modelos
// grandes (DOR 1.3GB). Aqui decodificamos UM row group por vez (~11MB) e
// reconstruímos as malhas cuja faixa cai na janela carregada. As faixas do mesh
// são contíguas + monotônicas e cada malha ocupa < 1 row group, então um cache
// deslizante pequeno (liberado conforme as malhas avançam) mantém WASM + heap
// limitados, independente do tamanho do modelo.
//
// Blob (não ArrayBuffer): ParquetFile.fromFile lê só os bytes do row group via
// range da Blob — não copia o arquivo inteiro pro WASM (a API 0.5.0 do
// server-client copiava tudo a cada RG → ~2min; esta faz ~9s).
import init, { ParquetFile } from 'parquet-wasm';
import wasmUrl from 'parquet-wasm/esm/parquet_wasm_bg.wasm?url';
import * as arrow from 'apache-arrow';

export interface StreamMesh {
  expressId: number;
  ifcType: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  color: [number, number, number, number];
}

let ready: Promise<unknown> | null = null;
function ensureInit(): Promise<unknown> {
  if (!ready) ready = init(wasmUrl);
  return ready;
}

async function readU32LE(blob: Blob, pos: number): Promise<number> {
  const b = await blob.slice(pos, pos + 4).arrayBuffer();
  return new DataView(b).getUint32(0, true);
}

// Prefix sums das linhas por row group → mapeia índice global p/ (RG, offset local).
function prefixRows(meta: any, nrg: number): number[] {
  const p = new Array(nrg + 1);
  p[0] = 0;
  for (let k = 0; k < nrg; k++) p[k + 1] = p[k] + Number(meta.rowGroup(k).numRows());
  return p;
}
function rgOf(starts: number[], pos: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
  return lo;
}

interface VtxRG { x: Float32Array; y: Float32Array; z: Float32Array; nx: Float32Array; ny: Float32Array; nz: Float32Array; }
interface IdxRG { i0: Uint32Array; i1: Uint32Array; i2: Uint32Array; }

/**
 * Decodifica o parquet padrão em batches de malhas, streamando por row group.
 * @param source Blob do container (fetch(url).then(r => r.blob())).
 * @param batchSize malhas por batch emitido (default 4000).
 */
export async function* decodeStdParquetStreaming(
  source: Blob,
  batchSize = 4000,
): AsyncGenerator<StreamMesh[]> {
  await ensureInit();

  // Parse do container via slices da Blob (sem ler tudo na memória).
  const meshLen = await readU32LE(source, 0);
  const meshBlob = source.slice(4, 4 + meshLen);
  const vtxLenPos = 4 + meshLen;
  const vtxLen = await readU32LE(source, vtxLenPos);
  const vtxBlob = source.slice(vtxLenPos + 4, vtxLenPos + 4 + vtxLen);
  const idxLenPos = vtxLenPos + 4 + vtxLen;
  const idxLen = await readU32LE(source, idxLenPos);
  const idxBlob = source.slice(idxLenPos + 4, idxLenPos + 4 + idxLen);

  // Tabela mesh inteira (minúscula: 1 linha por malha, só ranges + cor/id).
  const meshPf = await ParquetFile.fromFile(meshBlob);
  const M: any = arrow.tableFromIPC((await meshPf.read()).intoIPCStream());
  const expressIds = M.getChild('express_id').toArray() as Uint32Array;
  const ifcTypes = M.getChild('ifc_type');
  const vertexStarts = M.getChild('vertex_start').toArray() as Uint32Array;
  const vertexCounts = M.getChild('vertex_count').toArray() as Uint32Array;
  const indexStarts = M.getChild('index_start').toArray() as Uint32Array;
  const indexCounts = M.getChild('index_count').toArray() as Uint32Array;
  const colorR = M.getChild('color_r').toArray() as Float32Array;
  const colorG = M.getChild('color_g').toArray() as Float32Array;
  const colorB = M.getChild('color_b').toArray() as Float32Array;
  const colorA = M.getChild('color_a').toArray() as Float32Array;
  const meshCount = expressIds.length;

  const vtxPf = await ParquetFile.fromFile(vtxBlob);
  const idxPf = await ParquetFile.fromFile(idxBlob);
  const vMeta: any = vtxPf.metadata();
  const iMeta: any = idxPf.metadata();
  const vNrg = vMeta.numRowGroups();
  const iNrg = iMeta.numRowGroups();
  const vStart = prefixRows(vMeta, vNrg);
  const iStart = prefixRows(iMeta, iNrg);
  const totalVerts = vStart[vNrg];
  const totalTris = iStart[iNrg];

  const vCache = new Map<number, VtxRG>();
  const iCache = new Map<number, IdxRG>();
  const getVtxRG = async (k: number): Promise<VtxRG> => {
    let c = vCache.get(k);
    if (!c) {
      const t: any = arrow.tableFromIPC((await vtxPf.read({ rowGroups: [k] })).intoIPCStream());
      c = { x: t.getChild('x').toArray(), y: t.getChild('y').toArray(), z: t.getChild('z').toArray(),
            nx: t.getChild('nx').toArray(), ny: t.getChild('ny').toArray(), nz: t.getChild('nz').toArray() };
      vCache.set(k, c);
    }
    return c;
  };
  const getIdxRG = async (k: number): Promise<IdxRG> => {
    let c = iCache.get(k);
    if (!c) {
      const t: any = arrow.tableFromIPC((await idxPf.read({ rowGroups: [k] })).intoIPCStream());
      c = { i0: t.getChild('i0').toArray(), i1: t.getChild('i1').toArray(), i2: t.getChild('i2').toArray() };
      iCache.set(k, c);
    }
    return c;
  };

  let batch: StreamMesh[] = [];
  for (let i = 0; i < meshCount; i++) {
    const vS = vertexStarts[i], vC = vertexCounts[i];
    const iS = indexStarts[i], iC = indexCounts[i];
    if (vS + vC > totalVerts || iS % 3 !== 0 || iC % 3 !== 0 || (iS + iC) / 3 > totalTris) {
      throw new Error(`parquet malformado: malha ${i} fora de faixa (v=${vS}+${vC}/${totalVerts}, tri=${(iS)/3}+${iC/3}/${totalTris})`);
    }

    // Positions + normals (Z-up→Y-up já aplicado server-side; copia direto).
    const positions = new Float32Array(vC * 3);
    const normals = new Float32Array(vC * 3);
    let v = 0;
    while (v < vC) {
      const gi = vS + v;
      const k = rgOf(vStart, gi);
      const c = await getVtxRG(k);
      const base = vStart[k];
      const end = Math.min(vStart[k + 1], vS + vC);
      for (let g = gi; g < end; g++, v++) {
        const l = g - base;
        positions[v * 3] = c.x[l]; positions[v * 3 + 1] = c.y[l]; positions[v * 3 + 2] = c.z[l];
        normals[v * 3] = c.nx[l]; normals[v * 3 + 1] = c.ny[l]; normals[v * 3 + 2] = c.nz[l];
      }
    }

    // Triângulos (colunar i0/i1/i2, 1 linha por triângulo).
    const triStart = iS / 3, triCount = iC / 3;
    const indices = new Uint32Array(iC);
    let t = 0;
    while (t < triCount) {
      const gt = triStart + t;
      const k = rgOf(iStart, gt);
      const c = await getIdxRG(k);
      const base = iStart[k];
      const end = Math.min(iStart[k + 1], triStart + triCount);
      for (let g = gt; g < end; g++, t++) {
        const l = g - base;
        indices[t * 3] = c.i0[l]; indices[t * 3 + 1] = c.i1[l]; indices[t * 3 + 2] = c.i2[l];
      }
    }

    batch.push({
      expressId: expressIds[i],
      ifcType: (ifcTypes?.get(i) as string) ?? 'Unknown',
      positions, normals, indices,
      color: [colorR[i], colorG[i], colorB[i], colorA[i]],
    });

    // Libera row groups totalmente atrás do início da PRÓXIMA malha (faixas monotônicas).
    if (i + 1 < meshCount) {
      const keepV = rgOf(vStart, vertexStarts[i + 1]);
      for (const k of Array.from(vCache.keys())) if (k < keepV) vCache.delete(k);
      const keepI = rgOf(iStart, indexStarts[i + 1] / 3);
      for (const k of Array.from(iCache.keys())) if (k < keepI) iCache.delete(k);
    }

    if (batch.length >= batchSize) { yield batch; batch = []; }
  }
  if (batch.length > 0) yield batch;
}
