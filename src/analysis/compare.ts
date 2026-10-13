import type * as FRAGS from "@thatopen/fragments";
import { parseItemData, prettyClass } from "../viewer/properties";
import { ELEMENT_DATA_CONFIG } from "../viewer/Viewer";

/**
 * Comparación de dos versiones de un modelo IFC por GlobalId.
 *  - Nuevos: GlobalId solo en la versión nueva.
 *  - Eliminados: solo en la versión anterior.
 *  - Modificados: en ambas, con cambios de geometría (caja envolvente, ±1 mm), de atributos
 *    (nombre, tipo, etiqueta…) o de propiedades/cantidades (se listan los cambios).
 */
export type ElementSig = {
  localId: number;
  guid: string;
  ifcClass: string;
  name: string;
  box: number[]; // min xyz, max xyz (m)
  props: Map<string, string>;
};

export type Change = { what: string; before: string; after: string };
export type CompareResult = {
  added: ElementSig[]; // en la nueva
  removed: ElementSig[]; // en la anterior
  modified: { before: ElementSig; after: ElementSig; changes: Change[]; geometry: boolean }[];
  unchanged: number;
  /** Desplazamiento global detectado entre versiones (m, ejes del visor). */
  offset: number[];
};

const ATTRS = ["Name", "ObjectType", "Description", "Tag", "PredefinedType", "LongName"];

export async function readSignatures(model: FRAGS.FragmentsModel, onProgress?: (d: number, t: number) => void) {
  const ids = await model.getItemsIdsWithGeometry();
  const [guids, boxes] = await Promise.all([model.getGuidsByLocalIds(ids), model.getBoxes(ids)]);
  const out = new Map<string, ElementSig>();
  const CH = 400;
  for (let i = 0; i < ids.length; i += CH) {
    const chunk = ids.slice(i, i + CH);
    const data = await model.getItemsData(chunk, ELEMENT_DATA_CONFIG);
    chunk.forEach((id, k) => {
      const guid = guids[i + k];
      if (!guid) return;
      const info = parseItemData(data[k] ?? {}, { localId: id, guid }, {});
      const props = new Map<string, string>();
      for (const a of info.attributes) if (ATTRS.includes(a.name)) props.set(`Atributo · ${a.name}`, String(a.raw ?? a.value));
      if (info.typeName) props.set("Tipo", info.typeName);
      if (info.materials.length) props.set("Material", info.materials.join(", "));
      for (const ps of info.propertySets) for (const p of ps.properties) props.set(`${ps.name} · ${p.name}`, String(p.raw ?? p.value));
      const b = boxes[i + k];
      out.set(guid, {
        localId: id,
        guid,
        ifcClass: prettyClass(info.ifcClass) ?? "—",
        name: info.name ?? "",
        box: b && !b.isEmpty() ? [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z] : [],
        props,
      });
    });
    onProgress?.(Math.min(ids.length, i + CH), ids.length);
  }
  return out;
}

/**
 * Desplazamiento global entre versiones: el más repetido entre los elementos comunes (moda, al mm).
 * Así un cambio de coordenadas compartidas / punto base, o la coordinación entre modelos que aplica
 * Fragments al cargar (comprobado: según el orden de carga, la caja de la otra versión podía llegar
 * desplazada en bloque), no marca todo el modelo como modificado.
 */
function globalOffset(before: Map<string, ElementSig>, after: Map<string, ElementSig>) {
  const votes = new Map<string, { n: number; d: number[] }>();
  for (const [guid, b] of before) {
    const a = after.get(guid);
    if (!a || a.box.length !== 6 || b.box.length !== 6) continue;
    const d = [a.box[0] - b.box[0], a.box[1] - b.box[1], a.box[2] - b.box[2]];
    const k = d.map((x) => Math.round(x * 1000)).join(",");
    const v = votes.get(k) ?? { n: 0, d };
    v.n++;
    votes.set(k, v);
  }
  let best: { n: number; d: number[] } = { n: 0, d: [0, 0, 0] };
  for (const v of votes.values()) if (v.n > best.n) best = v;
  return best.d;
}

export function compareSignatures(before: Map<string, ElementSig>, after: Map<string, ElementSig>, tolM = 0.001): CompareResult {
  const off = globalOffset(before, after);
  const res: CompareResult = { added: [], removed: [], modified: [], unchanged: 0, offset: off };
  for (const [guid, a] of after) if (!before.has(guid)) res.added.push(a);
  for (const [guid, b] of before) {
    const a = after.get(guid);
    if (!a) {
      res.removed.push(b);
      continue;
    }
    const changes: Change[] = [];
    let geometry = false;
    if (b.ifcClass !== a.ifcClass) changes.push({ what: "Clase IFC", before: b.ifcClass, after: a.ifcClass });
    if (b.box.length !== a.box.length || b.box.some((v, i) => Math.abs(v + off[i % 3] - a.box[i]) > tolM)) {
      geometry = true;
      if (b.box.length === 6 && a.box.length === 6) {
        // En el sistema de la versión anterior (sin el desplazamiento global)
        const c = (x: number[], i: number) => (x[i] + x[i + 3]) / 2;
        const mv = [0, 1, 2].map((i) => c(a.box, i) - off[i] - c(b.box, i));
        const sb = [0, 1, 2].map((i) => b.box[i + 3] - b.box[i]), sa = [0, 1, 2].map((i) => a.box[i + 3] - a.box[i]);
        // Ejes del visor (Y arriba) → ejes del proyecto IFC (Z arriba): X = x, Y = −z, Z = y
        const ifc = (v: number[]) => [v[0], -v[2], v[1]];
        const m = ifc(mv), s1 = ifc(sb).map(Math.abs), s2 = ifc(sa).map(Math.abs);
        if (Math.hypot(...m) > tolM) changes.push({ what: "Posición (desplazamiento X, Y, Z)", before: "—", after: m.map((v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)} m`).join(", ") });
        if (s1.some((v, i) => Math.abs(v - s2[i]) > tolM)) changes.push({ what: "Dimensiones (X × Y × Z)", before: s1.map((v) => v.toFixed(3)).join(" × ") + " m", after: s2.map((v) => v.toFixed(3)).join(" × ") + " m" });
      } else changes.push({ what: "Geometría", before: b.box.length ? "con geometría" : "sin geometría", after: a.box.length ? "con geometría" : "sin geometría" });
    }
    const keys = new Set([...b.props.keys(), ...a.props.keys()]);
    for (const k of keys) {
      const x = b.props.get(k), y = a.props.get(k);
      if (x === y) continue;
      if (x !== undefined && y !== undefined && !isNaN(Number(x)) && !isNaN(Number(y)) && Math.abs(Number(x) - Number(y)) <= 1e-9 * Math.max(1, Math.abs(Number(x)))) continue;
      changes.push({ what: k, before: x ?? "—", after: y ?? "—" });
    }
    if (changes.length) res.modified.push({ before: b, after: a, changes, geometry });
    else res.unchanged++;
  }
  return res;
}
