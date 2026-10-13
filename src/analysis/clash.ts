import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import type * as FRAGS from "@thatopen/fragments";
import { elementTriangles, type ModelIndex } from "./modelIndex";

/**
 * Detección de interferencias (choques duros) entre dos conjuntos de elementos.
 *
 * 1. Fase amplia: cajas envolventes que se solapan más que la tolerancia en los tres ejes
 *    (barrido ordenado por X).
 * 2. Fase fina con la geometría real (triángulos de Fragments) y BVH (three-mesh-bvh):
 *    - «Cruce»: las superficies se cortan.
 *    - «Contenido»: un elemento está dentro del otro sin cortar sus caras (prueba de paridad de rayos).
 * 3. Profundidad aproximada = menor solape de las cajas en X/Y/Z; se descartan los choques
 *    por debajo de la tolerancia (caras que solo se tocan: losa apoyada en muro, etc.).
 */
export type ClashKind = "Cruce" | "Contenido";
export type ClashStatus = "Nuevo" | "Activo" | "Resuelto" | "Aprobado";
export type Clash = {
  id: number;
  a: number;
  b: number;
  kind: ClashKind;
  depth: number; // m
  center: [number, number, number];
  /** Zona de solape (caja) para encuadrar la interferencia. */
  zone: [number, number, number, number, number, number];
  status: ClashStatus;
};

export type ClashOptions = {
  setA: Set<string>; // clases IFC
  setB: Set<string>;
  tolerance: number; // m
  onProgress?: (done: number, total: number, stage: string) => void;
  signal?: AbortSignal;
};

const yieldUI = () => new Promise((r) => setTimeout(r, 0));

export async function detectClashes(model: FRAGS.FragmentsModel, index: ModelIndex, opt: ClashOptions): Promise<Clash[]> {
  const tol = Math.max(0, opt.tolerance);
  const all = [...index.elements.values()].filter((e) => !e.box.isEmpty());
  const inA = (c: string) => opt.setA.has(c);
  const inB = (c: string) => opt.setB.has(c);
  const cand = all.filter((e) => inA(e.ifcClass) || inB(e.ifcClass)).sort((x, y) => x.box.min.x - y.box.min.x);

  // --- Fase amplia ---
  opt.onProgress?.(0, 1, "Buscando cajas que se solapan");
  const pairs: [number, number][] = [];
  for (let i = 0; i < cand.length; i++) {
    const e = cand[i];
    for (let j = i + 1; j < cand.length; j++) {
      const f = cand[j];
      if (f.box.min.x > e.box.max.x - tol) break;
      const ab = inA(e.ifcClass) && inB(f.ifcClass);
      const ba = inA(f.ifcClass) && inB(e.ifcClass);
      if (!ab && !ba) continue;
      if (overlapDepth(e.box, f.box) <= tol) continue;
      pairs.push(ab ? [e.localId, f.localId] : [f.localId, e.localId]);
    }
    if (i % 500 === 0) {
      if (opt.signal?.aborted) throw new DOMException("Cancelado", "AbortError");
      await yieldUI();
    }
  }

  // --- Geometría de los elementos implicados ---
  const needed = [...new Set(pairs.flat())];
  opt.onProgress?.(0, needed.length, "Leyendo geometría");
  const tris = await elementTriangles(model, needed);
  const bvhs = new Map<number, { geo: THREE.BufferGeometry; bvh: MeshBVH } | null>();
  const getBvh = (id: number) => {
    if (bvhs.has(id)) return bvhs.get(id)!;
    const t = tris.get(id);
    let v: { geo: THREE.BufferGeometry; bvh: MeshBVH } | null = null;
    if (t && t.length >= 9) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(t, 3));
      v = { geo, bvh: new MeshBVH(geo) };
    }
    bvhs.set(id, v);
    return v;
  };

  // --- Fase fina ---
  const clashes: Clash[] = [];
  const ray = new THREE.Ray();
  const p = new THREE.Vector3();
  const hit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 } as unknown as Parameters<MeshBVH["closestPointToPoint"]>[1];
  /**
   * ¿El elemento está dentro del otro? Su centroide debe quedar dentro (paridad de rayos en dos
   * direcciones) y a más de la tolerancia de la superficie del contenedor (descarta contactos).
   */
  const insideOf = (pointOwner: number, container: { bvh: MeshBVH }) => {
    const t = tris.get(pointOwner)!;
    p.set(0, 0, 0);
    for (let i = 0; i < t.length; i += 3) (p.x += t[i]), (p.y += t[i + 1]), (p.z += t[i + 2]);
    p.multiplyScalar(3 / t.length);
    for (const dir of [new THREE.Vector3(1, 0.0137, 0.0071), new THREE.Vector3(-0.011, 1, 0.017)]) {
      ray.set(p, dir.normalize());
      if (container.bvh.raycast(ray, THREE.DoubleSide).length % 2 === 0) return false;
    }
    const d = container.bvh.closestPointToPoint(p, hit);
    return !!d && d.distance > Math.max(tol, 0.001);
  };
  for (let k = 0; k < pairs.length; k++) {
    const [a, b] = pairs[k];
    const A = getBvh(a), B = getBvh(b);
    if (A && B) {
      let kind: ClashKind | null = null;
      if (crosses(A.bvh, B.bvh)) kind = "Cruce";
      else if (insideOf(a, B) || insideOf(b, A)) kind = "Contenido";
      if (kind) {
        const ea = index.elements.get(a)!.box, eb = index.elements.get(b)!.box;
        const inter = ea.clone().intersect(eb);
        const c = inter.getCenter(new THREE.Vector3());
        clashes.push({ id: clashes.length + 1, a, b, kind, depth: overlapDepth(ea, eb), center: [c.x, c.y, c.z], zone: [inter.min.x, inter.min.y, inter.min.z, inter.max.x, inter.max.y, inter.max.z], status: "Nuevo" });
      }
    }
    if (k % 40 === 0) {
      opt.onProgress?.(k, pairs.length, "Comprobando geometría");
      if (opt.signal?.aborted) throw new DOMException("Cancelado", "AbortError");
      await yieldUI();
    }
  }
  for (const v of bvhs.values()) v?.geo.dispose();
  opt.onProgress?.(pairs.length, pairs.length, "Terminado");
  return clashes;
}

const _n1 = new THREE.Vector3(), _n2 = new THREE.Vector3(), _seg = new THREE.Line3(), _cp = new THREE.Vector3();
const _identity = new THREE.Matrix4();

/** ¿El segmento de intersección está sobre una arista del triángulo? (contacto, no cruce) */
function alongEdge(t: THREE.Triangle, seg: THREE.Line3, eps: number) {
  for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
    const edge = new THREE.Line3(a, b);
    if (edge.closestPointToPoint(seg.start, true, _cp).distanceTo(seg.start) < eps && edge.closestPointToPoint(seg.end, true, _cp).distanceTo(seg.end) < eps) return true;
  }
  return false;
}

/**
 * Cruce real de superficies: hay un par de triángulos que se cortan transversalmente
 * (no coplanares, segmento de corte > 1 mm y que no sea una arista de contacto). Así no cuentan
 * como interferencia las piezas que solo se tocan (viga apoyada en la cara de un pilar, losa
 * sobre muro), que con intersectsGeometry sí daban positivo.
 */
function crosses(a: MeshBVH, b: MeshBVH) {
  const eps = 5e-4;
  return a.bvhcast(b, _identity, {
    intersectsTriangles(t1, t2) {
      if (!t1.intersectsTriangle(t2, _seg)) return false;
      if (_seg.distance() < 0.001) return false;
      t1.getNormal(_n1);
      t2.getNormal(_n2);
      if (Math.abs(_n1.dot(_n2)) > 0.9995) return false;
      if (alongEdge(t1, _seg, eps) || alongEdge(t2, _seg, eps)) return false;
      return true;
    },
  });
}

/** Menor solape de dos cajas en X, Y, Z (negativo si no se tocan). */
export function overlapDepth(a: THREE.Box3, b: THREE.Box3) {
  return Math.min(
    Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x),
    Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y),
    Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z),
  );
}
