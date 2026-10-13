import { detectClashes, type Clash, type ClashStatus } from "../../analysis/clash";
import type { Sheet } from "../../analysis/xlsx";
import { esc, fmtM, type AnalysisContext, type AnalysisTab } from "./types";

const STATUSES: ClashStatus[] = ["Nuevo", "Activo", "Resuelto", "Aprobado"];
/** Clases que por defecto no entran (armado dentro del hormigón, huecos, espacios…). */
const DEFAULT_OFF = /^(IfcReinforcingBar|IfcReinforcingMesh|IfcTendon|IfcOpeningElement|IfcSpace|IfcAnnotation|IfcGrid|IfcVirtualElement|IfcSite|IfcBuildingStorey)$/;

export class ClashTab implements AnalysisTab {
  readonly id = "clashes";
  readonly title = "Interferencias";
  readonly el = document.createElement("div");
  private clashes: Clash[] = [];
  private focused: number | null = null;
  private setA = new Set<string>();
  private setB = new Set<string>();
  private classes: [string, number][] = [];
  private tolerance = 10; // mm
  private running: AbortController | null = null;
  private filter = "";
  private statusFilter: ClashStatus | "" = "";
  private active = false;

  constructor(private ctx: AnalysisContext) {
    this.el.className = "an-tab clash-tab";
    this.el.addEventListener("click", (e) => void this.onClick(e));
    this.el.addEventListener("change", (e) => this.onChange(e));
    this.el.addEventListener("keydown", (e) => this.onKey(e));
  }

  reset() {
    this.running?.abort();
    this.clashes = [];
    this.focused = null;
    this.classes = [];
    this.setA.clear();
    this.setB.clear();
    this.el.innerHTML = "";
  }

  async activate() {
    this.active = true;
    if (!this.classes.length && this.ctx.viewer.hasModel) {
      this.el.innerHTML = `<p class="muted">Leyendo el modelo…</p>`;
      const idx = await this.ctx.index();
      this.classes = idx.classes();
      for (const [c] of this.classes) if (!DEFAULT_OFF.test(c)) (this.setA.add(c), this.setB.add(c));
    }
    this.render();
    await this.paint();
  }

  async deactivate() {
    this.active = false;
    await this.ctx.viewer.clearPaint();
    await this.ctx.viewer.focusElements(null);
  }

  private render() {
    if (!this.ctx.viewer.hasModel) {
      this.el.innerHTML = `<p class="muted">Abre un modelo para buscar interferencias.</p>`;
      return;
    }
    const list = (set: Set<string>, side: "A" | "B") =>
      this.classes
        .map(([c, n]) => `<label class="chk"><input type="checkbox" data-set="${side}" value="${esc(c)}" ${set.has(c) ? "checked" : ""}/> ${esc(c)} <span class="muted">${n}</span></label>`)
        .join("");
    const visible = this.visibleClashes();
    const counts = { Cruce: 0, Contenido: 0 } as Record<string, number>;
    for (const c of this.clashes) counts[c.kind]++;
    const pairs = new Map<string, number>();
    const idx = this.idxSync;
    for (const c of this.clashes) {
      const k = idx ? `${idx.elements.get(c.a)?.ifcClass} × ${idx.elements.get(c.b)?.ifcClass}` : "";
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
    const rows = visible
      .map((c) => {
        const ea = idx?.elements.get(c.a), eb = idx?.elements.get(c.b);
        return `<tr data-clash="${c.id}" class="${this.focused === c.id ? "focus" : ""}" tabindex="-1">
          <td>${c.id}</td>
          <td title="${esc(idx?.label(c.a) ?? "")}"><span class="dot a"></span>${esc(idx?.label(c.a) ?? String(c.a))}</td>
          <td title="${esc(idx?.label(c.b) ?? "")}"><span class="dot b"></span>${esc(idx?.label(c.b) ?? String(c.b))}</td>
          <td>${c.kind}</td><td class="num">${fmtM(c.depth)}</td><td>${esc(ea?.storey ?? eb?.storey ?? "—")}</td>
          <td><button class="status st-${c.status}" data-status="${c.id}" title="Cambiar estado">${c.status}</button></td></tr>`;
      })
      .join("");
    this.el.innerHTML = `
      <div class="an-cols">
        <div class="an-setup">
          <div class="sets">
            <fieldset><legend>Conjunto A <button class="link" data-all="A">todo</button> <button class="link" data-none="A">nada</button></legend><div class="chk-list">${list(this.setA, "A")}</div></fieldset>
            <fieldset><legend>Conjunto B <button class="link" data-all="B">todo</button> <button class="link" data-none="B">nada</button></legend><div class="chk-list">${list(this.setB, "B")}</div></fieldset>
          </div>
          <div class="row">
            <label>Tolerancia <input type="number" min="0" max="500" step="1" value="${this.tolerance}" data-role="tol" style="width:64px"/> mm</label>
            ${this.running ? `<button data-act="cancel">Cancelar</button>` : `<button class="primary" data-act="run">Buscar interferencias</button>`}
          </div>
          <div class="an-progress" ${this.running ? "" : "hidden"}><div class="bar"><div></div></div><span></span></div>
          <p class="muted small">Choque duro: las geometrías se cortan o una está dentro de otra, con solape mayor que la tolerancia
          (descarta caras que solo se tocan). Profundidad = solape aproximado de las cajas envolventes.</p>
        </div>
        <div class="an-results">
          ${this.clashes.length || this.ranOnce
            ? `<div class="an-summary"><b data-testid="clash-count">${this.clashes.length}</b> interferencias · ${counts.Cruce} cruce · ${counts.Contenido} contenido
                <span class="filters">
                  <input type="search" placeholder="Filtrar (clase, nombre, nivel)…" data-role="filter" value="${esc(this.filter)}"/>
                  <span class="seg small">${["", ...STATUSES].map((s) => `<button data-stfilter="${s}" class="${this.statusFilter === s ? "active" : ""}">${s || "Todos"}</button>`).join("")}</span>
                </span></div>
               <div class="pairs">${[...pairs].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `<span class="chip">${esc(k)} <b>${n}</b></span>`).join("")}</div>
               <div class="an-table-wrap"><table class="an-table" data-testid="clash-table"><thead><tr><th>#</th><th>Elemento A</th><th>Elemento B</th><th>Tipo</th><th>Profundidad</th><th>Nivel</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table></div>
               <p class="muted small">Clic en una fila para verla (A en rojo, B en azul, el resto transparente). ↑ ↓ para recorrerlas. Esc para ver todas.</p>`
            : `<p class="muted">Elige qué clases comparar y pulsa <b>Buscar interferencias</b>.</p>`}
        </div>
      </div>`;
  }

  private ranOnce = false;
  private idxSync: Awaited<ReturnType<AnalysisContext["index"]>> | null = null;

  private visibleClashes() {
    const f = this.filter.trim().toLowerCase();
    const idx = this.idxSync;
    return this.clashes.filter((c) => {
      if (this.statusFilter && c.status !== this.statusFilter) return false;
      if (!f) return true;
      const text = `${idx?.label(c.a)} ${idx?.label(c.b)} ${idx?.elements.get(c.a)?.storey} ${c.kind}`.toLowerCase();
      return text.includes(f);
    });
  }

  private async run() {
    const v = this.ctx.viewer;
    const model = v.model;
    if (!model) return;
    if (!this.setA.size || !this.setB.size) return this.ctx.notify("Elige al menos una clase en cada conjunto.", "info");
    this.running = new AbortController();
    this.focused = null;
    this.render();
    const bar = this.el.querySelector<HTMLElement>(".an-progress .bar > div")!;
    const label = this.el.querySelector<HTMLElement>(".an-progress span")!;
    const t0 = performance.now();
    try {
      const idx = await this.ctx.index();
      this.idxSync = idx;
      this.clashes = await detectClashes(model, idx, {
        setA: this.setA,
        setB: this.setB,
        tolerance: this.tolerance / 1000,
        signal: this.running.signal,
        onProgress: (d, t, stage) => {
          bar.style.width = `${t ? Math.round((d / t) * 100) : 0}%`;
          label.textContent = `${stage}${t > 1 ? ` ${d}/${t}` : ""}`;
        },
      });
      this.ranOnce = true;
      this.ctx.notify(`${this.clashes.length} interferencias en ${((performance.now() - t0) / 1000).toFixed(1)} s.`, "info");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.error(err);
        this.ctx.notify(`No se pudieron calcular las interferencias: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    } finally {
      this.running = null;
      this.render();
      await this.paint();
    }
  }

  /** Colores: con una interferencia enfocada, A rojo / B azul / resto transparente; si no, todos los implicados en rojo. */
  private async paint() {
    if (!this.active) return;
    const v = this.ctx.viewer;
    const idx = this.idxSync;
    if (!this.clashes.length || !idx) return void (await Promise.all([v.clearPaint(), v.focusElements(null)]));
    const c = this.clashes.find((x) => x.id === this.focused);
    if (c) {
      await v.focusElements([c.a, c.b]);
      await v.paint([
        { name: "clash-a", color: "#ff3b30", ids: [c.a] },
        { name: "clash-b", color: "#2f7bff", ids: [c.b] },
      ]);
    } else {
      await v.focusElements(null);
      const ids = new Set<number>();
      for (const x of this.visibleClashes()) (ids.add(x.a), ids.add(x.b));
      await v.paint([{ name: "clash-all", color: "#ff5a3c", ids: [...ids] }]);
    }
  }

  private async focus(id: number | null) {
    this.focused = id;
    this.el.querySelectorAll("tr[data-clash]").forEach((tr) => tr.classList.toggle("focus", Number((tr as HTMLElement).dataset.clash) === id));
    const row = this.el.querySelector<HTMLElement>(`tr[data-clash="${id}"]`);
    row?.scrollIntoView({ block: "nearest" });
    row?.focus({ preventScroll: true });
    await this.paint();
    const c = this.clashes.find((x) => x.id === id);
    // Encuadrar la zona de solape (no los elementos enteros: una losa grande alejaría la vista).
    if (c) await this.ctx.viewer.fitBox(c.zone.slice(0, 3), c.zone.slice(3), 2);
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "run") return void this.run();
    if (act === "cancel") return void this.running?.abort();
    const all = t.closest<HTMLElement>("[data-all]")?.dataset.all;
    const none = t.closest<HTMLElement>("[data-none]")?.dataset.none;
    if (all || none) {
      const set = (all ?? none) === "A" ? this.setA : this.setB;
      set.clear();
      if (all) for (const [c] of this.classes) set.add(c);
      return this.render();
    }
    const st = t.closest<HTMLElement>("[data-status]");
    if (st) {
      const c = this.clashes.find((x) => x.id === Number(st.dataset.status));
      if (c) {
        c.status = STATUSES[(STATUSES.indexOf(c.status) + 1) % STATUSES.length];
        st.textContent = c.status;
        st.className = `status st-${c.status}`;
      }
      return;
    }
    const sf = t.closest<HTMLElement>("[data-stfilter]");
    if (sf) {
      this.statusFilter = (sf.dataset.stfilter ?? "") as ClashStatus | "";
      this.render();
      return void this.paint();
    }
    const row = t.closest<HTMLElement>("tr[data-clash]");
    if (row) await this.focus(Number(row.dataset.clash));
  }

  private onChange(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.dataset.set) {
      const set = t.dataset.set === "A" ? this.setA : this.setB;
      if (t.checked) set.add(t.value);
      else set.delete(t.value);
    } else if (t.dataset.role === "tol") {
      this.tolerance = Math.max(0, Number(t.value) || 0);
    }
  }

  private filterTimer = 0;
  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLInputElement;
    if (t.dataset?.role === "filter") {
      window.clearTimeout(this.filterTimer);
      this.filterTimer = window.setTimeout(() => {
        this.filter = t.value;
        const pos = t.selectionStart;
        this.render();
        const inp = this.el.querySelector<HTMLInputElement>('[data-role="filter"]');
        inp?.focus();
        if (pos !== null) inp?.setSelectionRange(pos, pos);
        void this.paint();
      }, 200);
      return;
    }
    if (!this.clashes.length) return;
    const vis = this.visibleClashes();
    const i = vis.findIndex((c) => c.id === this.focused);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation(); // que no muevan la cámara
      const next = vis[Math.max(0, Math.min(vis.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) void this.focus(next.id);
    } else if (e.key === "Escape" && this.focused !== null) {
      e.stopPropagation();
      void this.focus(null);
    }
  }

  report(): Sheet[] | null {
    const idx = this.idxSync;
    if (!this.clashes.length || !idx) return null;
    const rows = this.clashes.map((c) => {
      const a = idx.elements.get(c.a), b = idx.elements.get(c.b);
      return [c.id, a?.ifcClass, a?.name, a?.guid, b?.ifcClass, b?.name, b?.guid, c.kind, Math.round(c.depth * 1000), a?.storey ?? b?.storey ?? "", c.status, +c.center[0].toFixed(3), +(-c.center[2]).toFixed(3), +c.center[1].toFixed(3)];
    });
    return [{
      name: "Interferencias",
      rows: [["#", "Clase A", "Nombre A", "GlobalId A", "Clase B", "Nombre B", "GlobalId B", "Tipo", "Profundidad (mm)", "Nivel", "Estado", "X visor (m)", "Y visor (m)", "Z visor (m)"], ...rows],
      widths: [6, 16, 40, 24, 16, 40, 24, 11, 16, 22, 11, 10, 10, 10],
    }];
  }
}
