import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SectionPlane } from '@ifc-lite/renderer';
import { bcfPlaneToSection, sectionToBcfPlane, withBoundsRange } from './section-bcf.js';

// Cena Y-up. No BCF (Z-up): x = x, y = −z, z = y.
const bounds = { min: { x: 0, y: 0, z: -20 }, max: { x: 10, y: 30, z: 0 } };

const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) <= 1e-9, `esperado ~${expected}, veio ${actual}`);

describe('sectionToBcfPlane', () => {
  it('corte horizontal sem inverter esconde o que está acima: direção +Z', () => {
    const plane = sectionToBcfPlane({ axis: 'down', position: 50, enabled: true }, bounds)!;
    near(plane.location.z, 15);
    assert.deepEqual([plane.direction.x, plane.direction.y, plane.direction.z].map((v) => v + 0), [0, 0, 1]);
  });

  it('invertido aponta para o lado oposto', () => {
    const plane = sectionToBcfPlane({ axis: 'side', position: 20, enabled: true, flipped: true }, bounds)!;
    near(plane.location.x, 2);
    near(plane.direction.x, -1);
  });

  it('eixo de profundidade troca Z da cena por −Y do BCF', () => {
    const plane = sectionToBcfPlane({ axis: 'front', position: 25, enabled: true }, bounds)!;
    near(plane.location.y, 15);
    near(plane.direction.y, -1);
  });

  it('corte desligado não vira plano', () => {
    assert.equal(sectionToBcfPlane({ axis: 'down', position: 50, enabled: false }, bounds), null);
  });
});

describe('bcfPlaneToSection', () => {
  it('ida e volta preserva eixo, posição e lado', () => {
    const cases: SectionPlane[] = [
      { axis: 'down', position: 37, enabled: true, flipped: false },
      { axis: 'down', position: 80, enabled: true, flipped: true },
      { axis: 'side', position: 10, enabled: true, flipped: false },
      { axis: 'front', position: 65, enabled: true, flipped: true },
    ];
    for (const section of cases) {
      const back = bcfPlaneToSection(sectionToBcfPlane(section, bounds)!, bounds);
      assert.equal(back.axis, section.axis);
      assert.equal(back.flipped, section.flipped);
      near(back.position, section.position);
    }
  });

  it('plano inclinado de fora cai no eixo dominante', () => {
    const section = bcfPlaneToSection(
      { location: { x: 5, y: 10, z: 6 }, direction: { x: 0.2, y: 0, z: -0.98 } },
      bounds,
    );
    assert.equal(section.axis, 'down');
    assert.equal(section.flipped, true);
    near(section.position, 20);
  });

  it('plano fora da caixa fica no limite', () => {
    const section = bcfPlaneToSection(
      { location: { x: 0, y: 0, z: 99 }, direction: { x: 0, y: 0, z: 1 } },
      bounds,
    );
    assert.equal(section.position, 100);
  });
});

describe('withBoundsRange', () => {
  it('prende o range ao eixo do corte', () => {
    const section = withBoundsRange({ axis: 'front', position: 50, enabled: true }, bounds);
    assert.equal(section.min, -20);
    assert.equal(section.max, 0);
  });

  it('sem caixa não mexe', () => {
    const section: SectionPlane = { axis: 'down', position: 50, enabled: true };
    assert.equal(withBoundsRange(section, null), section);
  });
});
