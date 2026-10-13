import * as THREE from "three";
import type * as FRAGS from "@thatopen/fragments";
import { prettyClass } from "../viewer/properties";

/**
 * Índice de los elementos con geometría de un modelo, compartido por las herramientas de análisis
 * (interferencias, comparación, 4D, planta 2D): clase IFC, nombre, GlobalId, nivel y caja envolvente.
 * Se construye una vez por modelo y bajo demanda.
 */
export type ElementRecord = {
  localId: number;
  guid: string;
  ifcClass: string; // «IfcBeam»
  name: string;
  storey: string | null;
  box: THREE.Box3;
};

export type Storey = { localId: number; name: string; elevation: number };

export class ModelIndex {
  elements = new Map<number, ElementRecord>();
  storeys: Storey[] = [];
  private constructor(readonly model: FRAGS.FragmentsModel) {}

  static async build(model: FRAGS.FragmentsModel) {
    const idx = new ModelIndex(model);
    const ids = await model.getItemsIdsWithGeometry();
    const [guids, boxes, cats] = await Promise.all([
      model.getGuidsByLocalIds(ids),
      model.getBoxes(ids),
      model.getItemsOfCategories([/.*/]),
    ]);
    const clsOf = new Map<number, string>();
    for (const [cat, list] of Object.entries(cats)) for (const id of list) clsOf.set(id, cat);

    // Niveles: estructura espacial (IfcBuildingStorey y lo que contienen, incluidas piezas anidadas).
    const storeyOf = new Map<number, number>();
    const storeyIds: number[] = [];
    const tree = await model.getSpatialStructure();
    // Fragments alterna nodos de categoría (category, localId null) y de elemento (localId, category null).
    const walk = (n: FRAGS.SpatialTreeItem, storey: number | null, parentCat: string | null) => {
      let s = storey;
      if (n.localId !== null && parentCat === "IFCBUILDINGSTOREY") {
        s = n.localId;
        storeyIds.push(n.localId);
      } else if (n.localId !== null && s !== null) storeyOf.set(n.localId, s);
      const cat = n.category ? n.category.toUpperCase() : null;
      for (const c of n.children ?? []) walk(c, s, cat);
    };
    walk(tree, null, null);
    const sdata = storeyIds.length ? await model.getItemsData(storeyIds, { attributesDefault: false, attributes: ["Name", "Elevation"] }) : [];
    idx.storeys = storeyIds
      .map((id, i) => ({
        localId: id,
        name: String((sdata[i]?.Name as FRAGS.ItemAttribute | undefined)?.value ?? `Nivel ${i + 1}`),
        // El importador da Elevation ya en metros (ver CLAUDE.md, unidades).
        elevation: Number((sdata[i]?.Elevation as FRAGS.ItemAttribute | undefined)?.value ?? 0),
      }))
      .sort((a, b) => a.elevation - b.elevation);
    const storeyName = new Map(idx.storeys.map((s) => [s.localId, s.name]));

    // Nombres en lotes (getItemsData es por lotes en el worker).
    const names = new Map<number, string>();
    for (let i = 0; i < ids.length; i += 2000) {
      const chunk = ids.slice(i, i + 2000);
      const data = await model.getItemsData(chunk, { attributesDefault: false, attributes: ["Name"] });
      chunk.forEach((id, k) => names.set(id, String((data[k]?.Name as FRAGS.ItemAttribute | undefined)?.value ?? "")));
    }

    ids.forEach((id, i) => {
      const box = boxes[i] ?? new THREE.Box3();
      let storey = storeyOf.get(id) ?? null;
      // Sin nivel en la estructura espacial: el nivel más alto por debajo de su base.
      if (storey === null && idx.storeys.length && !box.isEmpty()) {
        const below = idx.storeys.filter((s) => s.elevation <= box.min.y + 0.05);
        storey = (below[below.length - 1] ?? idx.storeys[0]).localId;
      }
      idx.elements.set(id, {
        localId: id,
        guid: guids[i] ?? "",
        ifcClass: prettyClass(clsOf.get(id) ?? null) ?? "—",
        name: names.get(id) ?? "",
        storey: storey !== null ? (storeyName.get(storey) ?? null) : null,
        box,
      });
    });
    return idx;
  }

  classes() {
    const m = new Map<string, number>();
    for (const e of this.elements.values()) m.set(e.ifcClass, (m.get(e.ifcClass) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }

  label(id: number) {
    const e = this.elements.get(id);
    return e ? `${e.ifcClass}${e.name ? ` · ${e.name}` : ""}` : `#${id}`;
  }
}

/** Triángulos en coordenadas del mundo de un elemento (todas sus mallas). */
export async function elementTriangles(model: FRAGS.FragmentsModel, ids: number[]) {
  const out = new Map<number, Float32Array>();
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const geoms = await model.getItemsGeometry(chunk);
    chunk.forEach((id, k) => {
      const meshes = geoms[k] ?? [];
      let n = 0;
      for (const m of meshes) n += m.indices?.length ?? 0;
      const tri = new Float32Array(n * 3);
      let o = 0;
      const v = new THREE.Vector3();
      for (const m of meshes) {
        if (!m.positions || !m.indices) continue;
        const p = m.positions;
        for (let j = 0; j < m.indices.length; j++) {
          const a = m.indices[j] * 3;
          v.set(p[a], p[a + 1], p[a + 2]).applyMatrix4(m.transform);
          tri[o++] = v.x;
          tri[o++] = v.y;
          tri[o++] = v.z;
        }
      }
      out.set(id, tri);
    });
  }
  return out;
}
