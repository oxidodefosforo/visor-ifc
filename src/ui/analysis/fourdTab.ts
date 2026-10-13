import type { ModelIndex } from "../../analysis/modelIndex";
import { download, type Sheet } from "../../analysis/xlsx";
import { esc, type AnalysisContext, type AnalysisTab } from "./types";

/**
 * 4D: programación de obra enlazada al modelo. Se genera automáticamente por niveles y fases
 * (cimentación, estructura, cerramientos, instalaciones…) o se importa de un CSV editable en Excel.
 * Con la barra de fecha (o «Reproducir») se ven ocultos los elementos aún no empezados, en color
 * los que están en ejecución y normales los terminados.
 */
type Activity = { id: number; name: string; start: number; end: number; ids: number[]; storey: string; classes: string; guids: string };

const DAY = 86_400_000;
const PHASES: { name: string; re: RegExp }[] = [
  { name: "Cimentación", re: /^Ifc(Footing|Pile|DeepFoundation)$/ },
  { name: "Armado y estructura vertical", re: /^Ifc(ReinforcingBar|ReinforcingMesh|Tendon|Column|Wall|WallStandardCase|ElementAssembly)$/ },
  { name: "Estructura horizontal", re: /^Ifc(Beam|Slab|Plate|Member|Stair|StairFlight|Ramp|RampFlight|Roof)$/ },
  { name: "Cerramientos y carpintería", re: /^Ifc(Window|Door|CurtainWall|Covering|Railing|BuildingElementProxy)$/ },
  { name: "Instalaciones", re: /^Ifc(Flow.*|Distribution.*|Pipe.*|Duct.*|Cable.*|Air.*|Valve|Pump|Fan|Sanitary.*|Light.*|Outlet|Switching.*|Electric.*|Unitary.*|Boiler|Chiller|Coil|Tank|SpaceHeater|Fire.*|Alarm|Sensor|Controller|Actuator)$/ },
];

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const dmy = (t: number) => new Date(t).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });

function parseDate(s: string): number | null {
  s = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  if (m) return Date.UTC(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2] - 1, +m[1]);
  return null;
}

function splitCsvLine(line: string, sep: string) {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"', i++);
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) (out.push(cur), (cur = ""));
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

export class FourDTab implements AnalysisTab {
  readonly id = "fourd";
  readonly title = "4D";
  readonly el = document.createElement("div");
  private acts: Activity[] = [];
  private date = 0;
  private playing = 0;
  private active = false;
  private startDate = iso(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
  private days = 7;
  private idx: ModelIndex | null = null;
  private source = "";

  constructor(private ctx: AnalysisContext) {
    this.el.className = "an-tab fourd-tab";
    this.el.addEventListener("click", (e) => void this.onClick(e));
    this.el.addEventListener("input", (e) => this.onInput(e));
    this.el.addEventListener("change", (e) => void this.onChange(e));
  }

  reset() {
    this.stop();
    this.acts = [];
    this.idx = null;
    this.render();
  }

  async activate() {
    this.active = true;
    this.render();
    await this.apply();
  }

  async deactivate() {
    this.active = false;
    this.stop();
    const v = this.ctx.viewer;
    await v.clearPaint();
    if (v.hasModel && this.acts.length) await v.showAll();
  }

  get range() {
    if (!this.acts.length) return [0, 0];
    return [Math.min(...this.acts.map((a) => a.start)), Math.max(...this.acts.map((a) => a.end))];
  }

  /** Programación automática por niveles y fases. Público para pruebas. */
  async generate(start = this.startDate, days = this.days) {
    const idx = (this.idx ??= await this.ctx.index());
    const t0 = parseDate(start) ?? Date.now();
    const storeys = idx.storeys.length ? idx.storeys.map((s) => s.name) : ["(sin nivel)"];
    const byStorey = new Map<string, number[]>();
    for (const e of idx.elements.values()) {
      const s = e.storey ?? storeys[0];
      if (!byStorey.has(s)) byStorey.set(s, []);
      byStorey.get(s)!.push(e.localId);
    }
    const acts: Activity[] = [];
    let t = t0;
    for (const s of [...storeys, ...[...byStorey.keys()].filter((k) => !storeys.includes(k))]) {
      const ids = byStorey.get(s) ?? [];
      const used = new Set<number>();
      for (const ph of [...PHASES, { name: "Otros", re: /.*/ }]) {
        const list = ids.filter((id) => !used.has(id) && ph.re.test(idx.elements.get(id)!.ifcClass));
        if (!list.length) continue;
        list.forEach((id) => used.add(id));
        const classes = [...new Set(list.map((id) => idx.elements.get(id)!.ifcClass))].join(", ");
        acts.push({ id: acts.length + 1, name: `${s} — ${ph.name}`, start: t, end: t + (days - 1) * DAY, ids: list, storey: s, classes, guids: "" });
        t += days * DAY;
      }
    }
    this.acts = acts;
    this.source = "Generada por niveles y fases";
    this.date = this.range[0];
    this.render();
    await this.apply();
    return acts.length;
  }

  /** Importa una programación CSV (Actividad;Inicio;Fin;Nivel;Clase IFC;GlobalId). Público para pruebas. */
  async importCsv(text: string, name = "CSV") {
    const idx = (this.idx ??= await this.ctx.index());
    const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new Error("El CSV no tiene actividades.");
    const sep = (lines[0].match(/;/g)?.length ?? 0) >= (lines[0].match(/,/g)?.length ?? 0) ? ";" : ",";
    const head = splitCsvLine(lines[0], sep).map((h) => h.toLowerCase());
    const col = (re: RegExp) => head.findIndex((h) => re.test(h));
    const cName = col(/actividad|tarea|nombre|activity|task/), cStart = col(/inicio|comienzo|start/), cEnd = col(/fin|final|end|finish/);
    const cStorey = col(/nivel|planta|storey|level/), cClass = col(/clase|ifc|categor/), cGuid = col(/globalid|guid/);
    if (cName < 0 || cStart < 0 || cEnd < 0) throw new Error("Faltan columnas: se necesitan «Actividad», «Inicio» y «Fin» (además de «Nivel», «Clase IFC» o «GlobalId» para enlazar elementos).");
    const assigned = new Set<number>();
    const acts: Activity[] = [];
    const bad: number[] = [];
    lines.slice(1).forEach((line, i) => {
      const c = splitCsvLine(line, sep);
      const start = parseDate(c[cStart] ?? ""), end = parseDate(c[cEnd] ?? "");
      if (start === null || end === null) return void bad.push(i + 2);
      const storey = cStorey >= 0 ? (c[cStorey] ?? "") : "";
      const classes = cClass >= 0 ? (c[cClass] ?? "") : "";
      const guids = cGuid >= 0 ? (c[cGuid] ?? "") : "";
      const clsSet = new Set(classes.split(/[,|]/).map((x) => x.trim().toLowerCase()).filter(Boolean));
      const guidSet = new Set(guids.split(/[\s,|]+/).filter(Boolean));
      const ids: number[] = [];
      if (storey || clsSet.size || guidSet.size)
        for (const e of idx.elements.values()) {
          if (assigned.has(e.localId)) continue;
          if (guidSet.size && !guidSet.has(e.guid)) continue;
          if (storey && (e.storey ?? "").toLowerCase() !== storey.toLowerCase()) continue;
          if (clsSet.size && !clsSet.has(e.ifcClass.toLowerCase())) continue;
          ids.push(e.localId);
        }
      ids.forEach((id) => assigned.add(id));
      acts.push({ id: acts.length + 1, name: c[cName] || `Actividad ${acts.length + 1}`, start, end: Math.max(start, end), ids, storey, classes, guids });
    });
    if (!acts.length) throw new Error("No se pudo leer ninguna actividad (revisa el formato de fechas: dd/mm/aaaa o aaaa-mm-dd).");
    acts.sort((a, b) => a.start - b.start);
    this.acts = acts;
    this.source = name;
    this.date = this.range[0];
    this.render();
    await this.apply();
    if (bad.length) this.ctx.notify(`Filas con fechas no válidas ignoradas: ${bad.slice(0, 8).join(", ")}${bad.length > 8 ? "…" : ""}`, "info");
    return { activities: acts.length, linked: assigned.size };
  }

  /** Estado del modelo en una fecha. Público para pruebas. */
  async setDate(t: number) {
    this.date = t;
    const out = this.el.querySelector<HTMLElement>(".date-out");
    if (out) out.textContent = dmy(t);
    const slider = this.el.querySelector<HTMLInputElement>('[data-role="slider"]');
    if (slider && Number(slider.value) !== t) slider.value = String(t);
    this.el.querySelectorAll<HTMLElement>("tr[data-act-id]").forEach((tr) => {
      const a = this.acts.find((x) => x.id === Number(tr.dataset.actId))!;
      tr.dataset.state = t < a.start ? "pending" : t > a.end ? "done" : "active";
    });
    const line = this.el.querySelector<HTMLElement>(".gantt-now");
    const [r0, r1] = this.range;
    if (line && r1 > r0) line.style.left = `${((t - r0) / (r1 + DAY - r0)) * 100}%`;
    await this.apply();
  }

  private again = false;
  private pending: Promise<void> | null = null;
  /** Aplica la fecha actual; si ya se está aplicando, se encadena (la promesa espera al final). */
  private apply(): Promise<void> {
    if (!this.active) return Promise.resolve();
    this.again = true;
    this.pending ??= this.applyLoop().finally(() => (this.pending = null));
    return this.pending;
  }

  private async applyLoop() {
    const v = this.ctx.viewer;
    while (this.again) {
      this.again = false;
      if (!this.acts.length) {
        await v.clearPaint();
        continue;
      }
      const t = this.date;
      const hidden: number[] = [], running: number[] = [];
      for (const a of this.acts) {
        if (t < a.start) hidden.push(...a.ids);
        else if (t <= a.end) running.push(...a.ids);
      }
      await v.setHiddenExactly(hidden);
      await v.paint([{ name: "4d-active", color: "#2fbf71", ids: running }]);
      this.state = { hidden: hidden.length, running: running.length };
    }
  }

  /** Último estado aplicado (pruebas). */
  state = { hidden: 0, running: 0 };

  private play() {
    if (this.playing) return this.stop();
    const [r0, r1] = this.range;
    if (this.date >= r1) this.date = r0;
    const tick = async () => {
      if (!this.playing) return;
      const next = this.date + DAY;
      if (next > r1) return this.stop();
      await this.setDate(next);
      if (this.playing) this.playing = window.setTimeout(tick, 150);
    };
    this.playing = window.setTimeout(tick, 0);
    this.render();
  }

  private stop() {
    if (!this.playing) return;
    window.clearTimeout(this.playing);
    this.playing = 0;
    this.render();
  }

  private render() {
    if (!this.ctx.viewer.hasModel) {
      this.el.innerHTML = `<p class="muted">Abre un modelo para crear una simulación 4D.</p>`;
      return;
    }
    const [r0, r1] = this.range;
    const span = Math.max(DAY, r1 + DAY - r0);
    const linked = new Set(this.acts.flatMap((a) => a.ids)).size;
    const total = this.idx?.elements.size ?? 0;
    const rows = this.acts
      .map((a) => {
        const left = ((a.start - r0) / span) * 100, width = Math.max(0.6, ((a.end + DAY - a.start) / span) * 100);
        const st = this.date < a.start ? "pending" : this.date > a.end ? "done" : "active";
        return `<tr data-act-id="${a.id}" data-state="${st}"><td>${esc(a.name)}</td><td class="num">${dmy(a.start)}</td><td class="num">${dmy(a.end)}</td><td class="num">${a.ids.length}</td><td class="gantt"><span class="gbar" style="left:${left}%;width:${width}%"></span></td></tr>`;
      })
      .join("");
    this.el.innerHTML = `
      <div class="row">
        <label>Inicio <input type="date" data-role="start" value="${this.startDate}"/></label>
        <label>Días por actividad <input type="number" min="1" max="365" value="${this.days}" data-role="days" style="width:60px"/></label>
        <button class="primary" data-act="gen">Generar por niveles</button>
        <span class="sep"></span>
        <button data-act="import">Importar CSV…</button>
        <input type="file" accept=".csv,.txt" data-role="file" hidden />
        <button data-act="template" ${this.acts.length ? "" : "disabled"} title="Descarga la programación actual en CSV para editarla en Excel y volver a importarla">Descargar CSV</button>
      </div>
      ${this.acts.length
        ? `<div class="fourd-player">
            <button data-act="play" class="primary">${this.playing ? "❚❚ Pausa" : "▶ Reproducir"}</button>
            <input type="range" data-role="slider" min="${r0}" max="${r1}" step="${DAY}" value="${this.date}"/>
            <b class="date-out">${dmy(this.date)}</b>
          </div>
          <p class="muted small">${esc(this.source)} · ${this.acts.length} actividades · ${linked} de ${total} elementos enlazados.
            <span class="legend"><span class="dot" style="background:#2fbf71"></span>en ejecución · terminados en su color · sin empezar ocultos</span></p>
          <div class="an-table-wrap"><table class="an-table gantt-table" data-testid="fourd-table"><thead><tr><th>Actividad</th><th>Inicio</th><th>Fin</th><th>Elem.</th><th class="gantt">Diagrama<span class="gantt-now" style="left:${((this.date - r0) / span) * 100}%"></span></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<p class="muted">Genera una programación por niveles (cimentación → estructura → cerramientos → instalaciones, nivel a nivel) o importa un CSV
            con columnas <b>Actividad; Inicio; Fin; Nivel; Clase IFC; GlobalId</b> (fechas dd/mm/aaaa). Cada actividad toma los elementos de ese nivel y esas clases, o los GlobalId indicados.</p>`}`;
  }

  private csv() {
    const q = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    return "﻿" + [["Actividad", "Inicio", "Fin", "Nivel", "Clase IFC", "GlobalId"], ...this.acts.map((a) => [a.name, dmy(a.start), dmy(a.end), a.storey, a.classes, a.guids])].map((r) => r.map((x) => q(String(x))).join(";")).join("\r\n");
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    try {
      if (act === "gen") await this.generate();
      else if (act === "import") this.el.querySelector<HTMLInputElement>('[data-role="file"]')!.click();
      else if (act === "template") download(this.csv(), `${this.ctx.modelName().replace(/\.ifc$/i, "")} - programación 4D.csv`, "text/csv;charset=utf-8");
      else if (act === "play") this.play();
      else {
        const tr = t.closest<HTMLElement>("tr[data-act-id]");
        if (tr) {
          const a = this.acts.find((x) => x.id === Number(tr.dataset.actId));
          if (a) await this.setDate(a.start);
        }
      }
    } catch (err) {
      console.error(err);
      this.ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.dataset.role === "slider") void this.setDate(Number(t.value));
    else if (t.dataset.role === "start") this.startDate = t.value;
    else if (t.dataset.role === "days") this.days = Math.max(1, Number(t.value) || 1);
  }

  private async onChange(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.dataset.role !== "file") return;
    const f = t.files?.[0];
    t.value = "";
    if (!f) return;
    try {
      const r = await this.importCsv(await f.text(), f.name);
      this.ctx.notify(`${r.activities} actividades importadas · ${r.linked} elementos enlazados.`, "info");
    } catch (err) {
      console.error(err);
      this.ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  report(): Sheet[] | null {
    if (!this.acts.length) return null;
    const idx = this.idx;
    const acts = [["#", "Actividad", "Inicio", "Fin", "Duración (días)", "Elementos", "Nivel", "Clases"], ...this.acts.map((a) => [a.id, a.name, dmy(a.start), dmy(a.end), Math.round((a.end - a.start) / DAY) + 1, a.ids.length, a.storey, a.classes])];
    const links = [["Actividad", "GlobalId", "Clase", "Nombre", "Nivel"]];
    for (const a of this.acts) for (const id of a.ids) {
      const e = idx?.elements.get(id);
      links.push([a.name, e?.guid ?? "", e?.ifcClass ?? "", e?.name ?? "", e?.storey ?? ""]);
    }
    return [
      { name: "Programación 4D", rows: acts, widths: [5, 50, 12, 12, 14, 10, 24, 50] },
      { name: "Elementos por actividad", rows: links, widths: [50, 24, 16, 40, 24] },
    ];
  }
}
