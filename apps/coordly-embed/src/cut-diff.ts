// Diagnóstico: por que o caminho SINGLE-THREAD entrega geometria cortada e o
// PARALELO não? Roda o mesmo .ifc nos dois com as opções exatas do engine e
// compara malha a malha por expressId. Não entra no bundle de produção — só o
// harness de dev (?diff=1) o importa.
//
// Regra §8: nada aqui patcha `packages/` — só consome a API pública.
import { GeometryProcessor, decodeInstancedShard } from '@ifc-lite/geometry';

interface EntityStats {
  meshes: number;
  vertices: number;
  indices: number;
  min: [number, number, number];
  max: [number, number, number];
  /** Veio de shard instanciado: posições são do template, não do mundo — a AABB
   *  não é comparável com a do caminho flat. */
  instanced?: boolean;
}

export interface CutDiffRow {
  expressId: number;
  ifcType?: string;
  single?: EntityStats;
  parallel?: EntityStats;
  /** Quanto o volume da AABB do single representa do paralelo (1 = idêntico). */
  volumeRatio: number;
}

const GP_OPTIONS = { tessellationQuality: 'medium' as any, skipSmallCuts: true };

const emptyStats = (): EntityStats => ({
  meshes: 0,
  vertices: 0,
  indices: 0,
  min: [Infinity, Infinity, Infinity],
  max: [-Infinity, -Infinity, -Infinity],
});

const foldMesh = (stats: EntityStats, mesh: any): void => {
  const positions: Float32Array | undefined = mesh.positions ?? mesh.vertices;
  stats.meshes += 1;
  stats.vertices += positions ? positions.length / 3 : 0;
  stats.indices += mesh.indices?.length ?? 0;
  if (!positions) { return; }
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const v = positions[i + axis];
      if (v < stats.min[axis]) { stats.min[axis] = v; }
      if (v > stats.max[axis]) { stats.max[axis] = v; }
    }
  }
};

const aabbVolume = (s?: EntityStats): number => {
  if (!s || !Number.isFinite(s.min[0])) { return 0; }
  return Math.abs((s.max[0] - s.min[0]) * (s.max[1] - s.min[1]) * (s.max[2] - s.min[2]));
};

// Um GeometryProcessor por caminho: `acquireWasmStreamingOperation` recusa dois
// streamings simultâneos, então também rodamos em sequência, nunca em paralelo.
const collect = async (
  bytes: Uint8Array,
  mode: 'single' | 'parallel',
): Promise<Map<number, EntityStats>> => {
  const gp = new GeometryProcessor(GP_OPTIONS);
  await gp.init();

  const byEntity = new Map<number, EntityStats>();
  const types = new Map<number, string>();

  // `processStreaming` é o caminho single-thread mesmo quando há SAB — é o que
  // permite comparar os dois no mesmo browser isolado.
  const stream = mode === 'parallel'
    ? gp.processParallel(bytes)
    : gp.processStreaming(bytes);

  let shards = 0;
  let instancedOccurrences = 0;
  for await (const ev of stream as AsyncGenerator<any>) {
    if (ev.type !== 'batch') { continue; }

    // Geometria repetida não vem em `ev.meshes` — vem instanciada. Contar só as
    // malhas faria o caminho que instancia (o paralelo) parecer estar perdendo
    // entidades. Aqui as ocorrências entram na mesma conta por expressId.
    for (const buf of ev.instancedShards ?? []) {
      shards += 1;
      try {
        const shard = decodeInstancedShard(new Uint8Array(buf));
        if (!shard) { continue; }
        // `instances[]` (entityId + templateIndex), não occurrences dentro do
        // template — o shape é esse, e errá-lo zera a contagem sem erro nenhum.
        for (const inst of shard.instances ?? []) {
          const id = inst.entityId ?? -1;
          const template = shard.templates?.[inst.templateIndex];
          let stats = byEntity.get(id);
          if (!stats) { stats = emptyStats(); byEntity.set(id, stats); }
          stats.meshes += 1;
          stats.vertices += (template?.positions?.length ?? 0) / 3;
          stats.indices += template?.indices?.length ?? 0;
          stats.instanced = true;
          instancedOccurrences += 1;
        }
      } catch { /* shard ilegível: segue com o que veio flat */ }
    }

    for (const mesh of ev.meshes ?? []) {
      const id = mesh.expressId ?? -1;
      let stats = byEntity.get(id);
      if (!stats) { stats = emptyStats(); byEntity.set(id, stats); }
      if (mesh.ifcType && !types.has(id)) { types.set(id, mesh.ifcType); }
      foldMesh(stats, mesh);
    }
  }

  (byEntity as any).__types = types;
  (byEntity as any).__shards = shards;
  console.log(
    `[cut-diff] ${mode}: ${byEntity.size} entidades, ${shards} shards ` +
    `(${instancedOccurrences} ocorrências instanciadas)`,
  );
  return byEntity;
};

export const runCutDiff = async (bytes: Uint8Array): Promise<CutDiffRow[]> => {
  console.log('[cut-diff] rodando SINGLE…');
  const single = await collect(bytes, 'single');
  console.log('[cut-diff] rodando PARALELO…');
  const parallel = await collect(bytes, 'parallel');

  // Tipo dos DOIS lados: entidade que só existe num caminho (o caso mais
  // interessante) não teria tipo se olhássemos só um.
  const types = new Map<number, string>([
    ...((single as any).__types ?? new Map()),
    ...((parallel as any).__types ?? new Map()),
  ]);
  const ids = new Set<number>([...single.keys(), ...parallel.keys()]);
  const rows: CutDiffRow[] = [];

  for (const expressId of ids) {
    const s = single.get(expressId);
    const p = parallel.get(expressId);
    const volP = aabbVolume(p);
    const volS = aabbVolume(s);
    const volumeRatio = volP > 0 ? volS / volP : (volS > 0 ? Infinity : 1);

    const sameMeshes = (s?.meshes ?? 0) === (p?.meshes ?? 0);
    const sameVerts = (s?.vertices ?? 0) === (p?.vertices ?? 0);
    if (sameMeshes && sameVerts && Math.abs(volumeRatio - 1) < 0.001) { continue; }

    rows.push({ expressId, ifcType: types.get(expressId), single: s, parallel: p, volumeRatio });
  }

  // Três naturezas distintas de divergência, que exigem leituras diferentes —
  // misturá-las (e ordenar por uma razão que vale Infinity/NaN nos extremos)
  // escondia justamente a que interessa: a entidade mutilada nos DOIS lados.
  const onlySingle = rows.filter((r) => !r.parallel?.meshes);
  const onlyParallel = rows.filter((r) => !r.single?.meshes);
  // AABB de instanciada é do template (espaço local), então a razão de volume não
  // significa nada nesses casos — ficam num grupo à parte para não mascarar as
  // mutiladas de verdade.
  const bothDiffer = rows
    .filter((r) => r.single?.meshes && r.parallel?.meshes
      && !r.single.instanced && !r.parallel.instanced)
    .sort((a, b) => a.volumeRatio - b.volumeRatio);
  const instancedDiff = rows.filter((r) => r.single?.instanced || r.parallel?.instanced);

  const byType = (list: CutDiffRow[]) => {
    const acc = new Map<string, number>();
    for (const r of list) { acc.set(r.ifcType ?? '(sem tipo)', (acc.get(r.ifcType ?? '(sem tipo)') ?? 0) + 1); }
    return Object.fromEntries([...acc].sort((a, b) => b[1] - a[1]));
  };

  console.log(
    `[cut-diff] RESULTADO: ${rows.length} divergências — ` +
    `só no single: ${onlySingle.length}, só no paralelo: ${onlyParallel.length}, ` +
    `nos dois porém diferentes: ${bothDiffer.length}, envolvendo instanciada: ${instancedDiff.length} ` +
    `(entidades: single ${single.size} × paralelo ${parallel.size}; ` +
    `shards: single ${(single as any).__shards} × paralelo ${(parallel as any).__shards})`,
  );
  console.log('[cut-diff] só no SINGLE, por tipo:', byType(onlySingle));
  console.log('[cut-diff] só no PARALELO, por tipo:', byType(onlyParallel));
  console.log('[cut-diff] divergentes nos DOIS, por tipo:', byType(bothDiffer));

  const toTable = (r: CutDiffRow) => ({
    expressId: r.expressId,
    ifcType: r.ifcType,
    meshesSingle: r.single?.meshes ?? 0,
    meshesParallel: r.parallel?.meshes ?? 0,
    vertsSingle: r.single?.vertices ?? 0,
    vertsParallel: r.parallel?.vertices ?? 0,
    volumeRatio: Number.isFinite(r.volumeRatio) ? Number(r.volumeRatio.toFixed(3)) : String(r.volumeRatio),
  });

  if (bothDiffer.length) {
    console.log('[cut-diff] MUTILADAS (existem nos dois, menor volume no single primeiro):');
    console.table(bothDiffer.slice(0, 30).map(toTable));
  }
  if (onlySingle.length) {
    console.log('[cut-diff] SÓ NO SINGLE (amostra):');
    console.table(onlySingle.slice(0, 15).map(toTable));
  }

  (window as any).__cutDiffGroups = { onlySingle, onlyParallel, bothDiffer, instancedDiff };

  (window as any).__cutDiff = rows;
  console.log('[cut-diff] tabela completa em window.__cutDiff');
  return rows;
};
