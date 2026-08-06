import {
  Measurement,
  MeasureMode,
  Vec3,
  buildMeasurement,
  closesByProximity,
  crossesOnScreen,
  distance3,
  formatArea,
  formatLength,
  polygonArea,
  wouldSelfIntersect,
} from './measure.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LINE_COLOR = '#1a73e8';
const ACTIVE_COLOR = '#f9ab00';

interface P2 { x: number; y: number }

export interface MeasureToolDeps {
  container: HTMLElement;
  /** Mundo → px CSS do canvas; null quando o ponto está atrás da câmera. */
  project(point: Vec3): P2 | null;
  /** px CSS relativos ao canvas → ponto no mundo (com snap), null no vazio. */
  raycast(x: number, y: number): Vec3 | null;
  /**
   * Modo E lista, sempre juntos: o Esc sai do modo aqui dentro, e sem avisar o
   * app o botão da ferramenta ficaria aceso sobre uma medição que já acabou.
   */
  onChange(state: { mode: MeasureMode; measurements: Measurement[] }): void;
}

/**
 * Ferramenta de medição: estado dos pontos, regras de fechamento e o desenho.
 *
 * O overlay é SVG em px de tela, reprojetado a cada frame — não é geometria na
 * cena. Desenhar linha 3D exigiria pipeline própria no renderer, e o rótulo
 * precisaria de billboard; a projeção resolve os dois de graça e é o mesmo
 * caminho que o viewer do ifc-lite usa.
 */
export class MeasureTool {
  private mode: MeasureMode = 'none';
  private points: Vec3[] = [];
  private cursor: P2 | null = null;
  // Ponto do mundo sob o cursor, resolvido no pointermove. O raycast é CPU sobre
  // a BVH: refazê-lo no sync() custaria um por frame, não um por movimento.
  private cursorWorld: Vec3 | null = null;
  private measurements: Measurement[] = [];
  private svg: SVGSVGElement;

  constructor(private deps: MeasureToolDeps) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('style', [
      'position:absolute', 'inset:0', 'width:100%', 'height:100%',
      'pointer-events:none', 'overflow:visible',
    ].join(';'));
    // O container do viewer não é posicionado por padrão; sem isto o overlay
    // ancoraria no primeiro pai posicionado, que pode ser a página inteira.
    if (getComputedStyle(deps.container).position === 'static') {
      deps.container.style.position = 'relative';
    }
    deps.container.appendChild(this.svg);
  }

  isActive(): boolean { return this.mode !== 'none'; }

  setMode(mode: MeasureMode): void {
    this.mode = mode;
    this.points = [];
    this.cursor = null;
    this.cursorWorld = null;
    this.emit();
    this.sync();
  }

  /** `true` = o clique foi da medição (o motor não deve selecionar elemento). */
  handleClick(x: number, y: number): boolean {
    if (this.mode === 'none') { return false; }

    // Fechar por proximidade é testado ANTES do raycast: o primeiro vértice
    // costuma estar numa quina, e clicar na quina erra a geometria com
    // facilidade — exigir acerto ali seria não fechar justamente onde se mira.
    if (this.mode === 'area'
      && closesByProximity(this.points.length, { x, y }, this.firstOnScreen())) {
      this.commit();
      this.sync();
      return true;
    }

    const point = this.deps.raycast(x, y);
    if (!point) { return true; } // clique no vazio: consumido, mas sem ponto

    if (this.mode === 'distance') {
      this.points.push(point);
      if (this.points.length === 2) { this.commit(); }
      this.sync();
      return true;
    }

    // O segmento novo cruzaria o que já foi traçado: fecha o polígono com o
    // primeiro ponto em vez de aceitar o laço, que tornaria a área sem sentido.
    if (this.wouldCross(point, { x, y })) {
      this.commit();
      this.sync();
      return true;
    }

    this.points.push(point);
    this.sync();
    return true;
  }

  handleMove(x: number, y: number): void {
    if (this.mode === 'none') { return; }
    this.cursor = { x, y };
    // Só com medição em curso: fora dela a prévia não é desenhada, e o raycast
    // sairia a cada movimento do mouse à toa.
    this.cursorWorld = this.points.length > 0 ? this.deps.raycast(x, y) : null;
  }

  /** Duplo clique fecha a área em curso. */
  handleDoubleClick(): boolean {
    if (this.mode !== 'area' || this.points.length < 3) { return this.mode !== 'none'; }
    this.commit();
    this.sync();
    return true;
  }

  /**
   * Esc sai da ação inteira numa tecla só: descarta a medição em curso E sai do
   * modo. Exigir dois Esc (um pro traçado, outro pra ferramenta) deixa o usuário
   * sem saber em qual dos dois estados ele parou.
   */
  cancel(): boolean {
    if (this.mode === 'none') { return false; }
    this.setMode('none');
    return true;
  }

  clear(): void {
    this.measurements = [];
    this.points = [];
    this.emit();
    this.sync();
  }

  remove(id: string): void {
    this.measurements = this.measurements.filter((m) => m.id !== id);
    this.emit();
    this.sync();
  }

  dispose(): void {
    this.svg.remove();
  }

  private commit(): void {
    const kind = this.mode === 'area' ? 'area' : 'distance';
    if (kind === 'area' && this.points.length < 3) { return; }
    this.measurements = [...this.measurements, buildMeasurement(kind, this.points)];
    this.points = [];
    this.cursorWorld = null;
    this.emit();
  }

  private emit(): void {
    this.deps.onChange({ mode: this.mode, measurements: this.measurements });
  }

  private firstOnScreen(): P2 | null {
    return this.points.length > 0 ? this.deps.project(this.points[0]) : null;
  }

  /**
   * O segmento até `point` fecharia o polígono por cruzamento? Vale o traçado no
   * plano E o traçado na tela: o primeiro é o correto em geometria, o segundo é
   * o que o usuário enxerga quando os vértices não são exatamente coplanares.
   */
  private wouldCross(point: Vec3, cursor: P2 | null): boolean {
    if (this.points.length < 3) { return false; }
    if (wouldSelfIntersect(this.points, point)) { return true; }
    const tip = this.deps.project(point) ?? cursor;
    if (!tip) { return false; }
    const drawn = this.points.map((p) => this.deps.project(p));
    if (drawn.some((p) => !p)) { return false; } // algum vértice atrás da câmera
    return crossesOnScreen(drawn as P2[], tip);
  }

  /** Redesenha o overlay. Chamado a cada frame: a câmera muda, a tela muda. */
  sync(): void {
    if (this.measurements.length === 0 && this.points.length === 0) {
      if (this.svg.childNodes.length > 0) { this.svg.replaceChildren(); }
      return;
    }

    const nodes: SVGElement[] = [];
    for (const measurement of this.measurements) {
      nodes.push(...this.drawMeasurement(measurement));
    }
    nodes.push(...this.drawActive());
    this.svg.replaceChildren(...nodes);
  }

  private drawMeasurement(measurement: Measurement): SVGElement[] {
    const screen = measurement.points.map((p) => this.deps.project(p));
    if (screen.some((p) => !p)) { return []; } // algum vértice atrás da câmera
    const pts = screen as P2[];

    const nodes: SVGElement[] = [];
    if (measurement.kind === 'area') {
      nodes.push(this.polygon(pts, LINE_COLOR));
    } else {
      nodes.push(this.line(pts[0], pts[1], LINE_COLOR));
    }
    pts.forEach((p) => nodes.push(this.dot(p, LINE_COLOR)));
    nodes.push(this.label(centroid(pts), measurement.label));
    return nodes;
  }

  private drawActive(): SVGElement[] {
    if (this.points.length === 0) { return []; }

    const screen = this.points.map((p) => this.deps.project(p));
    if (screen.some((p) => !p)) { return []; }
    const pts = screen as P2[];
    const nodes: SVGElement[] = [];

    for (let i = 0; i < pts.length - 1; i++) {
      nodes.push(this.line(pts[i], pts[i + 1], ACTIVE_COLOR));
    }
    // Ponta da prévia no ponto COM SNAP quando existe: é o que mostra onde o
    // clique vai cair de verdade, não onde o cursor está.
    const tip = (this.cursorWorld && this.deps.project(this.cursorWorld)) || this.cursor;
    if (tip) {
      nodes.push(this.line(pts[pts.length - 1], tip, ACTIVE_COLOR, true));
      const preview = this.previewLabel();
      if (preview) { nodes.push(this.label(midpoint(pts[pts.length - 1], tip), preview)); }
    }
    // Primeiro vértice destacado quando o próximo clique fecharia — por
    // proximidade ou por cruzamento. Sem isto as duas regras seriam invisíveis
    // até acontecerem, e o polígono fecharia "sozinho" aos olhos do usuário.
    const closing = closesByProximity(this.points.length, this.cursor, pts[0])
      || (!!this.cursorWorld && this.wouldCross(this.cursorWorld, this.cursor));
    pts.forEach((p, i) => nodes.push(this.dot(p, ACTIVE_COLOR, i === 0 && closing)));
    return nodes;
  }

  /** Valor da prévia: a distância até o cursor, ou a área do que já está fechado. */
  private previewLabel(): string {
    if (this.mode === 'distance' || this.points.length < 3) {
      return this.cursorWorld
        ? formatLength(distance3(this.points[this.points.length - 1], this.cursorWorld))
        : '';
    }
    return formatArea(polygonArea(this.points));
  }

  private line(a: P2, b: P2, color: string, dashed = false): SVGElement {
    const el = document.createElementNS(SVG_NS, 'line');
    el.setAttribute('x1', String(a.x));
    el.setAttribute('y1', String(a.y));
    el.setAttribute('x2', String(b.x));
    el.setAttribute('y2', String(b.y));
    el.setAttribute('stroke', color);
    el.setAttribute('stroke-width', '2');
    if (dashed) { el.setAttribute('stroke-dasharray', '5 4'); }
    return el;
  }

  private polygon(points: P2[], color: string): SVGElement {
    const el = document.createElementNS(SVG_NS, 'polygon');
    el.setAttribute('points', points.map((p) => `${p.x},${p.y}`).join(' '));
    el.setAttribute('fill', color);
    el.setAttribute('fill-opacity', '0.18');
    el.setAttribute('stroke', color);
    el.setAttribute('stroke-width', '2');
    return el;
  }

  private dot(p: P2, color: string, highlighted = false): SVGElement {
    const el = document.createElementNS(SVG_NS, 'circle');
    el.setAttribute('cx', String(p.x));
    el.setAttribute('cy', String(p.y));
    el.setAttribute('r', highlighted ? '7' : '4');
    el.setAttribute('fill', highlighted ? '#fff' : color);
    el.setAttribute('stroke', color);
    el.setAttribute('stroke-width', '2');
    return el;
  }

  private label(p: P2, text: string): SVGElement {
    const el = document.createElementNS(SVG_NS, 'text');
    el.setAttribute('x', String(p.x));
    el.setAttribute('y', String(p.y - 8));
    el.setAttribute('text-anchor', 'middle');
    el.setAttribute('font-size', '12');
    el.setAttribute('font-family', 'system-ui, sans-serif');
    el.setAttribute('font-weight', '600');
    el.setAttribute('fill', '#fff');
    // Contorno escuro: o rótulo cai tanto sobre fundo claro quanto sobre a peça.
    el.setAttribute('stroke', 'rgba(0,0,0,0.75)');
    el.setAttribute('stroke-width', '3');
    el.setAttribute('paint-order', 'stroke');
    el.textContent = text;
    return el;
  }
}

const centroid = (points: P2[]): P2 => ({
  x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
  y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
});

const midpoint = (a: P2, b: P2): P2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
