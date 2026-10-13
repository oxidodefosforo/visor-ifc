import type { Viewer } from "../../viewer/Viewer";
import { ModelIndex } from "../../analysis/modelIndex";
import { buildXlsx, download, XLSX_MIME } from "../../analysis/xlsx";
import type { AnalysisContext, AnalysisTab } from "./types";
import { ClashTab } from "./clashTab";
import { IdsTab } from "./idsTab";
import { CompareTab } from "./compareTab";
import { FourDTab } from "./fourdTab";

/**
 * Panel inferior «Análisis»: Interferencias, Validación IDS, Comparar versiones y 4D.
 * Solo la pestaña visible colorea el modelo; al cerrar el panel todo vuelve a su estado.
 */
export class AnalysisDock {
  readonly tabs: AnalysisTab[];
  private current: AnalysisTab;
  private open = false;
  private indexPromise: Promise<ModelIndex> | null = null;
  private indexModel: string | null = null;
  private height = 300;

  constructor(
    private viewer: Viewer,
    private root: HTMLElement,
    private wrap: HTMLElement,
    private toggleBtn: HTMLButtonElement,
    notify: (msg: string, kind?: "info" | "error") => void,
    modelName: () => string,
  ) {
    const ctx: AnalysisContext = { viewer, notify, index: () => this.index(), modelName };
    this.tabs = [new ClashTab(ctx), new IdsTab(ctx), new CompareTab(ctx), new FourDTab(ctx)];
    this.current = this.tabs[0];
    try {
      const h = Number(localStorage.getItem("visor.dock.h"));
      if (h > 120) this.height = h;
    } catch { /* sin almacenamiento */ }
    root.innerHTML = `
      <div class="dock-resizer" title="Arrastra para cambiar la altura"></div>
      <div class="dock-head">
        <div class="dock-tabs" role="tablist">${this.tabs.map((t) => `<button role="tab" data-dock-tab="${t.id}">${t.title}</button>`).join("")}</div>
        <span class="spacer"></span>
        <button class="small" data-act="xlsx" title="Informe Excel de la pestaña activa">Excel</button>
        <button class="small icon" data-act="close" title="Cerrar el panel">×</button>
      </div>
      <div class="dock-body"></div>`;
    const body = root.querySelector<HTMLElement>(".dock-body")!;
    for (const t of this.tabs) {
      t.el.hidden = true;
      body.append(t.el);
    }
    root.addEventListener("click", (e) => void this.onClick(e));
    toggleBtn.addEventListener("click", () => void (this.open ? this.close() : this.show()));
    this.setupResize(root.querySelector<HTMLElement>(".dock-resizer")!);
  }

  get isOpen() {
    return this.open;
  }

  private index() {
    const model = this.viewer.model;
    if (!model) return Promise.reject(new Error("No hay modelo abierto."));
    if (!this.indexPromise || this.indexModel !== model.modelId) {
      this.indexModel = model.modelId;
      this.indexPromise = ModelIndex.build(model);
    }
    return this.indexPromise;
  }

  async show(tabId?: string) {
    this.open = true;
    this.root.hidden = false;
    this.toggleBtn.classList.add("active");
    this.wrap.style.setProperty("--dock-h", `${this.height}px`);
    document.body.dataset.dock = "open";
    await this.select(tabId ?? this.current.id, true);
  }

  async close() {
    if (!this.open) return;
    this.open = false;
    await this.current.deactivate();
    this.root.hidden = true;
    this.toggleBtn.classList.remove("active");
    this.wrap.style.setProperty("--dock-h", "0px");
    document.body.dataset.dock = "closed";
  }

  async select(id: string, force = false) {
    const next = this.tabs.find((t) => t.id === id) ?? this.tabs[0];
    if (next === this.current && !force) return;
    if (next !== this.current) await this.current.deactivate();
    this.current = next;
    for (const t of this.tabs) t.el.hidden = t !== next;
    this.root.querySelectorAll<HTMLButtonElement>("[data-dock-tab]").forEach((b) => b.classList.toggle("active", b.dataset.dockTab === id));
    document.body.dataset.dockTab = next.id;
    try {
      await next.activate();
    } catch (err) {
      console.error(err);
    }
  }

  /** El modelo se cerró o cambió. */
  reset() {
    this.indexPromise = null;
    this.indexModel = null;
    for (const t of this.tabs) t.reset();
  }

  /** El modelo abierto acaba de cargarse: refrescar la pestaña visible. */
  async modelLoaded() {
    this.reset();
    if (this.open) await this.current.activate();
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const tab = t.closest<HTMLElement>("button[data-dock-tab]")?.dataset.dockTab;
    if (tab) return void this.select(tab);
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") return void this.close();
    if (act === "xlsx") {
      const sheets = this.current.report();
      if (!sheets) return;
      const name = this.viewer.hasModel ? (document.getElementById("model-name")?.textContent ?? "modelo").replace(/\.ifc$/i, "") : "modelo";
      download(buildXlsx(sheets), `${name} - ${this.current.title}.xlsx`, XLSX_MIME);
    }
  }

  private setupResize(handle: HTMLElement) {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startY = e.clientY, startH = this.height;
      const move = (ev: PointerEvent) => {
        const max = this.wrap.clientHeight - 120;
        this.height = Math.max(140, Math.min(max, startH + (startY - ev.clientY)));
        this.wrap.style.setProperty("--dock-h", `${this.height}px`);
      };
      const up = () => {
        handle.removeEventListener("pointermove", move);
        try { localStorage.setItem("visor.dock.h", String(this.height)); } catch { /* sin almacenamiento */ }
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up, { once: true });
    });
  }
}
