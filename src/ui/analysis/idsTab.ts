import * as OBC from "@thatopen/components";
import type { Sheet } from "../../analysis/xlsx";
import { esc, type AnalysisContext, type AnalysisTab } from "./types";

/**
 * Validación IDS (Information Delivery Specification de buildingSMART) con el componente
 * IDSSpecifications de That Open: se carga un .ids, se evalúa cada especificación sobre el modelo
 * abierto y se listan los elementos que cumplen / no cumplen con el motivo.
 */
type ItemResult = { localId: number; pass: boolean; reasons: string[] };
type SpecResult = { id: string; name: string; description: string; items: ItemResult[]; pass: number; fail: number; error?: string };

const FACET_ES: Record<string, string> = { Entity: "Entidad", Attribute: "Atributo", Property: "Propiedad", Classification: "Clasificación", Material: "Material", PartOf: "Parte de" };

function paramText(p: unknown): string {
  if (p === undefined || p === null) return "";
  if (typeof p !== "object") return String(p);
  const o = p as { type?: string; parameter?: unknown };
  if (o.type === "simple") return String(o.parameter);
  if (o.type === "enumeration") return `uno de [${(o.parameter as unknown[]).join(", ")}]`;
  if (o.type === "pattern") return `patrón ${String(o.parameter)}`;
  if (o.type === "bounds") {
    const b = o.parameter as { min?: number; max?: number };
    return `entre ${b.min ?? "−∞"} y ${b.max ?? "∞"}`;
  }
  if (o.type === "length") return `longitud ${JSON.stringify(o.parameter)}`;
  return JSON.stringify(p);
}

export class IdsTab implements AnalysisTab {
  readonly id = "ids";
  readonly title = "Validación IDS";
  readonly el = document.createElement("div");
  private fileName = "";
  private xml = "";
  private results: SpecResult[] = [];
  private openSpec: string | null = null;
  private onlyFail = true;
  private active = false;
  private busy = false;

  constructor(private ctx: AnalysisContext) {
    this.el.className = "an-tab ids-tab";
    this.el.addEventListener("click", (e) => void this.onClick(e));
    this.el.addEventListener("change", (e) => void this.onChange(e));
  }

  reset() {
    this.results = [];
    this.openSpec = null;
    this.render();
  }

  async activate() {
    this.active = true;
    this.render();
    await this.paint();
  }

  async deactivate() {
    this.active = false;
    await this.ctx.viewer.clearPaint();
    await this.ctx.viewer.focusElements(null);
  }

  /** Carga y evalúa un IDS (texto XML). Público para pruebas. */
  async runXml(xml: string, fileName: string) {
    const v = this.ctx.viewer;
    const model = v.model;
    if (!model) throw new Error("Abre primero un modelo.");
    this.busy = true;
    this.xml = xml;
    this.fileName = fileName;
    this.render();
    const ids = v.components.get(OBC.IDSSpecifications);
    ids.list.clear();
    let specs: OBC.IDSSpecification[];
    try {
      specs = ids.load(xml);
    } catch (err) {
      this.busy = false;
      this.render();
      throw new Error(`El archivo no es un IDS válido: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!specs.length) {
      this.busy = false;
      this.render();
      throw new Error("El IDS no contiene especificaciones que se puedan evaluar.");
    }
    const re = new RegExp(`^${model.modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    this.results = [];
    for (const spec of specs) {
      const r: SpecResult = { id: spec.identifier, name: spec.name, description: spec.description ?? "", items: [], pass: 0, fail: 0 };
      try {
        const res = await spec.test([re]);
        const map = res.get(model.modelId);
        for (const [localId, item] of map ?? []) {
          const reasons: string[] = [];
          if (!item.pass) {
            for (const f of item.checks) {
              if (f.pass) continue;
              const failed = f.checks.filter((c) => !c.pass);
              if (!failed.length) reasons.push(`${FACET_ES[f.facetType] ?? f.facetType}: no cumple`);
              for (const c of failed) {
                const cur = c.currentValue === undefined || c.currentValue === null || c.currentValue === "" ? "falta" : `«${String(c.currentValue)}»`;
                const req = c.requiredValue !== undefined ? `; se requiere ${paramText(c.requiredValue)}` : "";
                reasons.push(`${FACET_ES[f.facetType] ?? f.facetType}${c.parameter ? ` (${c.parameter})` : ""}: ${cur}${req}`);
              }
            }
          }
          r.items.push({ localId, pass: item.pass, reasons });
          if (item.pass) r.pass++;
          else r.fail++;
        }
      } catch (err) {
        r.error = err instanceof Error ? err.message : String(err);
      }
      this.results.push(r);
    }
    this.busy = false;
    this.openSpec = this.results.find((r) => r.fail)?.id ?? this.results[0]?.id ?? null;
    this.render();
    await this.paint();
    return this.results.map((r) => ({ name: r.name, pass: r.pass, fail: r.fail, error: r.error }));
  }

  private render() {
    if (!this.ctx.viewer.hasModel) {
      this.el.innerHTML = `<p class="muted">Abre un modelo para validarlo con un IDS.</p>`;
      return;
    }
    const idx = this.idxSync;
    const specs = this.results
      .map((r) => {
        const total = r.pass + r.fail;
        const pct = total ? Math.round((r.pass / total) * 100) : 0;
        const open = this.openSpec === r.id;
        const items = open
          ? r.items
              .filter((i) => !this.onlyFail || !i.pass)
              .slice(0, 500)
              .map((i) => `<tr data-el="${i.localId}"><td><span class="dot ${i.pass ? "ok" : "ko"}"></span>${esc(idx?.label(i.localId) ?? `#${i.localId}`)}</td><td class="muted">${esc(idx?.elements.get(i.localId)?.storey ?? "")}</td><td>${i.pass ? "Cumple" : esc(i.reasons.join(" · "))}</td></tr>`)
              .join("")
          : "";
        return `<div class="spec ${open ? "open" : ""}" data-spec="${esc(r.id)}">
          <div class="spec-head" data-act="toggle">
            <span class="spec-name">${esc(r.name)}</span>
            ${r.error ? `<span class="ko-text">Error: ${esc(r.error)}</span>` : total ? `<span class="meter"><span style="width:${pct}%"></span></span><span class="spec-count"><b class="ok-text">${r.pass}</b> cumplen · <b class="ko-text">${r.fail}</b> no cumplen</span>` : `<span class="muted">No se aplica a ningún elemento</span>`}
          </div>
          ${open ? `${r.description ? `<p class="muted small">${esc(r.description)}</p>` : ""}
            <div class="an-table-wrap"><table class="an-table"><thead><tr><th>Elemento</th><th>Nivel</th><th>Resultado</th></tr></thead><tbody>${items || `<tr><td colspan="3" class="muted">Sin elementos ${this.onlyFail ? "que incumplan" : ""}.</td></tr>`}</tbody></table></div>
            ${r.items.filter((i) => !this.onlyFail || !i.pass).length > 500 ? `<p class="muted small">Se muestran 500; el informe Excel los incluye todos.</p>` : ""}` : ""}
        </div>`;
      })
      .join("");
    this.el.innerHTML = `
      <div class="row">
        <button class="primary" data-act="open" ${this.busy ? "disabled" : ""}>Abrir archivo IDS…</button>
        <input type="file" accept=".ids,.xml" data-role="file" hidden />
        ${this.xml ? `<button data-act="rerun" ${this.busy ? "disabled" : ""}>Volver a validar</button>` : ""}
        <span class="muted">${this.busy ? "Validando…" : this.fileName ? esc(this.fileName) : "Especificación de requisitos de información (buildingSMART IDS 1.0)"}</span>
        ${this.results.length ? `<label class="chk right"><input type="checkbox" data-role="onlyfail" ${this.onlyFail ? "checked" : ""}/> Solo los que no cumplen</label>` : ""}
      </div>
      <div class="specs" data-testid="ids-specs">${specs || `<p class="muted">Carga un archivo .ids para comprobar qué elementos cumplen los requisitos (clases, atributos, propiedades, materiales, clasificación…). Verde = cumple, rojo = no cumple.</p>`}</div>`;
  }

  private idxSync: Awaited<ReturnType<AnalysisContext["index"]>> | null = null;

  private async paint() {
    if (!this.active) return;
    const v = this.ctx.viewer;
    const r = this.results.find((x) => x.id === this.openSpec);
    if (!r || !r.items.length) {
      await v.clearPaint();
      return void (await v.focusElements(null));
    }
    this.idxSync ??= await this.ctx.index();
    // Solo los elementos a los que aplica la especificación; el resto como contexto translúcido.
    await v.focusElements(r.items.map((i) => i.localId));
    await v.paint([
      { name: "ids-ok", color: "#34c27a", ids: r.items.filter((i) => i.pass).map((i) => i.localId) },
      { name: "ids-ko", color: "#ff3b30", ids: r.items.filter((i) => !i.pass).map((i) => i.localId) },
    ]);
    this.render();
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    try {
      if (act === "open") this.el.querySelector<HTMLInputElement>('[data-role="file"]')!.click();
      else if (act === "rerun") await this.runXml(this.xml, this.fileName);
      else if (act === "toggle") {
        const id = t.closest<HTMLElement>("[data-spec]")!.dataset.spec!;
        this.openSpec = this.openSpec === id ? null : id;
        this.render();
        await this.paint();
      } else {
        const row = t.closest<HTMLElement>("tr[data-el]");
        if (row) {
          const id = Number(row.dataset.el);
          await this.ctx.viewer.fitLocalIds([id]);
          await this.ctx.viewer.selectLocalIds([id]);
        }
      }
    } catch (err) {
      console.error(err);
      this.ctx.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  private async onChange(e: Event) {
    const t = e.target as HTMLInputElement;
    if (t.dataset.role === "file") {
      const f = t.files?.[0];
      t.value = "";
      if (!f) return;
      try {
        const res = await this.runXml(await f.text(), f.name);
        const fail = res.reduce((n, r) => n + r.fail, 0);
        this.ctx.notify(`${res.length} especificaciones evaluadas · ${fail} incumplimientos.`, "info");
      } catch (err) {
        console.error(err);
        this.ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    } else if (t.dataset.role === "onlyfail") {
      this.onlyFail = t.checked;
      this.render();
    }
  }

  report(): Sheet[] | null {
    if (!this.results.length) return null;
    const idx = this.idxSync;
    const summary = [["Especificación", "Descripción", "Cumplen", "No cumplen", "% cumplimiento", "Error"], ...this.results.map((r) => [r.name, r.description, r.pass, r.fail, r.pass + r.fail ? Math.round((r.pass / (r.pass + r.fail)) * 1000) / 10 : "", r.error ?? ""])];
    const detail = [["Especificación", "Resultado", "Clase", "Nombre", "GlobalId", "Nivel", "Motivo"]];
    for (const r of this.results)
      for (const i of r.items) {
        const e = idx?.elements.get(i.localId);
        detail.push([r.name, i.pass ? "Cumple" : "No cumple", e?.ifcClass ?? "", e?.name ?? "", e?.guid ?? "", e?.storey ?? "", i.reasons.join(" · ")]);
      }
    return [
      { name: "Resumen IDS", rows: summary, widths: [40, 50, 10, 12, 14, 30] },
      { name: "Detalle IDS", rows: detail, widths: [34, 12, 16, 40, 24, 22, 70] },
    ];
  }
}
