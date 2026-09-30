import {
  clashMemberKey,
  matchesSelector,
  type AABB,
  type Clash,
  type ClashDistanceKind,
  type ClashElement,
  type ClashMode,
  type ClashRule,
  type ClashSeverity,
  type ClashStatus,
  type Vec3,
} from '@ifc-lite/clash';
import type { ClashLinks } from './data-model.js';

/**
 * Regra do app: tipos IFC de cada lado (gramática de selector do
 * `@ifc-lite/clash`: `IfcPipe*|IfcValve*`, `!IfcSpace`). Sem `a`, todos; sem
 * `b`, o mesmo que `a` (o tipo contra ele mesmo).
 */
export interface ClashRuleInput {
  id: string;
  name: string;
  a?: string;
  b?: string;
}

/** Valem para a verificação inteira — o coordenador escolhe um modo e um valor. */
export interface ClashRunOptions {
  mode: ClashMode;
  /** `hard`: penetração até este valor (m) não conta. */
  tolerance?: number;
  /** `clearance`: folga mínima exigida (m). */
  clearance?: number;
  /** Só pares de elementos de modelos diferentes. */
  crossModelOnly: boolean;
}

/** Lado de uma regra já com escopo: quais modelos e quais tipos. */
export interface ClashSide {
  models: string[];
  types?: string;
}

/** Regra com escopo de modelos — o que vira `ClashRule` no motor. */
export interface ClashScopedRule {
  id: string;
  a: ClashSide;
  b: ClashSide;
}

/** Um lado do conflito com o id DO ARQUIVO — o app não conhece o id da cena. */
export interface ClashItemRef {
  modelId: string;
  expressId: number;
  globalId?: string;
  ifcType: string;
  name?: string;
}

export interface ClashItem {
  id: string;
  /** `id` da regra do app que achou o conflito. */
  rule: string;
  /** Índice do issue: conflitos próximos (1,5 m) viram um issue só. */
  issue: number;
  status: ClashStatus;
  severity: ClashSeverity;
  /** Negativo = penetração, positivo = folga (m). */
  distance: number;
  distanceKind?: ClashDistanceKind;
  /** Ponto do conflito em coordenadas da cena. */
  point: Vec3;
  a: ClashItemRef;
  b: ClashItemRef;
}

export interface ClashRuleCoverageItem {
  rule: string;
  matchedA: number;
  matchedB: number | null;
}

export interface ClashRunResult {
  clashes: ClashItem[];
  issueCount: number;
  coverage: ClashRuleCoverageItem[];
  /** Presente só quando um teto cortou trabalho. */
  truncated?: { reason: string; droppedPairs: number };
  elementCount: number;
  elapsedMs: number;
}

/** O que o clash precisa de uma peça de malha da cena (`MeshData`). */
export interface ClashMeshPiece {
  expressId: number;
  ifcType?: string;
  positions: Float32Array;
  indices: Uint32Array;
  origin?: [number, number, number];
  geometryClass?: number;
  entityIds?: Uint32Array;
}

export interface BuildElementsOptions {
  /** Modelo dono deste id da cena, ou `undefined` se não é de nenhum. */
  modelOf(sceneId: number): string | undefined;
  /** Se o elemento entra em algum lado de alguma regra — só esses são copiados. */
  wanted(modelId: string, ifcType: string): boolean;
  /** Chave durável (GlobalId). Sem ela, cai no id da cena. */
  keyOf(sceneId: number): string | undefined;
}

export interface BuiltElements {
  elements: ClashElement[];
  /** Referência subtraída das posições — somar de volta para voltar à cena. */
  frame: Vec3;
}

/** Peça que o clash pode usar: ocorrência de um elemento só, com triângulos. */
const usablePiece = (piece: ClashMeshPiece): boolean =>
  (piece.geometryClass ?? 0) !== 2 && !piece.entityIds && piece.indices.length > 0;

/**
 * Converte as malhas da cena em elementos do clash, uma entrada por id da cena
 * (as peças do mesmo elemento viram uma malha só).
 *
 * As posições da cena são relativas a um `origin` por elemento, que em
 * coordenada de obra passa das centenas de metros. Somar em f32 perde os
 * milímetros que a tolerância mede, então a soma é em f64 e o resultado é
 * rebaixado para um frame comum perto de zero (o origin da primeira peça).
 */
export function buildClashElements(
  pieces: Iterable<ClashMeshPiece>,
  opts: BuildElementsOptions,
): BuiltElements {
  const groups = new Map<number, { model: string; tag: string; pieces: ClashMeshPiece[] }>();
  let frame: Vec3 | null = null;

  for (const piece of pieces) {
    if (!usablePiece(piece)) { continue; }
    const model = opts.modelOf(piece.expressId);
    const tag = piece.ifcType ?? '';
    if (model === undefined || !opts.wanted(model, tag)) { continue; }

    frame ??= piece.origin ? [...piece.origin] : [piece.positions[0], piece.positions[1], piece.positions[2]];
    const group = groups.get(piece.expressId);
    if (group) { group.pieces.push(piece); }
    else { groups.set(piece.expressId, { model, tag, pieces: [piece] }); }
  }

  const ref: Vec3 = frame ?? [0, 0, 0];
  const elements: ClashElement[] = [];
  for (const [sceneId, group] of groups) {
    elements.push({
      key: opts.keyOf(sceneId) ?? `#${sceneId}`,
      ref: sceneId,
      model: group.model,
      tag: group.tag,
      ...mergePieces(group.pieces, ref),
    });
  }
  return { elements, frame: ref };
}

function mergePieces(
  pieces: ClashMeshPiece[],
  ref: Vec3,
): { positions: Float32Array; indices: Uint32Array; bounds: AABB } {
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of pieces) { vertexCount += p.positions.length; indexCount += p.indices.length; }

  const positions = new Float32Array(vertexCount);
  const indices = new Uint32Array(indexCount);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let pOut = 0;
  let iOut = 0;

  for (const p of pieces) {
    const o = p.origin ?? [0, 0, 0];
    const base = pOut / 3;
    for (let i = 0; i < p.positions.length; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        const v = Math.fround(o[k] + p.positions[i + k] - ref[k]);
        positions[pOut + i + k] = v;
        if (v < min[k]) { min[k] = v; }
        if (v > max[k]) { max[k] = v; }
      }
    }
    for (let i = 0; i < p.indices.length; i += 1) { indices[iOut + i] = p.indices[i] + base; }
    pOut += p.positions.length;
    iOut += p.indices.length;
  }

  return { positions, indices, bounds: { min, max } };
}

/** Tipos com geometria na cena e quantos elementos de cada — a lista das regras. */
export function countClashTypes(
  pieces: Iterable<ClashMeshPiece>,
  inScene: (sceneId: number) => boolean,
): { ifcType: string; count: number }[] {
  const idsByType = new Map<string, Set<number>>();
  for (const piece of pieces) {
    if (!usablePiece(piece) || !piece.ifcType || !inScene(piece.expressId)) { continue; }
    const ids = idsByType.get(piece.ifcType);
    if (ids) { ids.add(piece.expressId); } else { idsByType.set(piece.ifcType, new Set([piece.expressId])); }
  }
  return Array.from(idsByType, ([ifcType, ids]) => ({ ifcType, count: ids.size }))
    .sort((x, y) => y.count - x.count || x.ifcType.localeCompare(y.ifcType));
}

const typesOf = (types?: string): string => types?.trim() || '*';

/** Separador entre a regra do app e o par de modelos no id da regra do motor. */
const SCOPE_SEP = '~';

/** A regra do app por trás de uma regra com escopo. */
export const userRuleOf = (scopedId: string): string => scopedId.split(SCOPE_SEP)[0];

/**
 * Regras do app → regras com escopo de modelos. "Só entre modelos diferentes"
 * vira uma regra por par de modelos, para a broad phase nem olhar o par de
 * dentro do mesmo arquivo; regra assimétrica (hidráulica × estrutura) roda nas
 * duas direções, porque qualquer dos dois arquivos pode ter o tubo.
 */
export function scopeRules(
  rules: ClashRuleInput[],
  models: string[],
  crossModelOnly: boolean,
): ClashScopedRule[] {
  const out: ClashScopedRule[] = [];
  for (const rule of rules) {
    const a = typesOf(rule.a);
    const b = typesOf(rule.b ?? rule.a);

    if (!crossModelOnly || models.length < 2) {
      out.push({ id: rule.id, a: { models, types: a }, b: { models, types: b } });
      continue;
    }

    let n = 0;
    for (let i = 0; i < models.length; i += 1) {
      for (let j = i + 1; j < models.length; j += 1) {
        const [mi, mj] = [models[i], models[j]];
        out.push({ id: `${rule.id}${SCOPE_SEP}${n++}`, a: { models: [mi], types: a }, b: { models: [mj], types: b } });
        if (a !== b) {
          out.push({ id: `${rule.id}${SCOPE_SEP}${n++}`, a: { models: [mj], types: a }, b: { models: [mi], types: b } });
        }
      }
    }
  }
  return out;
}

const sameSide = (a: ClashSide, b: ClashSide): boolean =>
  typesOf(a.types) === typesOf(b.types) &&
  a.models.length === b.models.length &&
  a.models.every((m) => b.models.includes(m));

const inSide = (el: Pick<ClashElement, 'model' | 'tag'>, side: ClashSide): boolean =>
  side.models.includes(el.model) && matchesSelector(el.tag, typesOf(side.types));

/** Se o elemento entra em algum lado de alguma regra. */
export function wantedByRules(rules: ClashScopedRule[]): (modelId: string, ifcType: string) => boolean {
  return (model, tag) => rules.some((r) => inSide({ model, tag }, r.a) || inSide({ model, tag }, r.b));
}

/**
 * Regras com escopo → regras do motor. Os lados viram membros explícitos por
 * (modelo, id da cena), que é como o motor aceita "estes arquivos". Lados iguais
 * viram self-clash: com A e B iguais o motor testaria cada par duas vezes e só
 * depois deduplicaria.
 */
export function toEngineRules(
  rules: ClashScopedRule[],
  elements: ClashElement[],
  options: Pick<ClashRunOptions, 'mode' | 'tolerance' | 'clearance'>,
): ClashRule[] {
  return rules.map((rule) => {
    const members = (side: ClashSide) =>
      elements.filter((el) => inSide(el, side)).map((el) => clashMemberKey(el.model, el.ref));
    const self = sameSide(rule.a, rule.b);

    return {
      id: rule.id,
      name: rule.id,
      a: typesOf(rule.a.types),
      ...(self ? {} : { b: typesOf(rule.b.types) }),
      membersA: members(rule.a),
      ...(self ? {} : { membersB: members(rule.b) }),
      mode: options.mode,
      ...(options.mode === 'hard' && options.tolerance != null ? { tolerance: options.tolerance } : {}),
      ...(options.mode === 'clearance' && options.clearance != null ? { clearance: options.clearance } : {}),
    };
  });
}

/**
 * No motor a `tolerance` é só a faixa de toque entre superfícies que não se
 * cruzam: uma penetração real de 5 mm sai `hard` com qualquer tolerância. A
 * tolerância do coordenador é a do Navisworks — penetração até ela não é
 * conflito — então o corte é aqui.
 */
export function dropWithinTolerance(clashes: Clash[], options: Pick<ClashRunOptions, 'mode' | 'tolerance'>): Clash[] {
  const tolerance = options.mode === 'hard' ? options.tolerance ?? 0 : 0;
  return clashes.filter((c) => c.status !== 'hard' || -c.distance > tolerance);
}

/** Relações de exclusão de um modelo, indexadas para a consulta por par. */
export interface ClashLinkIndex {
  hostFiller: Set<string>;
  partOf: Map<number, number>;
}

const pairKey = (x: number, y: number): string => (x < y ? `${x}:${y}` : `${y}:${x}`);

export function indexClashLinks(links: ClashLinks): ClashLinkIndex {
  const hostFiller = new Set<string>();
  for (let i = 0; i < links.hostFiller.length; i += 2) {
    hostFiller.add(pairKey(links.hostFiller[i], links.hostFiller[i + 1]));
  }
  const partOf = new Map<number, number>();
  for (let i = 0; i < links.partOf.length; i += 2) { partOf.set(links.partOf[i], links.partOf[i + 1]); }
  return { hostFiller, partOf };
}

/**
 * Tira o que o adapter STEP do `@ifc-lite/clash` exclui e o nosso caminho (sem
 * `IfcDataStore`) não tinha como: hospedeiro × preenchimento, peça × montagem e
 * peças da mesma montagem. Só vale dentro do mesmo modelo — relação IFC não
 * atravessa arquivo.
 */
export function dropExcluded(
  clashes: Clash[],
  linksByModel: Map<string, ClashLinkIndex>,
  localOf: (sceneId: number) => number,
): Clash[] {
  return clashes.filter((c) => {
    if (c.a.model !== c.b.model) { return true; }
    const links = linksByModel.get(c.a.model);
    if (!links) { return true; }
    const [x, y] = [localOf(c.a.ref), localOf(c.b.ref)];
    if (links.hostFiller.has(pairKey(x, y))) { return false; }
    const px = links.partOf.get(x);
    const py = links.partOf.get(y);
    return px !== y && py !== x && (px === undefined || px !== py);
  });
}

/**
 * Um par de elementos aparece uma vez só, mesmo que duas regras o achem (a
 * "Todos" e uma de tipo, ou as duas direções de uma assimétrica). Fica com a
 * primeira regra na ordem em que o app mandou.
 */
export function dedupePairs(clashes: Clash[], ruleOrder: string[]): Clash[] {
  const rank = new Map(ruleOrder.map((id, i) => [id, i]));
  const sorted = [...clashes].sort(
    (x, y) => (rank.get(userRuleOf(x.rule)) ?? 0) - (rank.get(userRuleOf(y.rule)) ?? 0),
  );
  const seen = new Set<string>();
  return sorted.filter((c) => {
    const key = [`${c.a.model} ${c.a.ref}`, `${c.b.model} ${c.b.ref}`].sort().join('|');
    if (seen.has(key)) { return false; }
    seen.add(key);
    return true;
  });
}

/** Conflitos do motor → itens do app, com id do arquivo e ponto de volta na cena. */
export function toClashItems(
  clashes: Clash[],
  issueOf: Map<string, number>,
  frame: Vec3,
  localOf: (sceneId: number) => number,
): ClashItem[] {
  const side = (ref: Clash['a']): ClashItemRef => ({
    modelId: ref.model,
    expressId: localOf(ref.ref),
    ...(ref.key.startsWith('#') ? {} : { globalId: ref.key }),
    ifcType: ref.tag,
  });

  return clashes.map((c) => ({
    id: c.id,
    rule: userRuleOf(c.rule),
    issue: issueOf.get(c.id) ?? 0,
    status: c.status,
    severity: c.severity,
    distance: c.distance,
    ...(c.distanceKind ? { distanceKind: c.distanceKind } : {}),
    point: [c.point[0] + frame[0], c.point[1] + frame[1], c.point[2] + frame[2]],
    a: side(c.a),
    b: side(c.b),
  }));
}
