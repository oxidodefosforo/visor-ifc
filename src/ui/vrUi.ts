import type { Viewer } from "../viewer/Viewer";
import type { EnvSettings } from "../render/Environment";
import type { Profile } from "../render/Appearance";
import { esc } from "./swatch";

/**
 * Botón «VR» y página de sesión VR.
 * - Navegador con gafas (Chrome/Edge + Quest Link): entra en VR directamente.
 * - App de escritorio (Electron, sin WebXR): envía el modelo ya convertido (Fragments), materiales,
 *   entorno, cámara y elementos ocultos a un servidor local y abre Chrome/Edge en esa sesión.
 * - Sin gafas: explica qué hace falta.
 */
export type VrSession = {
  name: string;
  realistic: boolean;
  profile: Profile;
  env: EnvSettings;
  camera: { pos: number[]; target: number[] };
  hidden: number[];
};

type DesktopVR = {
  openVR?: (p: { model: ArrayBuffer; session: VrSession }) => Promise<{ url: string; browser: string }>;
  openUrl?: (url: string) => Promise<unknown>;
};

const REQUIREMENTS = `<ol class="steps">
  <li>Conecta las <b>Meta Quest</b> al PC con <b>Link</b> (cable) o <b>Air Link</b> y abre la app <b>Meta Quest Link</b> en el PC.</li>
  <li>En la app Meta Quest Link: <b>Configuración → General → Tiempo de ejecución de OpenXR → «Usar Meta Quest Link»</b> (solo la primera vez).</li>
  <li>Usa <b>Google Chrome</b> o <b>Microsoft Edge</b> (Firefox no tiene WebXR).</li>
</ol>`;

const CONTROLS = `<table class="vr-controls">
  <tr><th>Joystick izquierdo</th><td>Andar (hacia donde miras)</td></tr>
  <tr><th>Joystick derecho ← →</th><td>Girar 30°</td></tr>
  <tr><th>Joystick derecho ↑ ↓</th><td>Subir / bajar</td></tr>
  <tr><th>Gatillo</th><td>Apuntar y soltar: teletransporte al punto</td></tr>
  <tr><th>Botón lateral (grip)</th><td>Mantener: 4× más rápido</td></tr>
  <tr><th>Botón Meta / quitarse las gafas</th><td>Salir de VR</td></tr>
</table>`;

export class VrUi {
  constructor(
    private viewer: Viewer,
    private btn: HTMLButtonElement,
    private modal: HTMLElement,
    private card: HTMLElement,
    private notify: (msg: string, kind?: "info" | "error") => void,
    private setRealistic: (on: boolean) => Promise<void>,
  ) {
    btn.addEventListener("click", () => void this.onClick());
    modal.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t === modal || t.closest("[data-close]")) this.close();
      if (t.closest("[data-enter-vr]")) void this.enter();
      const copy = t.closest<HTMLElement>("[data-copy]");
      if (copy) void navigator.clipboard?.writeText(copy.dataset.copy!).then(() => this.notify("Enlace copiado.", "info"));
      const open = t.closest<HTMLElement>("[data-open]");
      if (open) void this.desktop?.openUrl?.(open.dataset.open!);
    });
    viewer.vr.onStateChange = (s) => {
      this.btn.classList.toggle("ready", s === "available");
      this.btn.classList.toggle("active", s === "active");
      document.body.dataset.vr = s;
      if (s === "active") this.close();
    };
    void viewer.vr.detect();
  }

  private get desktop(): DesktopVR | undefined {
    return (window as unknown as { visorDesktop?: DesktopVR }).visorDesktop;
  }

  refresh(hasModel: boolean, busy: boolean) {
    this.btn.disabled = !hasModel || busy;
  }

  show(html: string) {
    this.card.innerHTML = `<button class="modal-x" data-close aria-label="Cerrar">×</button>${html}`;
    this.modal.hidden = false;
  }

  close() {
    this.modal.hidden = true;
    this.card.innerHTML = "";
  }

  private async onClick() {
    const vr = this.viewer.vr;
    if (vr.active) return void vr.exit();
    if (await vr.detect()) return void this.enter();
    const desktop = this.desktop;
    if (desktop?.openVR) return void this.handoff(desktop);
    this.show(`<h3>Ver en gafas VR</h3>
      <p>Este navegador no detecta unas gafas de realidad virtual.</p>
      ${REQUIREMENTS}
      <p class="muted small">Con todo listo, recarga la página y pulsa <b>VR</b> otra vez.</p>
      <h4>Controles en VR</h4>${CONTROLS}`);
  }

  private async enter() {
    try {
      if (!this.viewer.appearance.realistic && document.body.dataset.vrRealistic !== "false") await this.setRealistic(true);
      await this.viewer.vr.enter();
    } catch (err) {
      console.error(err);
      this.notify(`No se pudo entrar en VR: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  /** App de escritorio: pasa el modelo al navegador (Chrome/Edge) que sí tiene WebXR. */
  private async handoff(desktop: DesktopVR) {
    this.show(`<h3>Preparando la vista VR…</h3><p class="muted">Copiando el modelo y sus materiales.</p>`);
    try {
      const model = await this.viewer.modelBuffer();
      if (!model) throw new Error("No hay ningún modelo abierto.");
      const session = await this.sessionData();
      const { url, browser } = await desktop.openVR!({ model, session });
      this.show(`<h3>Vista VR abierta en ${esc(browser)}</h3>
        <p>La aplicación de escritorio no puede hablar con las gafas, así que el modelo se ha abierto en el navegador
        (en este mismo PC, sin subir nada a internet), con sus materiales, el entorno y la vista actual.</p>
        <p><b>Ponte las gafas y pulsa «Entrar en VR»</b> en la ventana del navegador.</p>
        ${REQUIREMENTS}
        <div class="modal-actions"><button data-open="${esc(url)}">Abrir otra vez</button><button data-copy="${esc(url)}">Copiar enlace</button><button class="primary" data-close>Entendido</button></div>
        <h4>Controles en VR</h4>${CONTROLS}`);
    } catch (err) {
      console.error(err);
      this.close();
      this.notify(`No se pudo abrir la vista VR: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }

  async sessionData(): Promise<VrSession> {
    const v = this.viewer;
    return {
      name: document.getElementById("model-name")?.textContent || "modelo",
      realistic: v.appearance.realistic,
      profile: v.appearance.profile,
      env: { ...v.env.settings },
      camera: v.cameraPose(),
      hidden: await v.hiddenLocalIds(),
    };
  }

  /** Página abierta por la app de escritorio: ?vr=<token>. Carga la sesión y ofrece entrar en VR. */
  static token() {
    return new URLSearchParams(location.search).get("vr");
  }

  async openSession(token: string, onLoaded: (name: string) => void) {
    this.show(`<h3>Cargando la vista VR…</h3><p class="muted vr-step">Recibiendo el modelo desde el Visor IFC.</p>`);
    const step = (msg: string) => {
      document.body.dataset.vrStep = msg;
      const el = this.card.querySelector(".vr-step");
      if (el) el.textContent = msg;
    };
    const base = `/vr/${encodeURIComponent(token)}`;
    const [sRes, mRes] = await Promise.all([fetch(`${base}/session.json`), fetch(`${base}/model.frag`)]);
    if (!sRes.ok || !mRes.ok) throw new Error(sRes.ok ? await mRes.text() : await sRes.text());
    const session = (await sRes.json()) as VrSession;
    const buffer = await mRes.arrayBuffer();
    const v = this.viewer;
    step(`Abriendo el modelo (${(buffer.byteLength / 1048576).toFixed(1)} MB)…`);
    await v.loadFragments(buffer, session.name);
    onLoaded(session.name);
    step("Aplicando materiales y entorno…");
    v.updateEnvironment(session.env);
    await v.appearance.replaceProfile(session.profile);
    document.body.dataset.vrRealistic = String(session.realistic);
    if (session.realistic) await this.setRealistic(true);
    step("Colocando la vista…");
    if (session.hidden.length) await v.hideLocalIds(session.hidden);
    await v.setCameraPose(session.camera);
    step("Buscando las gafas…");
    const ok = await v.vr.detect();
    this.show(`<h3>Visor IFC · VR</h3>
      <p><b>${esc(session.name)}</b> listo, con sus materiales y la vista que tenías.</p>
      ${ok ? `<button class="primary big" data-enter-vr>Entrar en VR</button>` : `<p class="warn">Este navegador no detecta las gafas.</p>${REQUIREMENTS}<p class="muted small">Con todo listo, recarga esta página.</p>`}
      <h4>Controles en VR</h4>${CONTROLS}`);
  }
}
