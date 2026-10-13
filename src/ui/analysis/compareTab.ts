import type * as FRAGS from "@thatopen/fragments";
import { elementTriangles } from "../../analysis/modelIndex";
import { compareSignatures, readSignatures, type CompareResult, type ElementSig } from "../../analysis/compare";
import type { Sheet } from "../../analysis/xlsx";
import { esc, type AnalysisContext, type AnalysisTab } from "./types";

type Filter = "all" | "added" | "removed" | "modified";
type Row = { kind: "added" | "removed" | "modified"; sig: ElementSig; inAux: boolean; changes: string[]; geometry: boolean };

const COLOR = { added: "#34c27a", removed: "#ff3b30", modified: "#ffa630" } as const;
const LABEL = { added: "Nuevo", removed: "Eliminado", modified: "Modificado" } as const;

/**
 * Comparar el modelo abierto con otra versión del mismo proyecto (otro IFC). La otra versión se
 * procesa en local como modelo auxiliar; solo se muestran de ella los elementos que no existen en
 * el abierto.
 */
export class CompareTab implements AnalysisTab {
  readonly id = "compare";
  readonly title = "Comparar";
  readonly el = document.createElement("div");
  private aux: FRAGS.FragmentsModel | null = null;
  private auxName = "";
  private result: CompareResult | null = null;
  /** true: el archivo cargado es la versión NUEVA (el abierto es la anterior). */
  private otherIsNewer = true;
  private filter: Filter = "all";
  private ghost = true;
  private focus: string | null = null;
  private busy = "";
  private active = false;

  constructor(private ctx: AnalysisContext) {
    this.el.className = "an-tab compare-tab";
    this.el.addEventListener("click", (e) => void this.onClick(e));
    this.el.addEventListener("change", (e) => void this.onChange(e));
  }

  reset() {
    const aux = this.aux;
    this.aux = null;
    this.result = null;
    this.focus = null;
    if (aux) void this.ctx.viewer.disposeAux(aux).catch(() => {});
    this.render();
  }

  async activate() {
    this.active = true;
    this.render();
    await this.paint();
  }

  async deactivate() {
    this.active = false;
    const v = this.ctx.viewer;
    await v.clearPaint();
    await v.focusElements(null);
    if (this.aux) await v.showOnlyAux(this.aux, []);
  }

  /** Carga la otra versión y compara. Público para pruebas. */
  async loadOther(file: File) {
    const v = this.ctx.viewer;
    const model = v.model;
    if (!model) throw new Error("Abre primero un modelo.");
    if (this.aux) {
      await v.disposeAux(this.aux);
      this.aux = null;
    }
    this.result = null;
    this.focus = null;
    this.setBusy("Procesando la otra versión…");
    try {
      this.aux = await v.loadAuxIfc(file, ({ value, stage }) => this.setBusy(`${stage}… ${Math.round(value * 100)} %`));
      this.auxName = file.name;
      this.setBusy("Leyendo propiedades del modelo abierto…");
      const mine = await readSignatures(model, (d, t) => this.setBusy(`Leyendo el modelo abierto… ${d}/${t}`));
      const other = await readSignatures(this.aux, (d, t) => this.setBusy(`Leyendo la otra versión… ${d}/${t}`));
      this.sigs = { mine, other };
      this.compute();
      await this.alignAux();
    } finally {
      this.busy = "";
      this.render();
    }
    await this.paint();
    const r = this.result!;
    return { added: r.added.length, removed: r.removed.length, modified: r.modified.length, unchanged: r.unchanged };
  }

  private sigs: { mine: Map<string, ElementSig>; other: Map<string, ElementSig> } | null = null;

  private compute() {
    if (!this.sigs) return;
    const { mine, other } = this.sigs;
    this.result = this.otherIsNewer ? compareSignatures(mine, other) : compareSignatures(other, mine);
  }

  /**
   * Coloca la otra versión sobre la abierta. Fragments la coordina al cargar con la matriz de
   * coordinación de su archivo, que puede cambiar entre exportaciones (visto con un IFC re-guardado:
   * aparecía desplazada decenas de metros). Se mide el desplazamiento común en coordenadas de cada
   * modelo (cajas de una muestra de elementos comunes) y se coloca el objeto en consecuencia.
   */
  private async alignAux() {
    const main = this.ctx.viewer.model, aux = this.aux;
    if (!main || !aux || !this.sigs) return;
    const guids = [...this.sigs.mine.keys()].filter((g) => this.sigs!.other.has(g)).slice(0, 300);
    if (!guids.length) return;
    const [ia, ib] = await Promise.all([main.getLocalIdsByGuids(guids), aux.getLocalIdsByGuids(guids)]);
    const pairs = guids.map((_, k) => [ia[k], ib[k]]).filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
    // Geometría en coordenadas de datos de cada modelo (sin la transformación del objeto 3D).
    // Nota: getBoxes no sirve aquí: según el momento devolvía cajas con o sin la coordinación aplicada.
    const sample = pairs.slice(0, 25);
    const [ta, tb] = await Promise.all([elementTriangles(main, sample.map((p) => p[0])), elementTriangles(aux, sample.map((p) => p[1]))]);
    const centroid = (t: Float32Array | undefined) => {
      if (!t || !t.length) return null;
      const c = [0, 0, 0];
      for (let i = 0; i < t.length; i += 3) (c[0] += t[i]), (c[1] += t[i + 1]), (c[2] += t[i + 2]);
      const n = t.length / 3;
      return c.map((x) => x / n);
    };
    const votes = new Map<string, { n: number; d: number[] }>();
    for (const [a, b] of sample) {
      const ca = centroid(ta.get(a)), cb = centroid(tb.get(b));
      if (!ca || !cb) continue;
      const d = [cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]];
      const key = d.map((x) => Math.round(x * 1000)).join(",");
      const v = votes.get(key) ?? { n: 0, d };
      v.n++;
      votes.set(key, v);
    }
    let best = { n: 0, d: [0, 0, 0] };
    for (const v of votes.values()) if (v.n > best.n) best = v;
    // mundo_aux = local_aux · M_aux ; se quiere que coincida con local_abierto · M_abierto, local_aux ≈ local_abierto + d
    const m = main.object;
    m.updateMatrixWorld(true);
    aux.object.matrixAutoUpdate = true;
    aux.object.position.copy(m.position);
    aux.object.quaternion.copy(m.quaternion);
    aux.object.scale.copy(m.scale);
    aux.object.updateMatrix();
    aux.object.translateX(-best.d[0]);
    aux.object.translateY(-best.d[1]);
    aux.object.translateZ(-best.d[2]);
    aux.object.updateMatrixWorld(true);
    await this.ctx.viewer.fragmentsManager.core.update(true);
  }

  /** Filas con el elemento a mostrar (del abierto si existe en él; si no, de la otra versión). */
  private rows(): Row[] {
    const r = this.result;
    if (!r) return [];
    const newerIsAux = this.otherIsNewer;
    const out: Row[] = [];
    for (const s of r.added) out.push({ kind: "added", sig: s, inAux: newerIsAux, changes: [], geometry: false });
    for (const s of r.removed) out.push({ kind: "removed", sig: s, inAux: !newerIsAux, changes: [], geometry: false });
    for (const m of r.modified) {
      const sig = newerIsAux ? m.before : m.after; // la del modelo abierto
      out.push({ kind: "modified", sig, inAux: false, changes: m.changes.map((c) => `${c.what}: ${c.before} → ${c.after}`), geometry: m.geometry });
    }
    return out;
  }

  private setBusy(msg: string) {
    this.busy = msg;
    const el = this.el.querySelector(".busy-msg");
    if (el) el.textContent = msg;
    else this.render();
  }

  private render() {
    const v = this.ctx.viewer;
    if (!v.hasModel) {
      this.el.innerHTML = `<p class="muted">Abre un modelo para compararlo con otra versión.</p>`;
      return;
    }
    const r = this.result;
    const rows = this.rows().filter((x) => this.filter === "all" || x.kind === this.filter);
    const counts = r ? { added: r.added.length, removed: r.removed.length, modified: r.modified.length } : null;
    const chip = (f: Filter, label: string, n: number, color?: string) =>
      `<button class="chip ${this.filter === f ? "active" : ""}" data-filter="${f}">${color ? `<span class="dot" style="background:${color}"></span>` : ""}${label} <b data-testid="cmp-${f}">${n}</b></button>`;
    this.el.innerHTML = `
      <div class="row">
        <button class="primary" data-act="open" ${this.busy ? "disabled" : ""}>Abrir otra versión (IFC)…</button>
        <input type="file" accept=".ifc" data-role="file" hidden />
        ${this.aux ? `<span class="muted">Comparando con <b>${esc(this.auxName)}</b></span>` : `<span class="muted">El IFC se procesa en este equipo, igual que el modelo abierto.</span>`}
        ${this.aux ? `<span class="seg small"><button data-dir="newer" class="${this.otherIsNewer ? "active" : ""}">Ese archivo es la versión nueva</button><button data-dir="older" class="${this.otherIsNewer ? "" : "active"}">Es la anterior</button></span>
        <label class="chk"><input type="checkbox" data-role="ghost" ${this.ghost ? "checked" : ""}/> Sin cambios en transparente</label>
        <button data-act="close-cmp">Quitar comparación</button>` : ""}
      </div>
      ${this.busy ? `<p class="busy-msg muted">${esc(this.busy)}</p>` : ""}
      ${r && counts
        ? `<div class="an-summary">${chip("all", "Todos", counts.added + counts.removed + counts.modified)}${chip("added", "Nuevos", counts.added, COLOR.added)}${chip("removed", "Eliminados", counts.removed, COLOR.removed)}${chip("modified", "Modificados", counts.modified, COLOR.modified)}<span class="muted">· ${r.unchanged} sin cambios</span></div>
          <div class="an-table-wrap"><table class="an-table" data-testid="cmp-table"><thead><tr><th>Estado</th><th>Elemento</th><th>GlobalId</th><th>Cambios</th></tr></thead><tbody>${rows
            .slice(0, 800)
            .map(
              (x) => `<tr data-guid="${esc(x.sig.guid)}" class="${this.focus === x.sig.guid ? "focus" : ""}"><td><span class="dot" style="background:${COLOR[x.kind]}"></span>${LABEL[x.kind]}${x.geometry ? " (geometría)" : ""}</td><td>${esc(`${x.sig.ifcClass}${x.sig.name ? ` · ${x.sig.name}` : ""}`)}</td><td class="mono">${esc(x.sig.guid)}</td><td class="changes">${esc(x.changes.slice(0, this.focus === x.sig.guid ? 50 : 2).join(" · "))}${x.changes.length > 2 && this.focus !== x.sig.guid ? ` <span class="muted">(+${x.changes.length - 2})</span>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>
          ${rows.length > 800 ? `<p class="muted small">Se muestran 800 de ${rows.length}; el informe Excel los incluye todos.</p>` : ""}`
        : !this.busy
          ? `<p class="muted">Abre otra versión del mismo proyecto (exportada de Revit en otra fecha). Se comparan los elementos por <b>GlobalId</b>: nuevos (verde), eliminados (rojo) y modificados (naranja: geometría, atributos o propiedades).</p>`
          : ""}`;
  }

  private async paint() {
    if (!this.active) return;
    const v = this.ctx.viewer;
    if (!this.result || !this.aux) {
      await v.clearPaint();
      return void (await v.focusElements(null));
    }
    const rows = this.rows();
    const show = (k: Row["kind"]) => this.filter === "all" || this.filter === k;
    const mineIds = (k: Row["kind"]) => (show(k) ? rows.filter((x) => x.kind === k && !x.inAux).map((x) => x.sig.localId) : []);
    const auxRows = rows.filter((x) => x.inAux && show(x.kind));
    // Con «sin cambios en transparente»: solo se ven los cambios (filtrados) y el resto como fantasma.
    const shownMine = rows.filter((x) => !x.inAux && show(x.kind)).map((x) => x.sig.localId);
    await v.focusElements(this.ghost ? shownMine : null);
    await v.paint([
      { name: "cmp-added", color: COLOR.added, ids: mineIds("added") },
      { name: "cmp-removed", color: COLOR.removed, ids: mineIds("removed") },
      { name: "cmp-modified", color: COLOR.modified, ids: mineIds("modified") },
    ]);
    const auxIds = auxRows.map((x) => x.sig.localId);
    await v.showOnlyAux(this.aux, auxIds);
    if (auxIds.length) {
      // Un estilo por color (no se recrean estilos: ver Viewer.paint)
      const kind = this.otherIsNewer ? "added" : "removed";
      await v.paintAux(this.aux, `cmp-aux-${kind}`, COLOR[kind], auxIds);
    }
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    try {
      if (act === "open") return this.el.querySelector<HTMLInputElement>('[data-role="file"]')!.click();
      if (act === "close-cmp") {
        await this.ctx.viewer.clearPaint();
        await this.ctx.viewer.focusElements(null);
        this.reset();
        return;
      }
      const dir = t.closest<HTMLElement>("[data-dir]")?.dataset.dir;
      if (dir) {
        this.otherIsNewer = dir === "newer";
        this.compute();
        this.render();
        return void (await this.paint());
      }
      const f = t.closest<HTMLElement>("[data-filter]")?.dataset.filter as Filter | undefined;
      if (f) {
        this.filter = f;
        this.render();
        return void (await this.paint());
      }
      const row = t.closest<HTMLElement>("tr[data-guid]");
      if (row) {
        const guid = row.dataset.guid!;
        this.focus = this.focus === guid ? null : guid;
        this.render();
        const x = this.rows().find((r) => r.sig.guid === guid);
        if (x?.sig.box.length) await this.ctx.viewer.fitBox(x.sig.box.slice(0, 3), x.sig.box.slice(3));
      }
    } catch (err) {
      console.error(err);
      this.ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  private async onChange(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.dataset.role === "ghost") {
      this.ghost = t.checked;
      return void (await this.paint());
    }
    if (t.dataset.role !== "file") return;
    const f = t.files?.[0];
    t.value = "";
    if (!f) return;
    try {
      const r = await this.loadOther(f);
      this.ctx.notify(`Comparación: ${r.added} nuevos, ${r.removed} eliminados, ${r.modified} modificados.`, "info");
    } catch (err) {
      console.error(err);
      this.busy = "";
      this.render();
      this.ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  report(): Sheet[] | null {
    if (!this.result) return null;
    const rows = this.rows();
    const sheet: (string | number)[][] = [["Estado", "Clase", "Nombre", "GlobalId", "Geometría cambiada", "Cambio", "Antes", "Después"]];
    for (const x of rows) {
      if (x.kind !== "modified") sheet.push([LABEL[x.kind], x.sig.ifcClass, x.sig.name, x.sig.guid, "", "", "", ""]);
    }
    for (const m of this.result.modified)
      for (const c of m.changes) sheet.push(["Modificado", m.after.ifcClass, m.after.name, m.after.guid, m.geometry ? "Sí" : "No", c.what, c.before, c.after]);
    return [{ name: "Comparación", rows: sheet, widths: [12, 16, 40, 24, 10, 34, 40, 40] }];
  }
}
