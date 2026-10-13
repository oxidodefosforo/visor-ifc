import { PRESETS, configFromPreset, type MatConfig } from "../render/materials";
import { textureThumb, type TextureKey } from "../render/textures";

/** Utilidades de interfaz compartidas: escape HTML, muestras de material y rejilla de acabados. */
export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const thumbs = new Map<string, string>();
export function thumb(key: TextureKey) {
  let t = thumbs.get(key);
  if (!t) thumbs.set(key, (t = textureThumb(key, 48)));
  return t;
}

export function swatch(cfg: MatConfig | null, customTextures: Record<string, string>, cls = "sw") {
  if (!cfg) return `<span class="${cls} sw-ifc" title="Color del IFC"></span>`;
  const tex = cfg.texture;
  const img = tex ? (tex.startsWith("custom:") ? customTextures[tex.slice(7)] : thumb(tex as TextureKey)) : null;
  const bg = img ? `background-image:url(${img});background-size:cover;` : "";
  return `<span class="${cls}" style="${bg}background-color:${esc(cfg.color)};${img ? "background-blend-mode:multiply;" : ""}${cfg.opacity < 1 ? "opacity:.6;" : ""}"></span>`;
}

/**
 * Rejilla de acabados (botones con miniatura), agrupados como en PRESETS.
 * Sustituye al desplegable nativo: la lista del sistema se cerraba sola al redibujar el panel.
 * `noneLabel` añade la opción de quitar la asignación (data-preset="").
 */
export function presetGridHtml(current: string | null, noneLabel: string | null) {
  const groups = [...new Set(PRESETS.map((p) => p.group))];
  const none = noneLabel
    ? `<button type="button" class="pg-item pg-none ${!current ? "active" : ""}" data-preset="">${swatch(null, {}, "pg-sw")}<span>${esc(noneLabel)}</span></button>`
    : "";
  return `<div class="preset-grid">${none}${groups
    .map(
      (g) => `<div class="pg-group">${esc(g)}</div>${PRESETS.filter((p) => p.group === g)
        .map(
          (p) =>
            `<button type="button" class="pg-item ${p.preset === current ? "active" : ""}" data-preset="${p.preset}" title="${esc(p.name)}">${swatch(configFromPreset(p.preset), {}, "pg-sw")}<span>${esc(p.name)}</span></button>`,
        )
        .join("")}`,
    )
    .join("")}</div>`;
}

/**
 * Ventana flotante única (menú contextual y selector de acabados). Se cierra con Esc,
 * clic fuera o al abrir otra. No usa controles nativos del sistema.
 */
export class Popover {
  readonly el: HTMLDivElement;
  private ac: AbortController | null = null;
  onClose: (() => void) | null = null;

  constructor(className: string) {
    this.el = document.createElement("div");
    this.el.className = `popover ${className}`;
    this.el.hidden = true;
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
    document.body.append(this.el);
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open(html: string, x: number, y: number) {
    this.el.innerHTML = html;
    this.el.hidden = false;
    this.place(x, y);
    this.ac?.abort();
    this.ac = new AbortController();
    const o = { signal: this.ac.signal, capture: true };
    // En el siguiente ciclo, para que el propio clic que abre no lo cierre.
    setTimeout(() => {
      if (!this.ac || this.ac.signal.aborted) return;
      window.addEventListener("pointerdown", (e) => { if (!this.el.contains(e.target as Node)) this.close(); }, o);
      window.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); this.close(); } }, o);
      window.addEventListener("resize", () => this.close(), o);
    }, 0);
  }

  /** Recoloca dentro de la ventana (también tras cambiar el contenido). */
  place(x: number, y: number) {
    const r = this.el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  close() {
    if (this.el.hidden) return;
    this.ac?.abort();
    this.ac = null;
    this.el.hidden = true;
    this.el.innerHTML = "";
    this.onClose?.();
  }

  dispose() {
    this.close();
    this.el.remove();
  }
}
