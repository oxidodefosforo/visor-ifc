import type { ElementInfo, PropertyRow } from "../viewer/properties";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function rows(list: PropertyRow[]) {
  if (list.length === 0) return `<p class="muted small">Sin valores.</p>`;
  return `<table>${list
    .map((r) => `<tr><th>${esc(r.name)}</th><td>${esc(r.value)}</td></tr>`)
    .join("")}</table>`;
}

export function renderProperties(el: HTMLElement, info: ElementInfo | null, count: number) {
  if (!info) {
    el.className = "props muted";
    el.textContent = "Selecciona un elemento del modelo.";
    return;
  }
  el.className = "props";
  const extra = count > 1 ? `<p class="muted small">${count} elementos seleccionados; se muestra el primero.</p>` : "";
  const header = rows([
    { name: "GlobalId", value: info.globalId ?? "—" },
    { name: "Clase IFC", value: info.ifcClass ?? "—" },
    { name: "Nombre", value: info.name ?? "—" },
    ...(info.typeName || info.typeClass
      ? [{ name: "Tipo", value: `${info.typeName ?? "—"}${info.typeClass ? ` (${info.typeClass})` : ""}` }]
      : []),
    ...(info.materials.length ? [{ name: "Material", value: info.materials.join("; ") }] : []),
  ]);

  const psets = info.propertySets.length
    ? info.propertySets
        .map(
          (ps) => `<details open>
            <summary>${esc(ps.name)} <span class="tag">${ps.kind === "qto" ? "Cantidades" : "Pset"} · ${ps.source}</span></summary>
            ${rows(ps.properties)}
          </details>`,
        )
        .join("")
    : `<p class="muted small">Este elemento no tiene conjuntos de propiedades en el IFC.</p>`;

  el.innerHTML = `${extra}
    <section data-testid="identity">${header}</section>
    <h3>Conjuntos de propiedades (${info.propertySets.length})</h3>
    <div data-testid="psets">${psets}</div>
    <details><summary>Atributos IFC (${info.attributes.length})</summary>${rows(info.attributes)}</details>`;
}
