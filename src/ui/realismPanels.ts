import type { Viewer } from "../viewer/Viewer";
import { PRESETS, configFromPreset, presetByKey, type MatConfig } from "../render/materials";
import { TEXTURE_KEYS, textureThumb, imageFileToDataUrl, type TextureKey } from "../render/textures";

/**
 * Pestañas «Materiales» y «Entorno» del panel derecho.
 * Materiales: lista de materiales IFC del modelo (con nº de elementos), preset por
 * material, editor (color, rugosidad, metal, opacidad, escala, textura o imagen propia),
 * asignación a la selección, auto-asignación y perfil exportable.
 */
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const TEX_NAMES: Record<TextureKey, string> = {
  concrete: "Hormigón", formwork: "Encofrado", brick: "Ladrillo", block: "Bloque", plaster: "Enlucido",
  wood: "Madera", parquet: "Parquet", tiles: "Cerámico", stone: "Piedra", brushed: "Metal cepillado",
  asphalt: "Asfalto", grass: "Césped", gravel: "Grava",
};

const thumbs = new Map<string, string>();
function thumb(key: TextureKey) {
  let t = thumbs.get(key);
  if (!t) thumbs.set(key, (t = textureThumb(key, 48)));
  return t;
}

function swatch(cfg: MatConfig | null, customTextures: Record<string, string>) {
  if (!cfg) return `<span class="sw sw-ifc" title="Color del IFC"></span>`;
  const tex = cfg.texture;
  const img = tex ? (tex.startsWith("custom:") ? customTextures[tex.slice(7)] : thumb(tex as TextureKey)) : null;
  const bg = img ? `background-image:url(${img});background-size:cover;` : "";
  return `<span class="sw" style="${bg}background-color:${esc(cfg.color)};${img ? "background-blend-mode:multiply;" : ""}${cfg.opacity < 1 ? "opacity:.6;" : ""}"></span>`;
}

function presetOptions(selected: string | null, includeIfc: boolean) {
  const groups = [...new Set(PRESETS.map((p) => p.group))];
  return (
    (includeIfc ? `<option value="" ${!selected ? "selected" : ""}>— Color del IFC —</option>` : "") +
    groups
      .map(
        (g) =>
          `<optgroup label="${esc(g)}">${PRESETS.filter((p) => p.group === g)
            .map((p) => `<option value="${p.preset}" ${p.preset === selected ? "selected" : ""}>${esc(p.name)}</option>`)
            .join("")}</optgroup>`,
      )
      .join("")
  );
}

export class RealismPanels {
  private expanded: string | null = null;
  private debounce = 0;

  constructor(
    private viewer: Viewer,
    private matEl: HTMLElement,
    private envEl: HTMLElement,
    private notify: (msg: string, kind?: "info" | "error") => void,
    private setRealistic: (on: boolean) => Promise<void>,
  ) {
    viewer.appearance.onChange = () => this.renderMaterials();
    this.matEl.addEventListener("click", (e) => void this.onMatClick(e));
    this.matEl.addEventListener("change", (e) => void this.onMatChange(e));
    this.matEl.addEventListener("input", (e) => this.onMatInput(e));
    this.envEl.addEventListener("input", (e) => this.onEnvInput(e));
    this.envEl.addEventListener("change", (e) => this.onEnvInput(e));
    this.renderEnv();
  }

  // ---------------- Materiales ----------------

  /** Refresca la lista (no interrumpe si el usuario está arrastrando un control). */
  renderMaterials() {
    const active = document.activeElement as HTMLInputElement | null;
    if (active && this.matEl.contains(active) && active.type === "range") return;
    const a = this.viewer.appearance;
    const tex = a.profile.customTextures;
    const sel = this.viewer.selectedLocalIds();
    const hasModel = this.viewer.hasModel;
    if (!hasModel) {
      this.matEl.innerHTML = `<div class="props-empty"><p>Abre un modelo para asignar materiales.</p></div>`;
      return;
    }
    const realisticNote = a.realistic
      ? ""
      : `<div class="note">Los materiales y texturas se ven en <strong>Vista realista</strong>.
          <button data-act="realistic" class="primary small">Activar vista realista</button></div>`;
    const selCfg = sel.length ? a.elementConfig(sel[0]) : null;
    const selBox = sel.length
      ? `<div class="sel-box" data-testid="sel-box">
          <div class="sel-title">Selección: ${sel.length} elemento${sel.length > 1 ? "s" : ""}</div>
          <div class="row">
            <select data-role="sel-preset" aria-label="Material para la selección">${presetOptions(selCfg?.preset ?? null, false)}</select>
            <button data-act="sel-apply">Aplicar</button>
            ${selCfg ? `<button data-act="sel-clear" title="Volver al material de su grupo">Quitar</button>` : ""}
          </div>
        </div>`
      : `<p class="muted small">Selecciona elementos en el modelo para asignarles un material concreto.</p>`;

    const groups = a.groups;
    const list = groups.length
      ? groups
          .map((g) => {
            const cfg = a.configForMaterial(g.name);
            const open = this.expanded === g.name;
            return `<div class="mat ${open ? "open" : ""}" data-name="${esc(g.name)}">
              <div class="mat-row" data-act="toggle" title="Editar">
                ${swatch(cfg, tex)}
                <span class="mat-name" title="${esc(g.name)}">${esc(g.name)}</span>
                <span class="count">${g.localIds.length}</span>
              </div>
              <div class="mat-preset">
                <select data-role="preset" aria-label="Material para ${esc(g.name)}">${presetOptions(cfg?.preset ?? null, true)}</select>
                <button data-act="select-group" class="ghost small" title="Seleccionar estos elementos en el modelo">Ver</button>
              </div>
              ${open && cfg ? this.editorHtml(cfg, tex) : ""}
            </div>`;
          })
          .join("")
      : `<p class="muted small">Analizando materiales del modelo…</p>`;

    this.matEl.innerHTML = `${realisticNote}
      <div class="mat-actions">
        <button data-act="auto" title="Asigna materiales según el nombre (hormigón, acero, vidrio, ladrillo…)">Asignar automáticamente</button>
        <button data-act="export" title="Guardar el perfil de materiales para reutilizarlo en otros proyectos">Exportar perfil</button>
        <button data-act="import">Importar perfil</button>
        <button data-act="reset" class="ghost">Restablecer</button>
        <input type="file" accept=".json,application/json" data-role="import-file" hidden />
        <input type="file" accept="image/*" data-role="tex-file" hidden />
      </div>
      ${selBox}
      <h3>Materiales del modelo (${groups.length})</h3>
      <div class="mat-list" data-testid="mat-list">${list}</div>`;
  }

  private editorHtml(cfg: MatConfig, customTextures: Record<string, string>) {
    const texOptions =
      `<option value="" ${!cfg.texture ? "selected" : ""}>Sin textura (color liso)</option>` +
      TEXTURE_KEYS.map((k) => `<option value="${k}" ${cfg.texture === k ? "selected" : ""}>${TEX_NAMES[k]}</option>`).join("") +
      Object.keys(customTextures)
        .map((id, i) => `<option value="custom:${id}" ${cfg.texture === `custom:${id}` ? "selected" : ""}>Imagen propia ${i + 1}</option>`)
        .join("") +
      `<option value="__upload">Cargar imagen…</option>`;
    const range = (key: keyof MatConfig, label: string, min: number, max: number, step: number) =>
      `<label class="ed-row"><span>${label}</span><input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${cfg[key]}"/><output>${cfg[key]}</output></label>`;
    return `<div class="editor">
      <label class="ed-row"><span>Textura</span><select data-key="texture">${texOptions}</select></label>
      <label class="ed-row"><span>Color / tinte</span><input type="color" data-key="color" value="${esc(cfg.color)}"/></label>
      ${range("scale", "Escala (m)", 0.1, 6, 0.1)}
      ${range("roughness", "Rugosidad", 0, 1, 0.01)}
      ${range("metalness", "Metálico", 0, 1, 0.01)}
      ${range("opacity", "Opacidad", 0.05, 1, 0.01)}
      <div class="ed-foot"><span class="muted small">Basado en: ${esc(presetByKey(cfg.preset)?.name ?? cfg.preset)}</span>
        <button data-act="reset-preset" class="ghost small">Valores del preset</button></div>
    </div>`;
  }

  private groupName(e: Event) {
    return (e.target as HTMLElement).closest<HTMLElement>(".mat")?.dataset.name ?? null;
  }

  private async onMatClick(e: Event) {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!btn) return;
    const a = this.viewer.appearance;
    const act = btn.dataset.act;
    const name = this.groupName(e);
    try {
      if (act === "realistic") await this.setRealistic(true);
      else if (act === "toggle" && name) {
        this.expanded = this.expanded === name ? null : name;
        if (this.expanded && !a.configForMaterial(name)) this.notify("Elige primero un material en el desplegable para poder editarlo.", "info");
        this.renderMaterials();
      } else if (act === "select-group" && name) {
        const g = a.groups.find((x) => x.name === name);
        if (g) await this.viewer.selectLocalIds(g.localIds);
      } else if (act === "auto") {
        const n = await a.autoAssign();
        this.notify(n ? `${n} material${n > 1 ? "es" : ""} asignado${n > 1 ? "s" : ""} por su nombre.` : "No se reconoció ningún material nuevo por su nombre.", "info");
        if (!a.realistic) await this.setRealistic(true);
      } else if (act === "export") {
        const blob = new Blob([a.exportProfile()], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = Object.assign(document.createElement("a"), { href: url, download: "perfil-materiales-visor-ifc.json" });
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else if (act === "import") {
        this.matEl.querySelector<HTMLInputElement>('[data-role="import-file"]')!.click();
      } else if (act === "reset") {
        if (confirm("¿Quitar todas las asignaciones de materiales de este equipo?")) await a.clearProfile();
      } else if (act === "reset-preset" && name) {
        const cfg = a.configForMaterial(name);
        if (cfg) await a.setMaterialConfig(name, configFromPreset(cfg.preset));
        this.renderMaterials();
      } else if (act === "sel-apply") {
        const key = this.matEl.querySelector<HTMLSelectElement>('[data-role="sel-preset"]')!.value;
        await a.setElementConfig(this.viewer.selectedLocalIds(), configFromPreset(key));
        if (!a.realistic) await this.setRealistic(true);
        this.notify("Material asignado. Se quita la selección para que veas el resultado.", "info");
      } else if (act === "sel-clear") {
        await a.setElementConfig(this.viewer.selectedLocalIds(), null);
      }
    } catch (err) {
      console.error(err);
      this.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  private async onMatChange(e: Event) {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const a = this.viewer.appearance;
    const name = this.groupName(e);
    try {
      if (t.dataset.role === "preset" && name) {
        await a.setMaterialConfig(name, t.value ? configFromPreset(t.value) : null);
        if (t.value && !a.realistic) await this.setRealistic(true);
        this.renderMaterials();
      } else if (t.dataset.role === "import-file") {
        const f = (t as HTMLInputElement).files?.[0];
        (t as HTMLInputElement).value = "";
        if (f) {
          await a.importProfile(await f.text());
          this.notify("Perfil de materiales importado.", "info");
        }
      } else if (t.dataset.role === "tex-file") {
        const f = (t as HTMLInputElement).files?.[0];
        (t as HTMLInputElement).value = "";
        const target = this.expanded;
        if (f && target) {
          const id = a.addCustomTexture(await imageFileToDataUrl(f));
          const cfg = a.configForMaterial(target);
          if (cfg) await a.setMaterialConfig(target, { ...cfg, texture: `custom:${id}`, color: "#ffffff" });
          this.renderMaterials();
        }
      } else if (t.dataset.key === "texture" && name) {
        if (t.value === "__upload") {
          this.matEl.querySelector<HTMLInputElement>('[data-role="tex-file"]')!.click();
          this.renderMaterials(); // restablece el desplegable
          return;
        }
        const cfg = a.configForMaterial(name);
        if (cfg) await a.setMaterialConfig(name, { ...cfg, texture: (t.value || null) as MatConfig["texture"] });
        this.renderMaterials();
      } else if (t.dataset.key && name && t.type !== "range") {
        this.applyEdit(name, t.dataset.key as keyof MatConfig, t.value);
        this.renderMaterials();
      }
    } catch (err) {
      console.error(err);
      this.notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  /** Deslizadores y color: cambio en vivo (sin reconstruir el panel). */
  private onMatInput(e: Event) {
    const t = e.target as HTMLInputElement;
    const name = this.groupName(e);
    if (!name || !t.dataset.key || (t.type !== "range" && t.type !== "color")) return;
    const out = t.parentElement?.querySelector("output");
    if (out) out.textContent = t.value;
    this.applyEdit(name, t.dataset.key as keyof MatConfig, t.value);
  }

  private applyEdit(name: string, key: keyof MatConfig, raw: string) {
    const a = this.viewer.appearance;
    const cfg = a.configForMaterial(name);
    if (!cfg) return;
    const value = key === "color" ? raw : Number(raw);
    const next = { ...cfg, [key]: value } as MatConfig;
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => {
      void a.setMaterialConfig(name, next).then(() => {
        const sw = this.matEl.querySelector<HTMLElement>(`.mat[data-name="${CSS.escape(name)}"] .sw`);
        if (sw) sw.outerHTML = swatch(next, a.profile.customTextures);
      });
    }, 60);
  }

  // ---------------- Entorno ----------------

  renderEnv() {
    const s = this.viewer.env.settings;
    const hh = (h: number) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
    this.envEl.innerHTML = `
      <p class="muted small">Ajustes de la <strong>Vista realista</strong>: cielo físico, sol con sombras y mapeo de tonos.</p>
      <label class="ed-row"><span>Hora del día</span><input type="range" data-env="hour" min="6" max="20" step="0.25" value="${s.hour}"/><output>${hh(s.hour)}</output></label>
      <label class="ed-row"><span>Orientación del sol</span><input type="range" data-env="azimuth" min="0" max="360" step="5" value="${s.azimuth}"/><output>${s.azimuth}°</output></label>
      <label class="ed-row"><span>Exposición</span><input type="range" data-env="exposure" min="0.3" max="2.5" step="0.05" value="${s.exposure}"/><output>${s.exposure}</output></label>
      <label class="ed-row"><span>Sombras</span><input type="checkbox" data-env="shadows" ${s.shadows ? "checked" : ""}/></label>
      <label class="ed-row"><span>Suelo</span><select data-env="ground">
        <option value="neutral" ${s.ground === "neutral" ? "selected" : ""}>Neutro</option>
        <option value="grass" ${s.ground === "grass" ? "selected" : ""}>Césped</option>
        <option value="none" ${s.ground === "none" ? "selected" : ""}>Sin suelo</option></select></label>
      <p class="muted small">La orientación es relativa a los ejes del modelo (0° = −Z / «norte» del proyecto).</p>`;
  }

  private onEnvInput(e: Event) {
    const t = e.target as HTMLInputElement;
    const key = t.dataset.env;
    if (!key) return;
    const value = t.type === "checkbox" ? t.checked : t.tagName === "SELECT" ? t.value : Number(t.value);
    const out = t.parentElement?.querySelector("output");
    if (out) {
      const v = Number(t.value);
      out.textContent = key === "hour" ? `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}` : key === "azimuth" ? `${v}°` : String(v);
    }
    this.viewer.updateEnvironment({ [key]: value });
  }
}
