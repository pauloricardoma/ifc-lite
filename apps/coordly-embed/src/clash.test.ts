import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clashMemberKey, createClashEngine, type Clash } from '@ifc-lite/clash';
import {
  buildClashElements,
  countClashTypes,
  dedupePairs,
  dropExcluded,
  dropWithinTolerance,
  indexClashLinks,
  scopeRules,
  toClashItems,
  toEngineRules,
  wantedByRules,
  type ClashMeshPiece,
  type ClashRuleInput,
  type ClashRunOptions,
} from './clash.js';

const STEP = 50_000_000;
const BOX_INDICES = new Uint32Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 5, 1, 0, 4, 5,
  3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
]);

/** Caixa de `min` a `max`, relativa a `origin` (como a cena guarda). */
function box(
  expressId: number,
  ifcType: string,
  min: [number, number, number],
  max: [number, number, number],
  origin?: [number, number, number],
): ClashMeshPiece {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    expressId,
    ifcType,
    origin,
    positions: new Float32Array([
      x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
      x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
    ]),
    indices: BOX_INDICES.slice(),
  };
}

const MODELS = ['estrutura', 'hidraulica', 'eletrica'];
const modelOf = (sceneId: number) => MODELS[Math.floor(sceneId / STEP)];
const localOf = (sceneId: number) => sceneId % STEP;
const ALL: ClashRuleInput = { id: 'all', name: 'Todos' };
const HARD: ClashRunOptions = { mode: 'hard', crossModelOnly: true };

const build = (pieces: ClashMeshPiece[], rules: ClashRuleInput[], crossModelOnly = true, models = MODELS.slice(0, 2)) => {
  const scoped = scopeRules(rules, models, crossModelOnly);
  return { scoped, ...buildClashElements(pieces, { modelOf, wanted: wantedByRules(scoped), keyOf: () => undefined }) };
};

// Viga de 1 m e tubo atravessando, a ~700 km da origem (coordenada UTM).
const FAR: [number, number, number] = [712_345.678, 12.5, 7_654_321.123];
const beam = box(10, 'IfcBeam', [0, 0, 0], [1, 0.3, 0.2], FAR);
const pipe = (overlap: number) =>
  box(STEP + 20, 'IfcPipeSegment', [0.4, 0.3 - overlap, 0.05], [0.5, 0.8, 0.15], FAR);

describe('buildClashElements', () => {
  it('rebaixa para um frame perto de zero sem perder o milímetro', () => {
    const { elements, frame } = build([beam, pipe(0.001)], [ALL]);
    assert.deepEqual(frame, FAR);
    const p = elements.find((e) => e.tag === 'IfcPipeSegment')!;
    const b = elements.find((e) => e.tag === 'IfcBeam')!;
    // Em f32 absoluto, a 7.6e6 m, o passo é de 0,5 m — o 1 mm sumiria.
    assert.ok(Math.abs(b.bounds.max[1] - p.bounds.min[1] - 0.001) < 1e-6);
    assert.ok(Math.abs(p.bounds.max[0]) < 1);
  });

  it('junta as peças do mesmo elemento e reindexa', () => {
    const a = box(10, 'IfcBeam', [0, 0, 0], [1, 1, 1]);
    const b = box(10, 'IfcBeam', [2, 0, 0], [3, 1, 1]);
    const { elements } = build([a, b], [ALL], false);
    assert.equal(elements.length, 1);
    assert.equal(elements[0].positions.length, 48);
    assert.equal(elements[0].indices[36], BOX_INDICES[0] + 8);
    assert.deepEqual(elements[0].bounds.max, [3, 1, 1]);
  });

  it('deixa de fora o que nenhuma regra pede, template de tipo e peça sem modelo', () => {
    const cable = box(2 * STEP + 1, 'IfcCableSegment', [0, 0, 0], [1, 1, 1]);
    const template = { ...box(11, 'IfcBeam', [0, 0, 0], [1, 1, 1]), geometryClass: 2 };
    const orphan = box(9 * STEP, 'IfcBeam', [0, 0, 0], [1, 1, 1]);
    const { elements } = build([cable, template, orphan, beam], [ALL]);
    assert.deepEqual(elements.map((e) => e.ref), [10]);
  });

  it('usa o GlobalId como chave quando há', () => {
    const { elements } = buildClashElements([beam], {
      modelOf,
      wanted: () => true,
      keyOf: (id) => (id === 10 ? '2O2Fr$t4X7Zf8NOew3FLOH' : undefined),
    });
    assert.equal(elements[0].key, '2O2Fr$t4X7Zf8NOew3FLOH');
  });
});

describe('countClashTypes', () => {
  it('conta elementos (não peças) por tipo, só dos modelos na cena', () => {
    const types = countClashTypes(
      [box(10, 'IfcBeam', [0, 0, 0], [1, 1, 1]), box(10, 'IfcBeam', [2, 0, 0], [3, 1, 1]),
        box(11, 'IfcBeam', [0, 0, 0], [1, 1, 1]), box(12, 'IfcSlab', [0, 0, 0], [1, 1, 1]),
        box(9 * STEP, 'IfcWall', [0, 0, 0], [1, 1, 1])],
      (id) => id < STEP,
    );
    assert.deepEqual(types, [{ ifcType: 'IfcBeam', count: 2 }, { ifcType: 'IfcSlab', count: 1 }]);
  });
});

describe('scopeRules', () => {
  it('só entre modelos: uma regra por par de modelos', () => {
    const scoped = scopeRules([ALL], MODELS, true);
    assert.deepEqual(scoped.map((r) => [r.a.models, r.b.models]), [
      [['estrutura'], ['hidraulica']],
      [['estrutura'], ['eletrica']],
      [['hidraulica'], ['eletrica']],
    ]);
  });

  it('regra assimétrica roda nas duas direções', () => {
    const scoped = scopeRules([{ id: 'r', name: 'r', a: 'IfcPipe*', b: 'IfcBeam' }], MODELS.slice(0, 2), true);
    assert.deepEqual(scoped.map((r) => [r.a.models[0], r.a.types, r.b.models[0], r.b.types]), [
      ['estrutura', 'IfcPipe*', 'hidraulica', 'IfcBeam'],
      ['hidraulica', 'IfcPipe*', 'estrutura', 'IfcBeam'],
    ]);
  });

  it('com um modelo só, ou sem o switch, testa dentro dos arquivos', () => {
    assert.deepEqual(scopeRules([ALL], ['estrutura'], true), [
      { id: 'all', a: { models: ['estrutura'], types: '*' }, b: { models: ['estrutura'], types: '*' } },
    ]);
    assert.equal(scopeRules([ALL], MODELS, false).length, 1);
  });
});

describe('toEngineRules', () => {
  const pieces = [
    box(10, 'IfcBeam', [0, 0, 0], [1, 1, 1]),
    box(11, 'IfcSlab', [0, 0, 0], [1, 1, 1]),
    box(STEP + 20, 'IfcPipeSegment', [0, 0, 0], [1, 1, 1]),
    box(STEP + 21, 'IfcValve', [0, 0, 0], [1, 1, 1]),
  ];

  it('lados viram membros por modelo e tipo, com a tolerância global', () => {
    const { scoped, elements } = build(pieces, [{ id: 'r', name: 'r', a: 'IfcPipe*', b: 'IfcBeam' }]);
    const [there, back] = toEngineRules(scoped, elements, { mode: 'hard', tolerance: 0.01 });
    assert.deepEqual(there.membersA, []);
    assert.deepEqual(back.membersA, [clashMemberKey('hidraulica', STEP + 20)]);
    assert.deepEqual(back.membersB, [clashMemberKey('estrutura', 10)]);
    assert.equal(back.tolerance, 0.01);
  });

  it('lados iguais viram self-clash', () => {
    const { scoped, elements } = build(pieces, [ALL], false);
    const [r] = toEngineRules(scoped, elements, { mode: 'hard' });
    assert.equal(r.b, undefined);
    assert.equal(r.membersA!.length, 4);
  });

  it('clearance leva a folga, não a tolerância', () => {
    const { scoped, elements } = build(pieces, [ALL]);
    const [r] = toEngineRules(scoped, elements, { mode: 'clearance', clearance: 0.05, tolerance: 0.01 });
    assert.equal(r.clearance, 0.05);
    assert.equal(r.tolerance, undefined);
  });
});

const clash = (rule: string, a: [string, number], b: [string, number]): Clash => ({
  id: `${rule} ${a} ${b}`,
  rule,
  status: 'hard',
  distance: -0.1,
  point: [0, 0, 0],
  bounds: { min: [0, 0, 0], max: [0, 0, 0] },
  severity: 'info',
  a: { key: `#${a[1]}`, ref: a[1], model: a[0], tag: 'X' },
  b: { key: `#${b[1]}`, ref: b[1], model: b[0], tag: 'Y' },
});

describe('dropExcluded', () => {
  // Parede 1 hospeda a porta 2 (pela abertura); degraus 5 e 6 são da escada 4.
  const links = new Map([['arq', indexClashLinks({
    hostFiller: Uint32Array.from([1, 2]),
    partOf: Uint32Array.from([5, 4, 6, 4]),
  })]]);
  const keep = (c: Clash) => dropExcluded([c], links, localOf).length === 1;

  it('tira hospedeiro × preenchimento, peça × montagem e peças irmãs', () => {
    assert.equal(keep(clash('all', ['arq', 2], ['arq', 1])), false);
    assert.equal(keep(clash('all', ['arq', 5], ['arq', 4])), false);
    assert.equal(keep(clash('all', ['arq', 5], ['arq', 6])), false);
  });

  it('não tira o resto, nem a mesma relação em outro arquivo', () => {
    assert.equal(keep(clash('all', ['arq', 1], ['arq', 5])), true);
    assert.equal(keep(clash('all', ['arq', 1], ['est', 2])), true);
  });
});

describe('dedupePairs', () => {
  it('par achado por duas regras fica com a primeira na ordem do app', () => {
    const out = dedupePairs(
      [clash('all', ['a', 1], ['b', 2]), clash('mep~1', ['b', 2], ['a', 1])],
      ['mep', 'all'],
    );
    assert.deepEqual(out.map((c) => c.rule), ['mep~1']);
  });
});

describe('dropWithinTolerance', () => {
  it('penetração até a tolerância não conta; clearance não é cortado', () => {
    const shallow = { ...clash('all', ['a', 1], ['b', 2]), distance: -0.005 };
    const gap = { ...shallow, status: 'clearance' as const, distance: 0.01 };
    assert.equal(dropWithinTolerance([shallow], { mode: 'hard', tolerance: 0.01 }).length, 0);
    assert.equal(dropWithinTolerance([shallow], { mode: 'hard', tolerance: 0.002 }).length, 1);
    assert.equal(dropWithinTolerance([gap], { mode: 'clearance' }).length, 1);
  });
});

describe('ponta a ponta com o motor', () => {
  const run = async (overlap: number, tolerance?: number) => {
    const { scoped, elements, frame } = build([beam, pipe(overlap)], [ALL]);
    const options = { ...HARD, tolerance };
    const result = await createClashEngine({ backend: 'ts' }).run(elements, toEngineRules(scoped, elements, options));
    return toClashItems(dropWithinTolerance(result.clashes, options), new Map(), frame, localOf);
  };

  it('acha o tubo atravessando a viga, com id do arquivo e ponto na cena', async () => {
    const items = await run(0.05);
    assert.equal(items.length, 1);
    const [c] = items;
    const sides = [c.a, c.b].sort((x, y) => x.modelId.localeCompare(y.modelId));
    assert.deepEqual(sides.map((s) => [s.modelId, s.expressId, s.ifcType]), [
      ['estrutura', 10, 'IfcBeam'],
      ['hidraulica', 20, 'IfcPipeSegment'],
    ]);
    assert.equal(c.rule, 'all');
    assert.ok(Math.abs(c.point[0] - FAR[0]) < 2);
    assert.ok(Math.abs(c.point[2] - FAR[2]) < 2);
  });

  it('mudar a tolerância muda a contagem', async () => {
    assert.equal((await run(0.005, 0.002)).length, 1);
    assert.equal((await run(0.005, 0.01)).length, 0);
  });
});
