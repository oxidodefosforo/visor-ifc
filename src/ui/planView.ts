import type { Viewer } from "../viewer/Viewer";
import { ModelIndex, type Storey } from "../analysis/modelIndex";
import { computePlan, type PlanData } from "../analysis/plan";
import { drawingToDxf, drawingToPdf, type Drawing, type Prim, type Style } from "../analysis/drawingExport";
import { download } from "../analysis/xlsx";
import { esc } from "./analysis/types";

/**
 * Planta 2D de un nivel: corte horizontal con la geometría real, proyección de lo que queda por
 * encima (discontinuo) y por debajo, cotas generales y cotas a mano (2 clics, con imán a vértices),
 * exportación a PDF (A3, a escala normalizada) y DXF (metros, capas por clase IFC).
 */
const SCALES = [20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 750, 1000, 1250, 1500, 2000, 2500, 5000];
const PAPER: [number, number] = [420, 297]; // A3 horizontal
const AREA: [number, number, number, number] = [15, 32, 390, 255]; // zona de dibujo (mm), deja sitio al cajetín
type Dim = { x1: number; y1: number; x2: number; y2: number };

export class PlanView {
  private root: HTMLElement;
  private svg!: SVGSVGElement;
  private storeys: Storey[] = [];
  private storey: Storey | null = null;
  private cut = 1.2;
  private plan: PlanData | null = null;
  private dims: Dim[] = [];
  private dimTool = false;
  private pending: { x: number; y: number } | null = null;
  private show = { fill: true, above: true, below: true };
  private view = { x: 0, y: 0, w: 10, h: 10 };
  private index: ModelIndex | null = null;
  private indexModel = "";
  private busy = false;

  constructor(private viewer: Viewer, private notify: (m: string, k?: "info" | "error") => void, private modelName: () => string) {
    this.root = document.createElement("div");
    this.root.className = "plan-view";
    this.root.hidden = true;
    document.body.append(this.root);
    this.root.addEventListener("click", (e) => void this.onClick(e));
    this.root.addEventListener("change", (e) => this.onChange(e));
    window.addEventListener("keydown", (e) => {
      if (this.root.hidden) return;
      // Con la planta abierta, las teclas no mueven la cámara 3D de detrás.
      if ((e.target as HTMLElement)?.tagName !== "INPUT") e.stopPropagation();
      if (e.key === "Escape") {
        e.stopPropagation();
        if (this.pending || this.dimTool) (this.pending = null), (this.dimTool = false), this.renderToolbar(), this.draw();
        else this.close();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && this.dims.length) {
        this.dims.pop();
        this.draw();
      }
    }, true);
  }

  get isOpen() {
    return !this.root.hidden;
  }

  async open() {
    const model = this.viewer.model;
    if (!model) return;
    this.root.hidden = false;
    document.body.dataset.plan = "open";
    if (!this.index || this.indexModel !== model.modelId) {
      this.root.innerHTML = `<div class="plan-loading">Leyendo niveles del modelo…</div>`;
      this.index = await ModelIndex.build(model);
      this.indexModel = model.modelId;
      this.storeys = this.index.storeys;
      this.storey = this.storeys.find((s) => Math.abs(s.elevation) < 0.01) ?? this.storeys[0] ?? null;
      this.plan = null;
      this.dims = [];
    }
    this.layout();
    if (!this.storey) {
      this.svg.innerHTML = "";
      this.root.querySelector(".plan-status")!.textContent = "El modelo no tiene niveles (IfcBuildingStorey).";
      return;
    }
    if (!this.plan) await this.generate();
    else this.draw();
  }

  close() {
    this.root.hidden = true;
    document.body.dataset.plan = "closed";
  }

  /** El modelo cambió o se cerró. */
  reset() {
    this.index = null;
    this.plan = null;
    this.dims = [];
    if (!this.root.hidden) this.close();
  }

  private layout() {
    this.root.innerHTML = `
      <div class="plan-bar">
        <b>Planta 2D</b>
        <span class="plan-levels">${this.storeys.map((s) => `<button data-storey="${s.localId}" class="${s === this.storey ? "active" : ""}">${esc(s.name)} <small>${s.elevation.toFixed(2)}</small></button>`).join("")}</span>
        <label>Corte a <input type="number" step="0.1" min="0.1" max="10" value="${this.cut}" data-role="cut" style="width:56px"/> m</label>
        <span class="plan-tools"></span>
        <span class="spacer"></span>
        <button data-act="pdf" class="primary">PDF (A3)</button>
        <button data-act="dxf">DXF</button>
        <button data-act="close" class="icon" title="Cerrar (Esc)">×</button>
      </div>
      <div class="plan-canvas"><svg xmlns="http://www.w3.org/2000/svg"></svg></div>
      <div class="plan-status"></div>`;
    this.svg = this.root.querySelector("svg")!;
    this.renderToolbar();
    this.setupPanZoom();
  }

  private renderToolbar() {
    const t = this.root.querySelector(".plan-tools");
    if (!t) return;
    t.innerHTML = `
      <label class="chk"><input type="checkbox" data-show="fill" ${this.show.fill ? "checked" : ""}/> Relleno del corte</label>
      <label class="chk"><input type="checkbox" data-show="above" ${this.show.above ? "checked" : ""}/> Por encima (discontinuo)</label>
      <label class="chk"><input type="checkbox" data-show="below" ${this.show.below ? "checked" : ""}/> Por debajo</label>
      <button data-act="dim" class="${this.dimTool ? "active" : ""}" title="Cota: clic en dos puntos (imán a vértices). Ctrl+Z deshace">Cota</button>
      <button data-act="clear-dims" ${this.dims.length ? "" : "disabled"}>Borrar cotas</button>`;
  }

  /** Calcula la planta del nivel elegido. Público para pruebas. */
  async generate() {
    const model = this.viewer.model;
    if (!model || !this.index || !this.storey || this.busy) return null;
    this.busy = true;
    const status = this.root.querySelector(".plan-status");
    if (status) status.textContent = "Cortando la geometría…";
    try {
      const t0 = performance.now();
      this.plan = await computePlan(model, this.index, this.storey, this.cut, (d, t) => status && (status.textContent = `Cortando la geometría… ${d}/${t}`));
      const b = this.plan.bounds;
      const pad = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.08 + 1;
      this.view = { x: b.minX - pad, y: -(b.maxY + pad), w: b.maxX - b.minX + pad * 2, h: b.maxY - b.minY + pad * 2 };
      this.draw();
      const counts = { cut: 0, above: 0, below: 0 };
      for (const e of this.plan.elements) counts[e.layer]++;
      if (status) status.textContent = `${this.storey.name} · corte a ${this.cut.toFixed(2)} m · ${counts.cut} cortados, ${counts.above} por encima, ${counts.below} por debajo · escala de impresión 1:${this.scaleFor(this.plan.bounds)} en A3 · ${((performance.now() - t0) / 1000).toFixed(1)} s`;
      return counts;
    } finally {
      this.busy = false;
    }
  }

  private styles(): Record<string, Style> {
    return {
      cut: { width: 0.5, color: [20, 20, 20] },
      below: { width: 0.18, color: [110, 110, 110] },
      above: { width: 0.18, color: [110, 110, 110], dash: [1.5, 1] },
      dim: { width: 0.13, color: [20, 70, 160] },
      frame: { width: 0.35, color: [0, 0, 0] },
      thin: { width: 0.18, color: [0, 0, 0] },
    };
  }

  /** Composición del dibujo (también lo que se exporta). */
  drawing(scaleOverride?: number): Drawing {
    const p = this.plan!;
    const prims: Prim[] = [];
    const layers = new Map<string, number>();
    const ACI: Record<string, number> = { cut: 7, below: 8, above: 9 };
    const PREFIX: Record<string, string> = { cut: "CORTE", below: "INFERIOR", above: "SUPERIOR" };
    for (const e of p.elements) {
      if ((e.layer === "above" && !this.show.above) || (e.layer === "below" && !this.show.below)) continue;
      const layer = `${PREFIX[e.layer]}-${e.ifcClass}`;
      layers.set(layer, ACI[e.layer]);
      if (e.layer === "cut" && this.show.fill && e.loops.length) {
        prims.push({ t: "fill", layer: `RELLENO-${e.ifcClass}`, color: [205, 205, 205], loops: e.loops });
        layers.set(`RELLENO-${e.ifcClass}`, 253);
      }
      for (const [x1, y1, x2, y2] of e.segs) prims.push({ t: "line", layer, style: e.layer, x1, y1, x2, y2 });
    }
    // Fills primero (debajo de las líneas)
    prims.sort((a, b) => (a.t === "fill" ? 0 : 1) - (b.t === "fill" ? 0 : 1));
    const b = p.bounds;
    const scale = scaleOverride ?? this.scaleFor(b);
    const th = (2.5 * scale) / 1000; // texto de 2,5 mm en papel
    const dims: Dim[] = [
      { x1: b.minX, y1: b.minY, x2: b.maxX, y2: b.minY },
      { x1: b.minX, y1: b.maxY, x2: b.minX, y2: b.minY },
      ...this.dims,
    ];
    dims.forEach((d, i) => prims.push(...dimPrims(d, i < 2 ? -th * 4 : th * 2.2, th)));
    layers.set("COTAS", 5);
    const all = { minX: b.minX - th * 8, minY: b.minY - th * 8, maxX: b.maxX + th * 2, maxY: b.maxY + th * 2 };
    return { prims, styles: this.styles(), layers: [...layers].map(([name, aci]) => ({ name, aci })), bounds: all };
  }

  private scaleFor(b: PlanData["bounds"]) {
    const need = Math.max(((b.maxX - b.minX) * 1.15 * 1000) / AREA[2], ((b.maxY - b.minY) * 1.15 * 1000) / AREA[3]);
    return SCALES.find((s) => s >= need) ?? Math.ceil(need / 1000) * 1000;
  }

  private draw() {
    if (!this.plan || !this.svg) return;
    const d = this.drawing();
    const st = d.styles;
    const v = this.view;
    this.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
    const scale = this.scaleFor(this.plan.bounds);
    const px = (mm: number) => (mm * scale) / 1000; // grosor de papel → metros
    const byStyle = new Map<string, string[]>();
    let fills = "";
    let texts = "";
    for (const p of d.prims) {
      if (p.t === "line") {
        const a = byStyle.get(p.style) ?? [];
        a.push(`M${p.x1.toFixed(4)} ${(-p.y1).toFixed(4)}L${p.x2.toFixed(4)} ${(-p.y2).toFixed(4)}`);
        byStyle.set(p.style, a);
      } else if (p.t === "fill") {
        fills += `<path d="${p.loops.map((l) => "M" + l.map((n, i) => (i % 2 ? -n : n).toFixed(4)).join(" ").replace(/(\S+ \S+) /g, "$1L") + "Z").join("")}" fill="rgb(${p.color.join(",")})" fill-rule="evenodd"/>`;
      } else if (p.t === "text") {
        texts += `<text x="${p.x}" y="${-p.y}" font-size="${p.h}" text-anchor="${p.align === "center" ? "middle" : p.align === "right" ? "end" : "start"}" fill="${p.color ? `rgb(${p.color.join(",")})` : "#1a2a4a"}">${esc(p.s)}</text>`;
      }
    }
    const paths = [...byStyle]
      .map(([k, ds]) => `<path d="${ds.join("")}" fill="none" stroke="rgb(${st[k].color.join(",")})" stroke-width="${px(st[k].width).toFixed(4)}" ${st[k].dash ? `stroke-dasharray="${st[k].dash!.map((x) => px(x).toFixed(4)).join(" ")}"` : ""} stroke-linecap="round"/>`)
      .join("");
    const pend = this.pending ? `<circle cx="${this.pending.x}" cy="${-this.pending.y}" r="${px(1.2)}" fill="#e0402a"/>` : "";
    this.svg.innerHTML = `<rect x="${v.x - v.w}" y="${v.y - v.h}" width="${v.w * 3}" height="${v.h * 3}" fill="#fff"/>${fills}${paths}${texts}${pend}<g class="snap"></g>`;
    this.renderToolbar();
  }

  // --------- Interacción: zoom con rueda, desplazar arrastrando, cotas con imán ---------
  private setupPanZoom() {
    const svg = this.svg;
    const toModel = (e: { clientX: number; clientY: number }) => {
      const r = svg.getBoundingClientRect();
      const s = Math.max(this.view.w / r.width, this.view.h / r.height);
      const ox = this.view.x + (this.view.w - r.width * s) / 2, oy = this.view.y + (this.view.h - r.height * s) / 2;
      return { x: ox + (e.clientX - r.left) * s, y: -(oy + (e.clientY - r.top) * s), s };
    };
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = toModel(e);
      const k = Math.exp(e.deltaY * 0.0015);
      const v = this.view;
      v.x = p.x - (p.x - v.x) * k;
      v.y = -p.y - (-p.y - v.y) * k;
      v.w *= k;
      v.h *= k;
      this.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
    }, { passive: false });
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    svg.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
      svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener("pointermove", (e) => {
      if (drag) {
        const s = toModel(e).s;
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
        if (drag.moved) {
          this.view.x = drag.vx - (e.clientX - drag.x) * s;
          this.view.y = drag.vy - (e.clientY - drag.y) * s;
          this.svg.setAttribute("viewBox", `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`);
        }
      } else if (this.dimTool) {
        const p = this.snap(toModel(e));
        const g = this.svg.querySelector(".snap");
        if (g) g.innerHTML = `<rect x="${p.x - p.r}" y="${-p.y - p.r}" width="${p.r * 2}" height="${p.r * 2}" fill="none" stroke="#e0402a" stroke-width="${p.r / 4}"/>`;
      }
    });
    svg.addEventListener("pointerup", (e) => {
      const d = drag;
      drag = null;
      if (!d || d.moved || !this.dimTool) return;
      const p = this.snap(toModel(e));
      this.addDimPoint(p.x, p.y);
    });
  }

  /** Imán al vértice más cercano (10 px). */
  private snap(p: { x: number; y: number; s: number }) {
    const r = 10 * p.s;
    let best = { x: p.x, y: p.y, d: r };
    for (const e of this.plan?.elements ?? [])
      for (const [x1, y1, x2, y2] of e.segs)
        for (const [x, y] of [[x1, y1], [x2, y2]]) {
          const d = Math.hypot(x - p.x, y - p.y);
          if (d < best.d) best = { x, y, d };
        }
    return { x: best.x, y: best.y, r: 4 * p.s };
  }

  /** Añade un punto de cota (coordenadas de planta, m). Público para pruebas. */
  addDimPoint(x: number, y: number) {
    if (!this.pending) {
      this.pending = { x, y };
    } else {
      if (Math.hypot(x - this.pending.x, y - this.pending.y) > 1e-6) this.dims.push({ x1: this.pending.x, y1: this.pending.y, x2: x, y2: y });
      this.pending = null;
    }
    this.draw();
  }

  get dimensions() {
    return this.dims.map((d) => Math.hypot(d.x2 - d.x1, d.y2 - d.y1));
  }

  private sheetName() {
    return `${this.modelName().replace(/\.ifc$/i, "")} - Planta ${this.storey?.name ?? ""}`;
  }

  /** PDF A3 a escala con marco y cajetín. Público para pruebas. */
  exportPdf() {
    const scale = this.scaleFor(this.plan!.bounds);
    const d = this.drawing(scale);
    const [W, H] = PAPER;
    const extra: Prim[] = [];
    const rect = (x: number, y: number, w: number, h: number, style = "frame") => {
      extra.push({ t: "line", layer: "", style, x1: x, y1: y, x2: x + w, y2: y }, { t: "line", layer: "", style, x1: x + w, y1: y, x2: x + w, y2: y + h }, { t: "line", layer: "", style, x1: x + w, y1: y + h, x2: x, y2: y + h }, { t: "line", layer: "", style, x1: x, y1: y + h, x2: x, y2: y });
    };
    rect(10, 10, W - 20, H - 20);
    rect(10, 10, W - 20, 18, "thin");
    const today = new Date().toLocaleDateString("es-ES");
    extra.push(
      { t: "text", layer: "", x: 14, y: 21, h: 4.2, s: `Planta ${this.storey!.name}`, bold: true },
      { t: "text", layer: "", x: 14, y: 14.5, h: 2.6, s: `${this.modelName()} · nivel ${this.storey!.elevation.toFixed(2)} m · corte a ${this.cut.toFixed(2)} m sobre el nivel` },
      { t: "text", layer: "", x: W - 14, y: 21, h: 4.2, s: `E 1:${scale}`, bold: true, align: "right" },
      { t: "text", layer: "", x: W - 14, y: 14.5, h: 2.6, s: `A3 · ${today} · Visor IFC`, align: "right" },
    );
    const pdf = drawingToPdf(d, { paper: PAPER, area: AREA, scale, extra });
    download(pdf, `${this.sheetName()}.pdf`, "application/pdf");
    return { bytes: pdf.length, scale };
  }

  /** DXF R12 en metros. Público para pruebas. */
  exportDxf() {
    const d = this.drawing();
    const txt = drawingToDxf(d);
    download(txt, `${this.sheetName()}.dxf`, "application/dxf");
    return { bytes: txt.length, layers: d.layers.length };
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const sid = t.closest<HTMLElement>("[data-storey]")?.dataset.storey;
    try {
      if (sid) {
        this.storey = this.storeys.find((s) => s.localId === Number(sid)) ?? this.storey;
        this.dims = [];
        this.root.querySelectorAll<HTMLElement>("[data-storey]").forEach((b) => b.classList.toggle("active", b.dataset.storey === sid));
        await this.generate();
        return;
      }
      const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "close") this.close();
      else if (act === "dim") {
        this.dimTool = !this.dimTool;
        this.pending = null;
        this.draw();
      } else if (act === "clear-dims") {
        this.dims = [];
        this.draw();
      } else if (act === "pdf" && this.plan) this.exportPdf();
      else if (act === "dxf" && this.plan) this.exportDxf();
    } catch (err) {
      console.error(err);
      this.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  private onChange(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.dataset.role === "cut") {
      this.cut = Math.max(0.1, Number(t.value) || 1.2);
      void this.generate();
    } else if (t.dataset.show) {
      this.show[t.dataset.show as keyof typeof this.show] = t.checked;
      this.draw();
    }
  }
}

/** Cota alineada: líneas de referencia, línea de cota con marcas a 45° y texto en metros. */
function dimPrims(d: Dim, offset: number, th: number): Prim[] {
  const dx = d.x2 - d.x1, dy = d.y2 - d.y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [];
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux; // normal (izquierda)
  const ox = nx * offset, oy = ny * offset;
  const a = { x: d.x1 + ox, y: d.y1 + oy }, b = { x: d.x2 + ox, y: d.y2 + oy };
  const ext = Math.sign(offset || 1) * th * 0.6;
  const tick = th * 0.5;
  const L = (x1: number, y1: number, x2: number, y2: number): Prim => ({ t: "line", layer: "COTAS", style: "dim", x1, y1, x2, y2 });
  const tx = (ux - uy) * tick * 0.7, ty = (uy + ux) * tick * 0.7;
  const prims: Prim[] = [
    L(d.x1 + nx * th * 0.3 * Math.sign(offset || 1), d.y1 + ny * th * 0.3 * Math.sign(offset || 1), a.x + nx * ext, a.y + ny * ext),
    L(d.x2 + nx * th * 0.3 * Math.sign(offset || 1), d.y2 + ny * th * 0.3 * Math.sign(offset || 1), b.x + nx * ext, b.y + ny * ext),
    L(a.x - ux * tick, a.y - uy * tick, b.x + ux * tick, b.y + uy * tick),
    L(a.x - tx, a.y - ty, a.x + tx, a.y + ty),
    L(b.x - tx, b.y - ty, b.x + tx, b.y + ty),
  ];
  // Texto horizontal centrado sobre la cota (legible en pantalla, PDF y DXF)
  const mx = (a.x + b.x) / 2 + nx * th * 0.5 * Math.sign(offset || 1), my = (a.y + b.y) / 2 + ny * th * 0.5 * Math.sign(offset || 1);
  prims.push({ t: "text", layer: "COTAS", x: mx, y: my - (Math.abs(ny) < 0.5 ? th / 2 : 0), h: th, s: len.toFixed(2), align: "center", color: [20, 70, 160] });
  return prims;
}
