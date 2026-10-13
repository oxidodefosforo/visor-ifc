import "./style.css";
import { Viewer, UserError, type VisibilityState } from "./viewer/Viewer";
import type { NavMode } from "./viewer/Navigator";
import { renderProperties } from "./ui/propertiesPanel";
import { RealismPanels } from "./ui/realismPanels";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  open: $<HTMLButtonElement>("btn-open"),
  file: $<HTMLInputElement>("file-input"),
  close: $<HTMLButtonElement>("btn-close"),
  fit: $<HTMLButtonElement>("btn-fit"),
  fitSel: $<HTMLButtonElement>("btn-fit-sel"),
  hide: $<HTMLButtonElement>("btn-hide"),
  isolate: $<HTMLButtonElement>("btn-isolate"),
  show: $<HTMLButtonElement>("btn-show"),
  modelName: $("model-name"),
  empty: $("empty"),
  progress: $("progress"),
  progressStage: $("progress-stage"),
  progressPct: $("progress-pct"),
  progressFill: $("progress-fill"),
  badge: $("visibility-badge"),
  props: $("props"),
  navHud: $("nav-hud"),
  navHelp: $("nav-help"),
  navHelpBtn: $<HTMLButtonElement>("nav-help-btn"),
  speedVal: $("speed-val"),
  viewSeg: $("view-seg"),
  panel: $("panel"),
  toast: $("toast"),
  viewport: $("viewport"),
};

let hasSelection = false;
let toastTimer: number | undefined;

function refreshButtons(viewer: Viewer) {
  const model = viewer.hasModel;
  const busy = viewer.isLoading;
  ui.open.disabled = busy;
  ui.close.disabled = !model || busy;
  ui.fit.disabled = !model || busy;
  ui.fitSel.disabled = !model || !hasSelection || busy;
  ui.hide.disabled = !model || !hasSelection || busy;
  ui.isolate.disabled = !model || !hasSelection || busy;
  ui.show.disabled = !model || busy || viewer.visibilityState === "all";
  ui.empty.hidden = model || busy;
  ui.navHud.hidden = !model;
  ui.viewSeg.querySelectorAll("button").forEach((b) => (b.disabled = !model || busy));
  if (!model) ui.navHelp.hidden = true;
}

function showToast(message: string, kind: "error" | "info" = "error", detail?: string) {
  ui.toast.className = `toast ${kind}`;
  ui.toast.innerHTML = "";
  const msg = document.createElement("div");
  msg.textContent = message;
  ui.toast.append(msg);
  if (detail) {
    const d = document.createElement("details");
    d.innerHTML = "<summary>Detalle técnico</summary>";
    const pre = document.createElement("pre");
    pre.textContent = detail;
    d.append(pre);
    ui.toast.append(d);
  }
  ui.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (ui.toast.hidden = true), kind === "error" ? 12000 : 3500);
}

function setBadge(state: VisibilityState) {
  ui.badge.hidden = state === "all";
  ui.badge.textContent = state === "isolated" ? "Vista aislada" : "Hay elementos ocultos";
}

async function run(viewer: Viewer, action: () => Promise<unknown>) {
  try {
    await action();
  } catch (err) {
    console.error(err);
    showToast("La operación falló.", "error", err instanceof Error ? err.message : String(err));
  } finally {
    refreshButtons(viewer);
  }
}

async function openFile(viewer: Viewer, file: File) {
  document.body.dataset.modelState = "loading";
  ui.progress.hidden = false;
  ui.empty.hidden = true;
  hasSelection = false;
  renderProperties(ui.props, null, 0);
  refreshButtons(viewer);
  const started = performance.now();
  try {
    const { name } = await viewer.loadIfc(file, ({ value, stage }) => {
      const pct = Math.round(value * 100);
      ui.progressStage.textContent = stage;
      ui.progressPct.textContent = `${pct} %`;
      ui.progressFill.style.width = `${pct}%`;
    });
    ui.modelName.textContent = name;
    ui.modelName.title = name;
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    showToast(`Modelo cargado en ${secs} s.`, "info");
    document.body.dataset.modelState = "loaded";
    panels?.renderMaterials();
  } catch (err) {
    console.error(err);
    const e = err instanceof UserError ? err : new UserError("No se pudo cargar el modelo.", String(err));
    showToast(e.message, "error", e.detail);
    document.body.dataset.modelState = "error";
  } finally {
    ui.progress.hidden = true;
    refreshButtons(viewer);
  }
}

let panels: RealismPanels | null = null;

function showTab(tab: string) {
  ui.panel.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  for (const t of ["info", "materials", "env"]) $(`tab-${t}`).hidden = t !== tab;
  if (tab === "materials") panels?.renderMaterials();
  document.body.dataset.tab = tab;
}

async function setRealistic(viewer: Viewer, on: boolean) {
  ui.viewSeg.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) =>
    b.classList.toggle("active", (b.dataset.view === "realistic") === on),
  );
  document.body.dataset.view = on ? "realistic" : "technical";
  await viewer.setRealistic(on);
  panels?.renderMaterials();
}

async function start() {
  // Una sola instancia del visor. Si Vite recarga este módulo (HMR),
  // se libera la anterior antes de crear otra.
  const viewer = new Viewer(ui.viewport, {
    onSelectionChange: (info, count) => {
      hasSelection = count > 0;
      panels?.renderMaterials();
      renderProperties(ui.props, info, count, {
        fit: () => void run(viewer, () => viewer.fitSelection()),
        isolate: () => void run(viewer, () => viewer.isolateSelected()),
        hide: () => void run(viewer, () => viewer.hideSelected()),
        notify: (msg) => showToast(msg, "info"),
      });
      refreshButtons(viewer);
    },
    onNavChange: (s) => {
      ui.navHud.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) =>
        b.classList.toggle("active", b.dataset.mode === s.mode),
      );
      ui.speedVal.textContent = `${s.speedMultiplier}×`;
      $("help-left").textContent = s.mode === "fly" ? "Mirar alrededor" : "Orbitar alrededor del modelo";
      document.body.dataset.navMode = s.mode;
    },
    onVisibilityChange: (state) => {
      setBadge(state);
      refreshButtons(viewer);
    },
  });

  try {
    await viewer.init();
  } catch (err) {
    console.error(err);
    showToast("No se pudo iniciar el visor 3D. Comprueba que el navegador soporta WebGL.", "error", String(err));
    return;
  }

  const ac = new AbortController();
  const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, ev: K, fn: (e: HTMLElementEventMap[K]) => void) =>
    el.addEventListener(ev, fn as EventListener, { signal: ac.signal });

  on(ui.open, "click", () => ui.file.click());
  on(ui.file, "change", () => {
    const f = ui.file.files?.[0];
    ui.file.value = ""; // permite volver a abrir el mismo archivo
    if (f) void openFile(viewer, f);
  });
  on(ui.close, "click", () =>
    run(viewer, async () => {
      await viewer.closeModel();
      ui.modelName.textContent = "";
      document.body.dataset.modelState = "closed";
      panels?.renderMaterials();
    }),
  );
  on(ui.fit, "click", () => run(viewer, () => viewer.fitAll()));
  on(ui.fitSel, "click", () => run(viewer, () => viewer.fitSelection()));
  on(ui.hide, "click", () => run(viewer, () => viewer.hideSelected()));
  on(ui.isolate, "click", () => run(viewer, () => viewer.isolateSelected()));
  on(ui.show, "click", () => run(viewer, () => viewer.showAll()));

  // Arrastrar y soltar
  on(ui.viewport.parentElement!, "dragover", (e) => {
    e.preventDefault();
    ui.viewport.parentElement!.classList.add("drag");
  });
  on(ui.viewport.parentElement!, "dragleave", () => ui.viewport.parentElement!.classList.remove("drag"));
  on(ui.viewport.parentElement!, "drop", (e) => {
    e.preventDefault();
    ui.viewport.parentElement!.classList.remove("drag");
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f && !viewer.isLoading) void openFile(viewer, f);
  });

  // Navegación: modo, velocidad y ayuda
  on(ui.navHud, "click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!btn) return;
    if (btn.dataset.mode) void run(viewer, () => viewer.setNavMode(btn.dataset.mode as NavMode));
    else if (btn.id === "speed-up") viewer.nav.setSpeed(1);
    else if (btn.id === "speed-down") viewer.nav.setSpeed(-1);
    else if (btn.id === "nav-help-btn") {
      ui.navHelp.hidden = !ui.navHelp.hidden;
      ui.navHelpBtn.setAttribute("aria-expanded", String(!ui.navHelp.hidden));
    }
    btn.blur(); // que las teclas WASD no «pulsen» el botón enfocado
  });

  // Atajos de teclado
  on(window, "keydown", (e) => {
    const ke = e as KeyboardEvent;
    const k = ke.key.toLowerCase();
    const t = e.target as HTMLElement;
    if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || !viewer.hasModel) return;
    if (ke.ctrlKey || ke.metaKey || ke.altKey) return;
    if (k === "escape") void run(viewer, () => viewer.clearSelection());
    else if (k === "f") void run(viewer, () => viewer.fitAll());
    else if (k === "h" && hasSelection) void run(viewer, () => viewer.hideSelected());
    else if (k === "i" && hasSelection) void run(viewer, () => viewer.isolateSelected());
    else if (k === "r") void run(viewer, () => viewer.showAll());
  });

  // Vista técnica / realista y pestañas del panel
  panels = new RealismPanels(viewer, $("materials"), $("env"), (m, k = "info") => showToast(m, k), (on) => setRealistic(viewer, on));
  on(ui.viewSeg, "click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-view]");
    if (b) void run(viewer, () => setRealistic(viewer, b.dataset.view === "realistic"));
  });
  on(ui.panel, "click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-tab]");
    if (b?.dataset.tab) showTab(b.dataset.tab);
  });
  document.body.dataset.view = "technical";
  showTab("info");

  setupDesktop(viewer);
  renderProperties(ui.props, null, 0);
  refreshButtons(viewer);
  document.body.dataset.viewerReady = "true";
  // Acceso para pruebas automatizadas y depuración desde la consola.
  (window as unknown as { __viewer?: Viewer }).__viewer = viewer;

  const teardown = () => {
    ac.abort();
    void viewer.dispose();
  };
  window.addEventListener("pagehide", teardown, { once: true });
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      window.removeEventListener("pagehide", teardown);
      teardown();
    });
  }
}

// ---------- Integración con la aplicación de escritorio (Electron) ----------
// En el navegador `window.visorDesktop` no existe y esto no hace nada.
type UpdateStatus = { status: "checking" | "none" | "downloading" | "ready" | "error"; version?: string; percent?: number };
type DesktopBridge = {
  getInfo: () => Promise<{ version: string; packaged: boolean }>;
  onMenu: (cb: (action: string) => void) => void;
  onUpdateStatus: (cb: (s: UpdateStatus) => void) => void;
};

function setupDesktop(viewer: Viewer) {
  const desktop = (window as unknown as { visorDesktop?: DesktopBridge }).visorDesktop;
  if (!desktop) return;
  document.body.dataset.desktop = "true";
  const versionEl = $("app-version");
  void desktop.getInfo().then(({ version }) => {
    versionEl.textContent = `v${version}`;
    versionEl.hidden = false;
  });
  desktop.onMenu((action) => {
    if (action === "open" && !viewer.isLoading) ui.file.click();
    if (action === "close") ui.close.click();
  });
  const updateEl = $("update-status");
  desktop.onUpdateStatus((s) => {
    if (s.status === "downloading") {
      updateEl.hidden = false;
      updateEl.textContent = `Descargando actualización${s.version ? ` ${s.version}` : ""}… ${s.percent ?? 0} %`;
    } else if (s.status === "ready") {
      updateEl.hidden = false;
      updateEl.textContent = `Versión ${s.version} lista: se instalará al cerrar`;
    } else {
      updateEl.hidden = true;
    }
  });
}

void start();
