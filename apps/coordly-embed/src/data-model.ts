// Data model (atributos, Psets/Qtos e hierarquia espacial) do MESMO artefato que
// já entrega a geometria — o server escreve os dois no cache sob o mesmo
// `cache_key`, então não existe sidecar que possa dessincronizar.
//
// ⚠️ Por que não usar `decodeDataModel` do `@ifc-lite/server-client`: ele importa
// `parquet-wasm/esm/arrow2.js`, subpath que só existe na 0.5.0. Nós pinamos a
// 0.7.2 (§2.2 do plano: 0.5.0 copia a seção inteira pro WASM a cada row group).
// Manter as duas versões custaria +6.5MB de wasm no bundle. Aqui reusamos o
// módulo wasm que o decoder de geometria já inicializa e lemos as mesmas colunas
// que o writer Rust emite (`apps/server/src/services/parquet_data_model.rs`).
//
// O data model é pequeno perto da geometria (atributos, não malhas), então
// `readParquet` monolítico é seguro — é o que o próprio upstream faz.
import { readParquet } from 'parquet-wasm';
import * as arrow from 'apache-arrow';
import { ensureInit } from './parquet-stream.js';

/** Nó da árvore espacial, pronto pra atravessar a ponte (só dado plano). */
export interface BimTreeNode {
  /** Estável e único: `n:<expressId>` (espacial) ou `g:<pai>:<TIPO>` (grupo). */
  key: string;
  kind: 'spatial' | 'type-group';
  name: string;
  ifcType: string;
  expressId?: number;
  elevation?: number;
  /** Total de elementos abaixo do nó (recursivo) — o "(47)" do rótulo. */
  elementCount: number;
  /** Só em `type-group`: os elementos do grupo. Nó espacial agrega pelos filhos. */
  expressIds?: number[];
  children: BimTreeNode[];
}

export interface BimProperty {
  name: string;
  value: string;
  type?: string;
}

export interface BimPropertySet {
  id: number;
  name: string;
  kind: 'pset' | 'qto';
  properties: BimProperty[];
}

export interface BimEntityProperties {
  expressId: number;
  ifcType: string;
  name?: string;
  globalId?: string;
  description?: string;
  objectType?: string;
  tag?: string;
  predefinedType?: string;
  propertySets: BimPropertySet[];
  quantitySets: BimPropertySet[];
}

interface RawSpatialNode {
  expressId: number;
  parentId: number;
  typeName: string;
  name?: string;
  elevation?: number;
  childrenIds: number[];
  elementIds: number[];
}

// Aberturas não são navegáveis (e o engine as esconde do render pelo mesmo
// motivo) — listá-las na árvore seria oferecer seleção de algo invisível.
const HIDDEN_IN_TREE = new Set(['IFCOPENINGELEMENT']);

const table = (bytes: Uint8Array): arrow.Table =>
  arrow.tableFromIPC(readParquet(bytes).intoIPCStream());

// Uma célula do `Debug` de `AttributeValue` (rust/core/src/schema_gen.rs).
const DEBUG_CELL = /^(String|Enum|Float|Integer)\((.*)\)$/s;
// `List([String("IFCLABEL"), String("REI30")])` → tipo IFC + valor.
const DEBUG_TYPED_LIST = /^List\(\[String\("([^"]*)"\),\s*(.*)\]\)$/s;

const unquote = (raw: string): string =>
  raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;

/**
 * Normaliza `property_value` para exibição.
 *
 * ⚠️ Compatibilidade com server antigo: até a correção em
 * `apps/server/src/services/data_model/properties.rs`, valores de texto e
 * booleanos eram gravados como o `Debug` do Rust — o painel mostraria
 * `List([String("IFCBOOLEAN"), Enum("T")])` no lugar de `true`. O server em
 * produção ainda emite assim (confirmado no payload real de 2026-08-03).
 *
 * Servidor já atualizado emite o valor limpo, que não casa com nenhum padrão
 * daqui e passa intacto — então isto some sozinho quando o deploy alcançar o
 * fork, sem precisar ser removido.
 */
const cleanPropertyValue = (raw: string): string => {
  const typed = DEBUG_TYPED_LIST.exec(raw);
  if (typed) {
    const ifcType = typed[1].toUpperCase();
    const inner = cleanPropertyValue(typed[2].trim());
    // IFC codifica booleano/lógico como enum de uma letra.
    if (ifcType === 'IFCBOOLEAN' || ifcType === 'IFCLOGICAL') {
      if (inner === 'T') { return 'true'; }
      if (inner === 'F') { return 'false'; }
      if (inner === 'U') { return 'unknown'; }
    }
    return inner;
  }

  const cell = DEBUG_CELL.exec(raw);
  return cell ? unquote(cell[2].trim()) : raw;
};

const col = <T>(t: arrow.Table, name: string): T | undefined =>
  t.getChild(name)?.toArray() as T | undefined;

/** Lê `[u32 len][bytes]` a partir de `pos`; devolve os bytes e a posição seguinte. */
const section = (data: ArrayBuffer, view: DataView, pos: number): [Uint8Array, number] => {
  const len = view.getUint32(pos, true);
  return [new Uint8Array(data, pos + 4, len), pos + 4 + len];
};

/**
 * Índice de entidades em colunas (não `Map`): o V8 limita `Map` a 2^24 entradas
 * e um modelo grande passa disso. Busca binária sobre os ids ordenados, como o
 * `ServerEntityIndex` do upstream.
 */
class EntityIndex {
  private readonly sorted: Uint32Array;
  private readonly rows: Uint32Array | null;

  constructor(
    readonly count: number,
    readonly expressId: Uint32Array,
    readonly typeName: string[],
    readonly globalId: (string | null)[],
    readonly name: (string | null)[],
    readonly description?: (string | null)[],
    readonly objectType?: (string | null)[],
    readonly tag?: (string | null)[],
    readonly predefinedType?: (string | null)[],
  ) {
    let sorted = true;
    for (let i = 1; i < count; i++) {
      if (expressId[i] < expressId[i - 1]) { sorted = false; break; }
    }
    if (sorted) {
      this.sorted = expressId;
      this.rows = null;
    } else {
      const perm = new Uint32Array(count);
      for (let i = 0; i < count; i++) { perm[i] = i; }
      perm.sort((a, b) => expressId[a] - expressId[b]);
      const ids = new Uint32Array(count);
      for (let i = 0; i < count; i++) { ids[i] = expressId[perm[i]]; }
      this.sorted = ids;
      this.rows = perm;
    }
  }

  rowOf(expressId: number): number {
    let lo = 0, hi = this.sorted.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = this.sorted[mid];
      if (v === expressId) { return this.rows ? this.rows[mid] : mid; }
      if (v < expressId) { lo = mid + 1; } else { hi = mid - 1; }
    }
    return -1;
  }

  typeOf(expressId: number): string {
    const row = this.rowOf(expressId);
    return row < 0 ? '' : (this.typeName[row] ?? '');
  }

  labelOf(expressId: number): string {
    const row = this.rowOf(expressId);
    if (row < 0) { return `#${expressId}`; }
    return this.name[row] || `${this.typeName[row] ?? 'Elemento'} #${expressId}`;
  }
}

/**
 * Data model decodificado, com as consultas que a UI faz: árvore espacial,
 * propriedades de um elemento e rótulos em lote.
 */
export class ModelDataStore {
  private constructor(
    private readonly entities: EntityIndex,
    private readonly sets: Map<number, BimPropertySet>,
    /** elemento → ids de Pset/Qto (via IfcRelDefinesByProperties). */
    private readonly setsOf: Map<number, number[]>,
    private readonly spatial: Map<number, RawSpatialNode>,
    private readonly roots: number[],
  ) {}

  static async decode(buffer: ArrayBuffer): Promise<ModelDataStore> {
    await ensureInit();

    const view = new DataView(buffer);
    let pos = 0;
    let entitiesData: Uint8Array, propertiesData: Uint8Array, quantitiesData: Uint8Array;
    let relationshipsData: Uint8Array, spatialData: Uint8Array;
    [entitiesData, pos] = section(buffer, view, pos);
    [propertiesData, pos] = section(buffer, view, pos);
    [quantitiesData, pos] = section(buffer, view, pos);
    [relationshipsData, pos] = section(buffer, view, pos);
    [spatialData, pos] = section(buffer, view, pos);
    // As seções de classificação/material/documento vêm depois; não são usadas aqui.

    const entities = ModelDataStore.readEntities(table(entitiesData));
    const sets = ModelDataStore.readSets(table(propertiesData), table(quantitiesData));
    const setsOf = ModelDataStore.readSetLinks(table(relationshipsData), sets);
    const { spatial, roots } = ModelDataStore.readSpatial(spatialData);

    return new ModelDataStore(entities, sets, setsOf, spatial, roots);
  }

  private static readEntities(t: arrow.Table): EntityIndex {
    const ids = col<Uint32Array>(t, 'entity_id') ?? new Uint32Array(0);
    return new EntityIndex(
      ids.length,
      ids,
      (col<string[]>(t, 'type_name') ?? []) as string[],
      (col<(string | null)[]>(t, 'global_id') ?? []) as (string | null)[],
      (col<(string | null)[]>(t, 'name') ?? []) as (string | null)[],
      col<(string | null)[]>(t, 'description'),
      col<(string | null)[]>(t, 'object_type'),
      col<(string | null)[]>(t, 'tag'),
      col<(string | null)[]>(t, 'predefined_type'),
    );
  }

  /** Psets e Qtos num mapa só — a UI os separa pelo `kind`. */
  private static readSets(props: arrow.Table, qtos: arrow.Table): Map<number, BimPropertySet> {
    const sets = new Map<number, BimPropertySet>();

    const psetIds = col<Uint32Array>(props, 'pset_id') ?? new Uint32Array(0);
    const psetNames = (col<string[]>(props, 'pset_name') ?? []) as string[];
    const propNames = (col<string[]>(props, 'property_name') ?? []) as string[];
    const propValues = (col<string[]>(props, 'property_value') ?? []) as string[];
    const propTypes = (col<string[]>(props, 'property_type') ?? []) as string[];
    for (let i = 0; i < psetIds.length; i++) {
      const id = psetIds[i];
      let set = sets.get(id);
      if (!set) {
        set = { id, name: psetNames[i] ?? '', kind: 'pset', properties: [] };
        sets.set(id, set);
      }
      const value = cleanPropertyValue(propValues[i] ?? '');
      // Propriedade sem valor é ruído no painel — o IFC as emite às centenas.
      if (value !== '') {
        set.properties.push({ name: propNames[i] ?? '', value, type: propTypes[i] || undefined });
      }
    }

    const qsetIds = col<Uint32Array>(qtos, 'qset_id') ?? new Uint32Array(0);
    const qsetNames = (col<string[]>(qtos, 'qset_name') ?? []) as string[];
    const qNames = (col<string[]>(qtos, 'quantity_name') ?? []) as string[];
    const qValues = col<Float64Array>(qtos, 'quantity_value') ?? new Float64Array(0);
    const qTypes = (col<string[]>(qtos, 'quantity_type') ?? []) as string[];
    for (let i = 0; i < qsetIds.length; i++) {
      const id = qsetIds[i];
      let set = sets.get(id);
      if (!set) {
        set = { id, name: qsetNames[i] ?? '', kind: 'qto', properties: [] };
        sets.set(id, set);
      }
      set.properties.push({
        name: qNames[i] ?? '',
        // O valor chega como f64; a formatação (casas, unidade) é da UI.
        value: String(qValues[i] ?? 0),
        type: qTypes[i] || undefined,
      });
    }

    return sets;
  }

  /**
   * `IfcRelDefinesByProperties`: relating_id = o Pset/Qto, related_id = o
   * elemento (o writer normaliza a direção — attrs 5/4). É essa relação que liga
   * um conjunto ao elemento; o Pset em si não sabe de quem é.
   */
  private static readSetLinks(
    t: arrow.Table,
    sets: Map<number, BimPropertySet>,
  ): Map<number, number[]> {
    const relTypes = (col<string[]>(t, 'rel_type') ?? []) as string[];
    const relating = col<Uint32Array>(t, 'relating_id') ?? new Uint32Array(0);
    const related = col<Uint32Array>(t, 'related_id') ?? new Uint32Array(0);

    const links = new Map<number, number[]>();
    for (let i = 0; i < relating.length; i++) {
      if ((relTypes[i] ?? '').toUpperCase() !== 'IFCRELDEFINESBYPROPERTIES') { continue; }
      const setId = relating[i];
      if (!sets.has(setId)) { continue; }
      const element = related[i];
      const current = links.get(element);
      if (current) { current.push(setId); } else { links.set(element, [setId]); }
    }
    return links;
  }

  /**
   * Seção espacial: `[nodes][elem→storey][elem→building][elem→site][elem→space][u32 project_id]`.
   * Só a tabela de nós interessa — ela já traz `children_ids`/`element_ids`,
   * então a árvore sai pronta sem reconstruir nada a partir das relações.
   */
  private static readSpatial(data: Uint8Array): {
    spatial: Map<number, RawSpatialNode>;
    roots: number[];
  } {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const nodesLen = view.getUint32(0, true);
    const nodes = table(new Uint8Array(data.buffer, data.byteOffset + 4, nodesLen));

    const ids = col<Uint32Array>(nodes, 'entity_id') ?? new Uint32Array(0);
    const parents = col<Uint32Array>(nodes, 'parent_id') ?? new Uint32Array(0);
    const typeNames = (col<string[]>(nodes, 'type_name') ?? []) as string[];
    const names = (col<(string | null)[]>(nodes, 'name') ?? []) as (string | null)[];
    const elevations = (col<(number | null)[]>(nodes, 'elevation') ?? []) as (number | null)[];
    const childrenList = nodes.getChild('children_ids');
    const elementsList = nodes.getChild('element_ids');

    const listAt = (
      list: ReturnType<arrow.Table['getChild']>,
      row: number,
    ): number[] => {
      const vector = list?.get(row) as { toArray(): ArrayLike<number> } | null | undefined;
      return vector ? Array.from(vector.toArray()) : [];
    };

    const spatial = new Map<number, RawSpatialNode>();
    for (let i = 0; i < ids.length; i++) {
      spatial.set(ids[i], {
        expressId: ids[i],
        parentId: parents[i] ?? 0,
        typeName: typeNames[i] ?? '',
        name: names[i] || undefined,
        elevation: elevations[i] ?? undefined,
        childrenIds: listAt(childrenList, i),
        elementIds: listAt(elementsList, i),
      });
    }

    // Raiz = quem não é filho de ninguém, lido de `children_ids` — a MESMA
    // coluna por onde `buildNode` desce, para as duas não poderem discordar.
    // Deduzir do `parent_id` já custou uma árvore inteira: há extração que
    // devolve o IfcProject apontando para o próprio neto (project → building →
    // site → project), e nesse ciclo nenhum nó sobra como raiz. Não assumimos
    // que a raiz é o IfcProject: modelo de disciplina pode vir sem ele.
    const roots: number[] = [];
    const children = new Set<number>();
    for (const node of spatial.values()) {
      for (const id of node.childrenIds) { children.add(id); }
    }

    if (children.size > 0) {
      for (const node of spatial.values()) {
        if (!children.has(node.expressId)) { roots.push(node.expressId); }
      }
    } else {
      // Sem `children_ids` a hierarquia só existe no `parent_id`; aqui o ciclo
      // precisa ser detectado na subida, senão o nó some da árvore em vez de
      // virar raiz.
      for (const node of spatial.values()) {
        const chain = new Set<number>([node.expressId]);
        let parent = node.parentId;
        while (parent && spatial.has(parent) && !chain.has(parent)) {
          chain.add(parent);
          parent = spatial.get(parent)!.parentId;
        }
        if (!parent || !spatial.has(parent) || chain.has(parent)) { roots.push(node.expressId); }
      }
    }
    return { spatial, roots };
  }

  /** Árvore espacial completa, com os elementos de cada nó agrupados por classe IFC. */
  getSpatialTree(): BimTreeNode[] {
    return this.roots.map((id) => this.buildNode(id)).filter((n): n is BimTreeNode => !!n);
  }

  private buildNode(expressId: number, seen = new Set<number>()): BimTreeNode | null {
    // Ciclo em `IfcRelAggregates` mal formado travaria a recursão.
    if (seen.has(expressId)) { return null; }
    seen.add(expressId);

    const raw = this.spatial.get(expressId);
    if (!raw) { return null; }

    const children = raw.childrenIds
      .map((child) => this.buildNode(child, seen))
      .filter((n): n is BimTreeNode => !!n);

    const groups = this.groupByType(raw.elementIds, expressId);
    const all = [...children, ...groups];
    const elementCount = all.reduce((sum, node) => sum + node.elementCount, 0);

    return {
      key: `n:${expressId}`,
      kind: 'spatial',
      name: raw.name || this.entities.labelOf(expressId),
      ifcType: raw.typeName,
      expressId,
      elevation: raw.elevation,
      elementCount,
      children: all,
    };
  }

  /** Elementos de um contêiner viram grupos por classe ("IfcWall (47)"). */
  private groupByType(elementIds: number[], parentId: number): BimTreeNode[] {
    const byType = new Map<string, number[]>();
    for (const id of elementIds) {
      const ifcType = this.entities.typeOf(id) || 'IfcElement';
      if (HIDDEN_IN_TREE.has(ifcType.toUpperCase())) { continue; }
      const bucket = byType.get(ifcType);
      if (bucket) { bucket.push(id); } else { byType.set(ifcType, [id]); }
    }

    return [...byType.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ifcType, ids]) => ({
        key: `g:${parentId}:${ifcType}`,
        kind: 'type-group' as const,
        name: ifcType,
        ifcType,
        elementCount: ids.length,
        expressIds: ids,
        children: [],
      }));
  }

  /** Rótulos sob demanda: a árvore trafega só ids; o nome vem quando expande. */
  getEntityLabels(expressIds: number[]): { expressId: number; name: string }[] {
    return expressIds.map((expressId) => ({
      expressId,
      name: this.entities.labelOf(expressId),
    }));
  }

  getEntityProperties(expressId: number): BimEntityProperties | null {
    const row = this.entities.rowOf(expressId);
    if (row < 0) { return null; }

    const propertySets: BimPropertySet[] = [];
    const quantitySets: BimPropertySet[] = [];
    for (const setId of this.setsOf.get(expressId) ?? []) {
      const set = this.sets.get(setId);
      if (!set || set.properties.length === 0) { continue; }
      (set.kind === 'qto' ? quantitySets : propertySets).push(set);
    }

    const byName = (a: BimPropertySet, b: BimPropertySet) => a.name.localeCompare(b.name);
    return {
      expressId,
      ifcType: this.entities.typeName[row] ?? '',
      name: this.entities.name[row] || undefined,
      globalId: this.entities.globalId[row] || undefined,
      description: this.entities.description?.[row] || undefined,
      objectType: this.entities.objectType?.[row] || undefined,
      tag: this.entities.tag?.[row] || undefined,
      predefinedType: this.entities.predefinedType?.[row] || undefined,
      propertySets: propertySets.sort(byName),
      quantitySets: quantitySets.sort(byName),
    };
  }
}
