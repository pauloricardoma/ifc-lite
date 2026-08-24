// Medições de distância e área. A geometria da cena está em METROS: o pipeline
// Rust aplica o `length_unit_scale` (unidade do arquivo → metro) antes de emitir
// os vértices, então aqui não há conversão de unidade nenhuma.

export type MeasureMode = 'none' | 'distance' | 'area';

export interface Vec3 { x: number; y: number; z: number }

/** O que o cursor pegou: quina, aresta, face ou o centro dela. */
export type SnapKind = 'vertex' | 'midpoint' | 'edge' | 'face' | 'face-center';

export interface SnapHint {
  kind: SnapKind;
}

/** Ponto sob o cursor JÁ com snap aplicado, mais o alvo que o produziu (quando houve). */
export interface RaycastHit {
  point: Vec3;
  snap?: SnapHint;
}

export interface Measurement {
  id: string;
  kind: 'distance' | 'area';
  points: Vec3[];
  /** Metros para distância, metros quadrados para área. */
  value: number;
  /** Só em área. */
  perimeter?: number;
  /** Já formatado com unidade — o app exibe sem reimplementar a regra. */
  label: string;
}

/** Raio (em px de tela) em que clicar no primeiro vértice fecha o polígono. */
const CLOSE_SNAP_PX = 12;

export const distance3 = (a: Vec3, b: Vec3): number =>
  Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);

/**
 * Normal do polígono por Newell: funciona com pontos só aproximadamente
 * coplanares (que é o caso — cada vértice vem de um raycast independente) e não
 * degenera quando três pontos consecutivos são colineares.
 */
export const polygonNormal = (points: Vec3[]): Vec3 => {
  const normal = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  }
  return normal;
};

/** Área do polígono planar (Newell dá o dobro do vetor-área). */
export const polygonArea = (points: Vec3[]): number => {
  if (points.length < 3) { return 0; }
  let sum = { x: 0, y: 0, z: 0 };
  const origin = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const c = cross(sub(points[i], origin), sub(points[i + 1], origin));
    sum = { x: sum.x + c.x, y: sum.y + c.y, z: sum.z + c.z };
  }
  return length(sum) / 2;
};

export const polygonPerimeter = (points: Vec3[]): number => {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    total += distance3(points[i], points[(i + 1) % points.length]);
  }
  return total;
};

/** Base ortonormal do plano do polígono, para levar os pontos a 2D. */
const planeBasis = (points: Vec3[]): { u: Vec3; v: Vec3 } | null => {
  const n = polygonNormal(points);
  const len = length(n);
  if (len < 1e-12) { return null; }
  const normal = { x: n.x / len, y: n.y / len, z: n.z / len };
  // Eixo auxiliar que não seja paralelo à normal, senão o produto vetorial zera.
  const aux = Math.abs(normal.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const u = cross(normal, aux);
  const ulen = length(u);
  if (ulen < 1e-12) { return null; }
  const un = { x: u.x / ulen, y: u.y / ulen, z: u.z / ulen };
  return { u: un, v: cross(normal, un) };
};

export const projectToPlane = (points: Vec3[], all: Vec3[]): { x: number; y: number }[] | null => {
  const basis = planeBasis(all);
  if (!basis) { return null; }
  const origin = all[0];
  return points.map((p) => {
    const d = sub(p, origin);
    return { x: dot(d, basis.u), y: dot(d, basis.v) };
  });
};

type P2 = { x: number; y: number };

const orientation = (a: P2, b: P2, c: P2): number => {
  const value = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(value) < 1e-12) { return 0; }
  return value > 0 ? 1 : 2;
};

/** Cruzamento próprio de segmentos (toque em extremidade não conta). */
export const segmentsCross = (p1: P2, p2: P2, p3: P2, p4: P2): boolean => {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
};

/**
 * O novo segmento cruzaria alguma aresta já traçada?
 *
 * Testado em 2D NO PLANO DO POLÍGONO, não na tela: em perspectiva duas arestas
 * se cruzam na projeção sem se cruzarem no espaço, e fechar o polígono por causa
 * disso seria fechar por acidente de ângulo de câmera.
 *
 * Importa porque shoelace num polígono auto-intersectante devolve área sem
 * significado — as partes de orientação oposta se cancelam.
 */
export const wouldSelfIntersect = (points: Vec3[], next: Vec3): boolean => {
  if (points.length < 3) { return false; }
  // O plano sai SÓ do que já foi traçado. Incluir o candidato degenera
  // justamente o caso que queremos detectar: num polígono em laço os dois lobos
  // têm orientação oposta e a normal de Newell se anula.
  const flat = projectToPlane([...points, next], points);
  if (!flat) { return false; }

  const last = flat[flat.length - 2];
  const candidate = flat[flat.length - 1];
  // Até `flat.length - 3`: a aresta que termina em `last` encosta no novo
  // segmento por definição, e encostar não é cruzar.
  for (let i = 0; i < flat.length - 3; i++) {
    if (segmentsCross(last, candidate, flat[i], flat[i + 1])) { return true; }
  }
  return false;
};

/**
 * O novo segmento cruza alguma aresta já traçada NA TELA?
 *
 * Complementa `wouldSelfIntersect`: para um polígono planar os dois testes dão o
 * mesmo resultado (a projeção de um plano é uma homografia, que preserva
 * cruzamento), mas os vértices vêm de raycasts em superfícies diferentes e aí o
 * plano de Newell é uma aproximação que deixa passar laço visível. O usuário
 * fecha pelo que vê, então o que se vê cruzado fecha.
 */
export const crossesOnScreen = (drawn: P2[], next: P2): boolean => {
  if (drawn.length < 3) { return false; }
  const last = drawn[drawn.length - 1];
  // Até `drawn.length - 3`: a aresta que termina em `last` encosta no novo
  // segmento por definição, e encostar não é cruzar.
  for (let i = 0; i < drawn.length - 2; i++) {
    if (segmentsCross(last, next, drawn[i], drawn[i + 1])) { return true; }
  }
  return false;
};

const formatNumber = (value: number, digits: number): string =>
  new Intl.NumberFormat(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);

export const formatLength = (meters: number): string => {
  if (meters < 0.01) { return `${formatNumber(meters * 1000, 1)} mm`; }
  if (meters < 1) { return `${formatNumber(meters * 100, 1)} cm`; }
  if (meters < 1000) { return `${formatNumber(meters, 3)} m`; }
  return `${formatNumber(meters / 1000, 2)} km`;
};

export const formatArea = (squareMeters: number): string => (
  squareMeters < 1
    ? `${formatNumber(squareMeters * 10000, 1)} cm²`
    : `${formatNumber(squareMeters, 2)} m²`
);

let counter = 0;
const nextId = (): string => `m${++counter}`;

export const buildMeasurement = (kind: 'distance' | 'area', points: Vec3[]): Measurement => {
  if (kind === 'distance') {
    const value = distance3(points[0], points[1]);
    return { id: nextId(), kind, points, value, label: formatLength(value) };
  }
  const value = polygonArea(points);
  return {
    id: nextId(),
    kind,
    points,
    value,
    perimeter: polygonPerimeter(points),
    label: formatArea(value),
  };
};

/** O clique fecha o polígono por proximidade do primeiro vértice? */
export const closesByProximity = (
  pointCount: number,
  cursor: P2 | null,
  firstOnScreen: P2 | null,
): boolean => (
  pointCount >= 3 && !!cursor && !!firstOnScreen
  && Math.hypot(cursor.x - firstOnScreen.x, cursor.y - firstOnScreen.y) <= CLOSE_SNAP_PX
);

export { CLOSE_SNAP_PX };
