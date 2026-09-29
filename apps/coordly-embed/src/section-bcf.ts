import { clippingPlaneToSectionPlane, sectionPlaneToClippingPlane } from '@ifc-lite/bcf';
import type { BCFClippingPlane, BCFDirection, ViewerBounds } from '@ifc-lite/bcf';
import type { SectionPlane } from '@ifc-lite/renderer';

// No BCF a direção aponta para o lado ESCONDIDO; o renderer, sem `flipped`,
// esconde o lado +eixo. As funções do `@ifc-lite/bcf` gravam a direção ao
// contrário (−eixo sem `flipped`) — coerente entre elas, mas o corte abriria
// invertido na usBIM/BIMcollab. Reusamos a troca de eixos e a % delas e só
// invertemos a direção na fronteira.
const negate = (d: BCFDirection): BCFDirection => ({ x: -d.x, y: -d.y, z: -d.z });

export function sectionToBcfPlane(section: SectionPlane, bounds: ViewerBounds): BCFClippingPlane | null {
  const plane = sectionPlaneToClippingPlane(
    { axis: section.axis, position: section.position, enabled: section.enabled, flipped: !!section.flipped },
    bounds,
  );
  return plane ? { location: plane.location, direction: negate(plane.direction) } : null;
}

/** Plano inclinado cai no eixo dominante; a posição fica entre 0 e 100%. */
export function bcfPlaneToSection(plane: BCFClippingPlane, bounds: ViewerBounds): SectionPlane {
  const { axis, position, flipped } = clippingPlaneToSectionPlane(
    { location: plane.location, direction: negate(plane.direction) },
    bounds,
  );
  return { axis, position, flipped, enabled: true };
}

/**
 * Prende o range do slider à mesma caixa que a conversão usa. Sem isto o
 * renderer mede a % sobre a caixa dos lotes da GPU, que pode divergir da do
 * modelo — e o corte gravado cairia noutro lugar ao reabrir.
 */
export function withBoundsRange(section: SectionPlane, bounds: ViewerBounds | null): SectionPlane {
  if (!bounds) { return section; }
  const key = section.axis === 'side' ? 'x' : section.axis === 'down' ? 'y' : 'z';
  return { ...section, min: bounds.min[key], max: bounds.max[key] };
}
