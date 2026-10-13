import type { ElementInfo, PropertyRow, PropertySet } from "../viewer/properties";

/**
 * Panel de propiedades estilo Revizto:
 * cabecera (clase, nombre, acciones) · buscador · secciones plegables
 * (Elemento, Psets de instancia, Psets de tipo, Cantidades, Atributos IFC) ·
 * clic en un valor = copiar · «Copiar todo» en formato tabla (pegable en Excel).
 */
export type PanelActions = {
  fit: () => void;
  isolate: () => void;
  hide: () => void;
  notify: (msg: string) => void;
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Estado que se conserva entre selecciones (como en Revizto)
let searchTerm = "";
const collapsed = new Set<string>(loadCollapsed());

function loadCollapsed(): string[] {
  try {
    const saved = localStorage.getItem("visor.props.collapsed");
    return saved ? JSON.parse(saved) : ["atributos"]; // Atributos IFC plegado por defecto
  } catch {
    return ["atributos"];
  }
}
function saveCollapsed() {
  try {
    localStorage.setItem("visor.props.collapsed", JSON.stringify([...collapsed]));
  } catch {}
}

type Section = { key: string; title: string; tag?: string; rows: PropertyRow[]; testid?: string };

function buildSections(info: ElementInfo): Section[] {
  const identity: PropertyRow[] = [
    { name: "Clase IFC", value: info.ifcClass ?? "—" },
    { name: "Nombre", value: info.name ?? "—" },
    { name: "GlobalId", value: info.globalId ?? "—" },
  ];
  if (info.typeName || info.typeClass)
    identity.push({ name: "Tipo", value: `${info.typeName ?? "—"}${info.typeClass ? ` (${info.typeClass})` : ""}` });
  if (info.storey)
    identity.push({
      name: "Nivel",
      value: `${info.storey.name}${info.storey.elevation != null ? ` (elev. ${info.storey.elevation.toFixed(2)} m)` : ""}`,
    });
  if (info.parent) identity.push({ name: "Pertenece a", value: `${info.parent.name ?? "—"} (${info.parent.ifcClass ?? "?"})` });
  if (info.materials.length) identity.push({ name: "Material", value: info.materials.join("; ") });
  const pick = (n: string) => info.attributes.find((a) => a.name === n);
  for (const [n, label] of [
    ["Tag", "Tag (ID de elemento)"],
    ["ObjectType", "ObjectType"],
    ["PredefinedType", "PredefinedType"],
    ["Description", "Descripción"],
  ] as const) {
    const a = pick(n);
    if (a && a.value !== "—") identity.push({ ...a, name: label });
  }

  const group = (ps: PropertySet): Section => ({
    key: `${ps.source}:${ps.kind}:${ps.name}`,
    title: ps.name,
    tag: `${ps.kind === "qto" ? "Cantidades" : "Pset"} · ${ps.source}`,
    rows: ps.properties,
  });
  const order = (a: PropertySet, b: PropertySet) =>
    (a.source === b.source ? 0 : a.source === "instancia" ? -1 : 1) || (a.kind === b.kind ? 0 : a.kind === "pset" ? -1 : 1);

  return [
    { key: "elemento", title: "Elemento", rows: identity, testid: "identity" },
    ...[...info.propertySets].sort(order).map(group),
    { key: "atributos", title: "Atributos IFC", rows: info.attributes, testid: "attributes" },
  ];
}

function rowHtml(r: PropertyRow) {
  const raw = r.raw === undefined ? r.value : typeof r.raw === "object" ? JSON.stringify(r.raw) : String(r.raw);
  return `<tr data-search="${esc(`${r.name} ${r.value}`.toLowerCase())}">
    <th title="${esc(r.name)}">${esc(r.name)}</th>
    <td data-raw="${esc(raw)}" data-copy="${esc(r.value)}" title="Clic para copiar">${esc(r.value)}</td>
  </tr>`;
}

function sectionHtml(s: Section) {
  const open = !collapsed.has(s.key);
  const body = s.rows.length ? `<table>${s.rows.map(rowHtml).join("")}</table>` : `<p class="muted small empty-sec">Sin valores.</p>`;
  return `<details class="sec" data-key="${esc(s.key)}" ${open ? "open" : ""} ${s.testid ? `data-testid="${s.testid}"` : ""}>
    <summary>${esc(s.title)}${s.tag ? ` <span class="tag">${esc(s.tag)}</span>` : ""} <span class="count">${s.rows.length}</span></summary>
    ${body}
  </details>`;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

function applySearch(root: HTMLElement) {
  const q = searchTerm.trim().toLowerCase();
  let matches = 0;
  root.querySelectorAll<HTMLDetailsElement>("details.sec").forEach((d) => {
    let visible = 0;
    d.querySelectorAll<HTMLTableRowElement>("tr").forEach((tr) => {
      const hit = !q || (tr.dataset.search ?? "").includes(q);
      tr.hidden = !hit;
      if (hit) visible++;
    });
    const titleHit = !!q && (d.querySelector("summary")?.textContent ?? "").toLowerCase().includes(q);
    if (titleHit) d.querySelectorAll<HTMLTableRowElement>("tr").forEach((tr) => (tr.hidden = false));
    d.hidden = !!q && visible === 0 && !titleHit;
    if (q && (visible || titleHit)) d.open = true;
    else if (!q) d.open = !collapsed.has(d.dataset.key ?? "");
    matches += titleHit ? d.querySelectorAll("tr").length : visible;
  });
  const counter = root.querySelector<HTMLElement>(".search-count");
  if (counter) counter.textContent = q ? `${matches} resultado${matches === 1 ? "" : "s"}` : "";
}

function asTsv(info: ElementInfo) {
  const lines = ["Sección\tPropiedad\tValor"];
  for (const s of buildSections(info)) for (const r of s.rows) lines.push(`${s.title}\t${r.name}\t${r.value}`);
  return lines.join("\n");
}

export function renderProperties(el: HTMLElement, info: ElementInfo | null, count: number, actions?: PanelActions) {
  if (!info) {
    el.className = "props is-empty";
    el.innerHTML = `<div class="props-empty">
      <p>Haz clic en un elemento del modelo para ver su información.</p>
      <p class="muted small">Esc deselecciona · F encuadra todo</p></div>`;
    return;
  }
  el.className = "props";
  const sections = buildSections(info);
  el.innerHTML = `
    <div class="props-head">
      <div class="cls-badge">${esc(info.ifcClass ?? "Elemento")}</div>
      <div class="el-name" title="${esc(info.name ?? "")}">${esc(info.name ?? "(sin nombre)")}</div>
      ${count > 1 ? `<div class="muted small">${count} elementos seleccionados; se muestra el primero.</div>` : ""}
      <div class="head-actions">
        <button data-act="fit" title="Encuadrar el elemento">Encuadrar</button>
        <button data-act="isolate" title="Ver solo este elemento (I)">Aislar</button>
        <button data-act="hide" title="Ocultar este elemento (H)">Ocultar</button>
        <button data-act="guid" title="Copiar GlobalId">Copiar GlobalId</button>
        <button data-act="all" title="Copiar todas las propiedades (se pegan en Excel)">Copiar todo</button>
      </div>
    </div>
    <div class="search-wrap">
      <input type="search" class="prop-search" placeholder="Buscar propiedad o valor…" value="${esc(searchTerm)}" aria-label="Buscar propiedad o valor" />
      <span class="search-count muted small"></span>
    </div>
    <div class="sections">${sections.map(sectionHtml).join("")}</div>`;

  const search = el.querySelector<HTMLInputElement>(".prop-search")!;
  search.addEventListener("input", () => {
    searchTerm = search.value;
    applySearch(el);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      search.value = searchTerm = "";
      applySearch(el);
      search.blur();
    }
  });
  el.querySelectorAll<HTMLDetailsElement>("details.sec").forEach((d) =>
    d.addEventListener("toggle", () => {
      if (searchTerm.trim()) return; // durante una búsqueda no se recuerda el plegado
      const k = d.dataset.key ?? "";
      if (d.open) collapsed.delete(k);
      else collapsed.add(k);
      saveCollapsed();
    }),
  );
  el.querySelector(".sections")!.addEventListener("click", async (e) => {
    const td = (e.target as HTMLElement).closest<HTMLTableCellElement>("td[data-copy]");
    if (!td) return;
    const name = td.parentElement?.querySelector("th")?.textContent ?? "";
    if (await copyText(td.dataset.copy ?? "")) {
      td.classList.add("copied");
      setTimeout(() => td.classList.remove("copied"), 700);
      actions?.notify(`Copiado: ${name}`);
    }
  });
  el.querySelector(".head-actions")!.addEventListener("click", async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.act;
    if (!act || !actions) return;
    if (act === "fit") actions.fit();
    else if (act === "isolate") actions.isolate();
    else if (act === "hide") actions.hide();
    else if (act === "guid" && info.globalId && (await copyText(info.globalId))) actions.notify("GlobalId copiado");
    else if (act === "all" && (await copyText(asTsv(info)))) actions.notify("Propiedades copiadas (pégalas en Excel)");
  });
  applySearch(el);
}
