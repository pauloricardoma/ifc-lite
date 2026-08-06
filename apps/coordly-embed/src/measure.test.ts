import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  closesByProximity,
  distance3,
  polygonArea,
  polygonPerimeter,
  formatArea,
  formatLength,
  segmentsCross,
  wouldSelfIntersect,
} from './measure.js';

const near = (actual: number, expected: number, tolerance = 1e-9) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `esperado ~${expected}, veio ${actual}`,
  );
};

describe('distance3', () => {
  it('mede em linha reta no espaco', () => {
    near(distance3({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }), 5);
    near(distance3({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }), 0);
  });
});

describe('polygonArea', () => {
  it('quadrado 2x2 no plano XY', () => {
    near(polygonArea([
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 2, y: 2, z: 0 },
      { x: 0, y: 2, z: 0 },
    ]), 4);
  });

  // O caso real: parede/rampa nao esta alinhada com nenhum eixo.
  it('independe da orientacao do plano', () => {
    near(polygonArea([
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 2, y: 0, z: 3 },
      { x: 0, y: 0, z: 3 },
    ]), 6);

    const diagonal = Math.SQRT1_2;
    near(polygonArea([
      { x: 0, y: 0, z: 0 },
      { x: diagonal, y: diagonal, z: 0 },
      { x: diagonal, y: diagonal, z: 1 },
      { x: 0, y: 0, z: 1 },
    ]), 1, 1e-12);
  });

  it('triangulo e menos de tres pontos', () => {
    near(polygonArea([{ x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }]), 6);
    near(polygonArea([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]), 0);
  });

  // Cada vertice vem de um raycast independente: coplanaridade exata nao existe.
  it('tolera pontos quase coplanares', () => {
    const area = polygonArea([
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0.001 },
      { x: 2, y: 2, z: 0 },
      { x: 0, y: 2, z: 0.001 },
    ]);
    near(area, 4, 0.01);
  });
});

describe('polygonPerimeter', () => {
  it('fecha o circuito de volta ao primeiro ponto', () => {
    near(polygonPerimeter([
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 2, y: 2, z: 0 },
      { x: 0, y: 2, z: 0 },
    ]), 8);
  });
});

describe('segmentsCross', () => {
  it('cruzamento em X', () => {
    assert.equal(
      segmentsCross({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 }),
      true,
    );
  });

  it('encostar na ponta nao e cruzar', () => {
    assert.equal(
      segmentsCross({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }),
      false,
    );
  });

  it('paralelos nunca cruzam', () => {
    assert.equal(
      segmentsCross({ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 1 }),
      false,
    );
  });
});

describe('wouldSelfIntersect', () => {
  const square = [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 2, y: 2, z: 0 },
  ];

  it('nao testa nada com menos de tres pontos', () => {
    assert.equal(wouldSelfIntersect([{ x: 0, y: 0, z: 0 }], { x: 1, y: 1, z: 0 }), false);
    assert.equal(
      wouldSelfIntersect([{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }], { x: 2, y: 2, z: 0 }),
      false,
    );
  });

  it('quarto ponto que fecha o quadrado nao cruza nada', () => {
    assert.equal(wouldSelfIntersect(square, { x: 0, y: 2, z: 0 }), false);
  });

  // O caso que motiva a regra: shoelace num poligono em laco devolve area sem
  // significado, entao o clique fecha o poligono em vez de aceitar o cruzamento.
  it('quarto ponto que cria um laco cruza', () => {
    assert.equal(wouldSelfIntersect(square, { x: 1, y: -1, z: 0 }), true);
  });
});

describe('closesByProximity', () => {
  const first = { x: 100, y: 100 };

  it('so vale a partir do terceiro ponto', () => {
    assert.equal(closesByProximity(2, { x: 100, y: 100 }, first), false);
    assert.equal(closesByProximity(3, { x: 100, y: 100 }, first), true);
  });

  it('respeita o raio de captura', () => {
    assert.equal(closesByProximity(3, { x: 108, y: 100 }, first), true);
    assert.equal(closesByProximity(3, { x: 130, y: 100 }, first), false);
  });

  it('sem cursor ou sem o primeiro vertice na tela, nao fecha', () => {
    assert.equal(closesByProximity(4, null, first), false);
    assert.equal(closesByProximity(4, { x: 100, y: 100 }, null), false);
  });
});

describe('formatacao com unidade', () => {
  it('escolhe a unidade pela ordem de grandeza', () => {
    assert.match(formatLength(0.005), /mm$/);
    assert.match(formatLength(0.5), /cm$/);
    assert.match(formatLength(12.3), /m$/);
    assert.match(formatLength(2500), /km$/);
    assert.match(formatArea(0.2), /cm²$/);
    assert.match(formatArea(42.7), /m²$/);
  });
});
