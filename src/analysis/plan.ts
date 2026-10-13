import type * as FRAGS from "@thatopen/fragments";
import { elementTriangles, type ModelIndex, type Storey } from "./modelIndex";

/**
 * Planta 2D de un nivel calculada con la geometría real (triángulos de Fragments):
 *  - Elementos cortados por el plano (altura de corte): contorno del corte, trazo grueso y relleno.
 *  - Elementos de la franja del nivel que no corta el plano: contorno a media altura del elemento,
 *    discontinuo si está por encima del corte (vigas, losa superior) y fino si está por debajo.
 * Coordenadas de planta en metros: X = x del visor, Y = −z del visor (norte del proyecto hacia arriba).
 */
export type Seg = [number, number, number, number];
export type PlanLayer = "cut" | "below" | "above";
export type PlanElement = { localId: number; ifcClass: string; layer: PlanLayer; segs: Seg[]; loops: number[][] };
export type PlanData = {
  storey: Storey;
  cutHeight: number; // m sobre el nivel
  elements: PlanElement[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

/** Corta triángulos (x,y,z del visor, Y arriba) con el plano horizontal y = h. */
export function sliceTriangles(tri: Float32Array, h: number): Seg[] {
  const out: Seg[] = [];
  const pts: number[] = [];
  for (let i = 0; i < tri.length; i += 9) {
    const d0 = tri[i + 1] - h, d1 = tri[i + 4] - h, d2 = tri[i + 7] - h;
    if ((d0 > 0 && d1 > 0 && d2 > 0) || (d0 < 0 && d1 < 0 && d2 < 0)) continue;
    if (d0 === 0 && d1 === 0 && d2 === 0) continue; // cara contenida en el plano
    pts.length = 0;
    const edge = (a: number, da: number, b: number, db: number) => {
      if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
        const t = da / (da - db);
        pts.push(tri[a] + (tri[b] - tri[a]) * t, -(tri[a + 2] + (tri[b + 2] - tri[a + 2]) * t));
      }
    };
    edge(i, d0, i + 3, d1);
    edge(i + 3, d1, i + 6, d2);
    edge(i + 6, d2, i, d0);
    // Vértices exactamente en el plano
    if (d0 === 0) pts.push(tri[i], -tri[i + 2]);
    if (d1 === 0) pts.push(tri[i + 3], -tri[i + 5]);
    if (d2 === 0) pts.push(tri[i + 6], -tri[i + 8]);
    if (pts.length >= 4 && (pts[0] !== pts[2] || pts[1] !== pts[3])) out.push([pts[0], pts[1], pts[2], pts[3]]);
  }
  return out;
}

/** Une segmentos en polígonos cerrados (para el relleno del corte). */
export function chainLoops(segs: Seg[], eps = 1e-4): number[][] {
  const key = (x: number, y: number) => `${Math.round(x / eps)},${Math.round(y / eps)}`;
  const adj = new Map<string, { x: number; y: number; next: string[] }>();
  const add = (a: string, x: number, y: number, b: string) => {
    let n = adj.get(a);
    if (!n) adj.set(a, (n = { x, y, next: [] }));
    n.next.push(b);
  };
  for (const [x1, y1, x2, y2] of segs) {
    const a = key(x1, y1), b = key(x2, y2);
    if (a === b) continue;
    add(a, x1, y1, b);
    add(b, x2, y2, a);
  }
  const used = new Set<string>();
  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const loops: number[][] = [];
  for (const [start, node] of adj) {
    for (const first of node.next) {
      if (used.has(edgeKey(start, first))) continue;
      const loop = [node.x, node.y];
      let prev = start, cur = first;
      used.add(edgeKey(start, first));
      let guard = 0;
      while (cur !== start && guard++ < 100000) {
        const n = adj.get(cur)!;
        loop.push(n.x, n.y);
        const nxt = n.next.find((k) => k !== prev && !used.has(edgeKey(cur, k)));
        if (!nxt) break;
        used.add(edgeKey(cur, nxt));
        prev = cur;
        cur = nxt;
      }
      if (cur === start && loop.length >= 6) loops.push(loop);
    }
  }
  return loops;
}

export async function computePlan(model: FRAGS.FragmentsModel, index: ModelIndex, storey: Storey, cutHeight: number, onProgress?: (d: number, t: number) => void): Promise<PlanData> {
  const levels = index.storeys;
  const i = levels.findIndex((s) => s.localId === storey.localId);
  const next = levels[i + 1]?.elevation ?? storey.elevation + Math.max(3, cutHeight * 2.5);
  const h = storey.elevation + cutHeight;
  const bandMin = storey.elevation - 0.3, bandMax = next - 0.01;
  const cand = [...index.elements.values()].filter((e) => !e.box.isEmpty() && e.box.max.y > bandMin && e.box.min.y < bandMax);
  const tris = await elementTriangles(model, cand.map((e) => e.localId));
  const elements: PlanElement[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  cand.forEach((e, k) => {
    const t = tris.get(e.localId);
    if (!t || !t.length) return;
    let layer: PlanLayer;
    let y: number;
    if (e.box.min.y < h && e.box.max.y > h) (layer = "cut"), (y = h);
    else if (e.box.min.y >= h) (layer = "above"), (y = (e.box.min.y + e.box.max.y) / 2);
    else (layer = "below"), (y = (e.box.min.y + e.box.max.y) / 2);
    const segs = sliceTriangles(t, y);
    if (!segs.length) return;
    for (const [x1, y1, x2, y2] of segs) {
      minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2);
      minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2);
    }
    elements.push({ localId: e.localId, ifcClass: e.ifcClass, layer, segs, loops: layer === "cut" ? chainLoops(segs) : [] });
    if (k % 200 === 0) onProgress?.(k, cand.length);
  });
  if (!elements.length) (minX = 0), (minY = 0), (maxX = 1), (maxY = 1);
  return { storey, cutHeight, elements, bounds: { minX, minY, maxX, maxY } };
}
