import type { Viewer } from "../viewer/Viewer";
import { configFromPreset, presetByKey, type MatConfig } from "../render/materials";
import { Popover, esc, presetGridHtml, swatch } from "./swatch";

/**
 * Menú del botón derecho sobre un elemento (clic sin arrastrar; arrastrar con el derecho sigue
 * desplazando la vista). Permite cambiar el acabado de:
 *  - la instancia (o la selección, si el elemento forma parte de una selección múltiple),
 *  - su tipo IFC (todas las instancias del tipo),
 *  - su material IFC (todos los elementos con ese material).
 * Prioridad al dibujar: instancia > tipo > material IFC. El menú queda abierto para probar
 * varios acabados seguidos; se cierra con Esc o clic fuera.
 */
type Scope = "instance" | "type" | "group";

const SCOPE_KEY = "visor.ctx.scope";
const readScope = (): Scope => {
  try {
    const s = localStorage.getItem(SCOPE_KEY);
    return s === "instance" || s === "group" || s === "type" ? s : "type";
  } catch {
    return "type";
  }
};

export type ContextMenuHooks = {
  setRealistic: (on: boolean) => Promise<void>;
  notify: (msg: string, kind?: "info" | "error") => void;
  editMaterial: (groupName: string) => void;
};

export class ContextMenu {
  private pop = new Popover("ctx-menu");
  private ac = new AbortController();
  private down: { x: number; y: number; t: number } | null = null;
  private localId: number | null = null;
  private targets: number[] = [];
  private scope: Scope = readScope();
  private header = "";
  private at = { x: 0, y: 0 };
  private busy = false;

  constructor(private viewer: Viewer, private hooks: ContextMenuHooks) {
    const dom = viewer.canvas;
    const o = { signal: this.ac.signal };
    dom.addEventListener("pointerdown", (e) => {
      if (e.button === 2) this.down = { x: e.clientX, y: e.clientY, t: performance.now() };
    }, o);
    // pointerup en la ventana: camera-controls (Órbita) captura el puntero.
    window.addEventListener("pointerup", (e) => {
      const d = this.down;
      this.down = null;
      if (e.button !== 2 || !d) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5 || performance.now() - d.t > 800) return; // fue un arrastre
      void this.openAt(e.clientX, e.clientY);
    }, o);
    this.pop.el.addEventListener("click", (e) => void this.onClick(e));
  }

  get isOpen() {
    return this.pop.isOpen;
  }

  close() {
    this.pop.close();
  }

  /** Abre el menú para el elemento bajo (x, y). Público para pruebas. */
  async openAt(x: number, y: number) {
    if (!this.viewer.hasModel || this.viewer.isLoading) return;
    const id = await this.viewer.pickAt(x, y);
    if (id === null) {
      this.pop.close();
      return;
    }
    this.localId = id;
    this.at = { x, y };
    const sel = this.viewer.selectedLocalIds();
    // Si se pulsa sobre una selección múltiple, «instancia» actúa sobre toda la selección.
    this.targets = sel.length > 1 && sel.includes(id) ? sel : [id];
    if (!sel.includes(id)) await this.viewer.selectLocalIds([id]);
    this.header = "";
    this.render();
    const modelId = this.viewer.modelId;
    if (modelId) {
      void this.viewer.getElementInfo(modelId, id).then((info) => {
        if (!info || this.localId !== id || !this.pop.isOpen) return;
        this.header = `${info.ifcClass ?? ""}${info.name ? ` · ${info.name}` : ""}`;
        const h = this.pop.el.querySelector(".ctx-title");
        if (h) h.textContent = this.header;
      });
    }
  }

  private render() {
    const id = this.localId;
    if (id === null) return;
    const a = this.viewer.appearance;
    const ctx = a.elementContext(id);
    const tex = a.profile.customTextures;
    const ownCfg = this.targets.length > 1 ? a.elementConfig(this.targets[0]) : ctx.own;
    if (this.scope === "type" && !ctx.type) this.scope = "instance";
    if (this.scope === "group" && !ctx.group) this.scope = "instance";

    const current: Record<Scope, MatConfig | null> = { instance: ownCfg, type: ctx.typeCfg, group: ctx.groupCfg };
    const tab = (s: Scope, label: string, sub: string, enabled: boolean) =>
      `<button type="button" class="ctx-tab ${this.scope === s ? "active" : ""}" data-scope="${s}" ${enabled ? "" : "disabled"}>
        ${swatch(current[s], tex)}<span class="ctx-tab-text"><b>${esc(label)}</b><small>${esc(sub)}</small></span></button>`;
    const instLabel = this.targets.length > 1 ? `Selección (${this.targets.length})` : "Esta instancia";
    const analyzing = !ctx.group && !a.groups.length;
    const scopeDesc: Record<Scope, string> = {
      instance: this.targets.length > 1 ? `${this.targets.length} elementos seleccionados` : "Solo este elemento",
      type: ctx.type ? `${ctx.type.localIds.length} elementos del tipo «${ctx.type.name}»` : "Sin tipo IFC",
      group: ctx.group ? `${ctx.group.localIds.length} elementos con el material «${ctx.group.name}»` : "Sin material IFC",
    };
    const cur = current[this.scope];
    // Qué se ve ahora mismo en el elemento (por prioridad) para orientar al usuario.
    const effective = ctx.own ? "instancia" : ctx.typeCfg ? "tipo" : ctx.groupCfg ? "material IFC" : null;
    const effCfg = ctx.own ?? ctx.typeCfg ?? ctx.groupCfg;

    this.pop.open(
      `<div class="ctx-head">
        <div class="ctx-title" title="${esc(this.header)}">${esc(this.header || "Elemento #" + id)}</div>
        <div class="ctx-sub">${effCfg ? `Acabado visible: <b>${esc(presetByKey(effCfg.preset)?.name ?? effCfg.preset)}</b> (por ${effective})` : "Sin acabado asignado (color del IFC)"}</div>
      </div>
      <div class="ctx-label">Cambiar material de…</div>
      <div class="ctx-tabs" role="tablist">
        ${tab("instance", instLabel, this.targets.length > 1 ? "toda la selección" : "solo este", true)}
        ${tab("type", "Tipo", ctx.type ? `${ctx.type.localIds.length} elem.` : "—", !!ctx.type)}
        ${tab("group", "Material IFC", ctx.group ? `${ctx.group.localIds.length} elem.` : analyzing ? "analizando…" : "—", !!ctx.group)}
      </div>
      <div class="ctx-scope-desc" data-testid="ctx-scope-desc">${esc(scopeDesc[this.scope])}</div>
      ${presetGridHtml(cur?.preset ?? null, cur ? "Quitar (heredar)" : null)}
      <div class="ctx-actions">
        ${this.scope === "group" && ctx.group ? `<button type="button" data-act="edit">Ajustar color, textura…</button>` : ""}
        <button type="button" data-act="select-type" ${ctx.type ? "" : "disabled"}>Seleccionar el tipo</button>
        <button type="button" data-act="fit">Encuadrar</button>
        <button type="button" data-act="hide">Ocultar</button>
        <button type="button" data-act="isolate">Aislar</button>
      </div>`,
      this.at.x + 2,
      this.at.y + 2,
    );
    this.pop.el.dataset.activeScope = this.scope;
    this.pop.el.dataset.localId = String(id);
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const id = this.localId;
    if (id === null || this.busy) return;
    const scopeBtn = t.closest<HTMLButtonElement>(".ctx-tab[data-scope]");
    if (scopeBtn && !scopeBtn.disabled) {
      this.scope = scopeBtn.dataset.scope as Scope;
      try { localStorage.setItem(SCOPE_KEY, this.scope); } catch { /* sin almacenamiento */ }
      this.render();
      return;
    }
    const presetBtn = t.closest<HTMLButtonElement>("[data-preset]");
    if (presetBtn) {
      await this.apply(presetBtn.dataset.preset || null);
      return;
    }
    const act = t.closest<HTMLButtonElement>("[data-act]")?.dataset.act;
    if (!act) return;
    const a = this.viewer.appearance;
    const ctx = a.elementContext(id);
    try {
      if (act === "edit" && ctx.group) {
        this.close();
        this.hooks.editMaterial(ctx.group.name);
      } else if (act === "select-type" && ctx.type) {
        this.close();
        await this.viewer.selectLocalIds(ctx.type.localIds);
      } else if (act === "fit") {
        this.close();
        await this.viewer.fitLocalIds(this.targets);
      } else if (act === "hide") {
        this.close();
        await this.viewer.hideLocalIds(this.targets);
      } else if (act === "isolate") {
        this.close();
        await this.viewer.isolateLocalIds(this.targets);
      }
    } catch (err) {
      console.error(err);
      this.hooks.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  private async apply(preset: string | null) {
    const id = this.localId!;
    const a = this.viewer.appearance;
    const ctx = a.elementContext(id);
    const cfg = preset ? configFromPreset(preset) : null;
    this.busy = true;
    this.pop.el.classList.add("busy");
    try {
      if (cfg && !a.realistic) await this.hooks.setRealistic(true);
      if (this.scope === "instance") await a.setElementConfig(this.targets, cfg);
      else if (this.scope === "type" && ctx.type) {
        // Si alguna instancia tenía acabado propio, se avisa (la instancia manda sobre el tipo).
        await a.setTypeConfig(ctx.type.key, cfg);
      } else if (this.scope === "group" && ctx.group) await a.setMaterialConfig(ctx.group.name, cfg);
      if (cfg && this.scope !== "instance" && ctx.own) {
        this.hooks.notify("Este elemento tiene un acabado propio (instancia), que manda sobre el del tipo o material. Quítalo en «Esta instancia».", "info");
      }
    } catch (err) {
      console.error(err);
      this.hooks.notify(err instanceof Error ? err.message : String(err), "error");
    } finally {
      this.busy = false;
      this.pop.el.classList.remove("busy");
    }
    if (this.pop.isOpen) this.render(); // refresca marcas y muestras, el menú sigue abierto
  }

  dispose() {
    this.ac.abort();
    this.pop.dispose();
  }
}
