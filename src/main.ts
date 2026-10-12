import "./style.css";
import { Viewer, UserError, type VisibilityState } from "./viewer/Viewer";
import { renderProperties } from "./ui/propertiesPanel";

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

async function start() {
  // Una sola instancia del visor. Si Vite recarga este módulo (HMR),
  // se libera la anterior antes de crear otra.
  const viewer = new Viewer(ui.viewport, {
    onSelectionChange: (info, count) => {
      hasSelection = count > 0;
      renderProperties(ui.props, info, count);
      refreshButtons(viewer);
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

  // Atajos de teclado
  on(window, "keydown", (e) => {
    const k = (e as KeyboardEvent).key.toLowerCase();
    if ((e.target as HTMLElement)?.tagName === "INPUT" || !viewer.hasModel) return;
    if (k === "escape") void run(viewer, () => viewer.clearSelection());
    else if (k === "f") void run(viewer, () => viewer.fitAll());
    else if (k === "h" && hasSelection) void run(viewer, () => viewer.hideSelected());
    else if (k === "i" && hasSelection) void run(viewer, () => viewer.isolateSelected());
    else if (k === "r") void run(viewer, () => viewer.showAll());
  });

  setupDesktop(viewer);
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
