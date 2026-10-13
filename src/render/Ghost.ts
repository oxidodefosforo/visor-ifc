import * as THREE from "three";
import type * as FRAGS from "@thatopen/fragments";
import { elementTriangles } from "../analysis/modelIndex";

/**
 * Modelo «fantasma»: copia translúcida de todo el modelo para dar contexto cuando solo se muestran
 * unos pocos elementos (interferencia, incumplimientos IDS, cambios entre versiones).
 *
 * Por qué una malla aparte: en Fragments 3.4.8 un estilo/opacidad se dibuja ENCIMA de la geometría
 * base (comprobado: con setOpacity(…, 0.12) en todos los elementos seguían dibujándose los tramos
 * opacos de la base), así que la transparencia por elemento no deja ver a través. Aquí se ocultan
 * los elementos reales que no interesan (Hider) y se dibuja esta copia sin escribir profundidad.
 */
export class Ghost {
  private mesh: THREE.Mesh | null = null;
  private modelId: string | null = null;
  private building: Promise<THREE.Mesh> | null = null;

  constructor(private scene: THREE.Scene) {}

  private async build(model: FRAGS.FragmentsModel) {
    const ids = await model.getItemsIdsWithGeometry();
    const tris = await elementTriangles(model, ids);
    let n = 0;
    for (const t of tris.values()) n += t.length;
    const pos = new Float32Array(n);
    let o = 0;
    for (const t of tris.values()) (pos.set(t, o), (o += t.length));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ color: 0xaab4c0, transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "visor-ghost";
    mesh.renderOrder = 10; // después de lo opaco
    mesh.frustumCulled = false;
    mesh.raycast = () => {}; // no interfiere con la selección
    return mesh;
  }

  async show(model: FRAGS.FragmentsModel) {
    if (this.modelId !== model.modelId) this.dispose();
    if (!this.mesh) {
      this.modelId = model.modelId;
      this.building ??= this.build(model);
      const mesh = await this.building;
      this.building = null;
      if (this.modelId !== model.modelId) return; // cambió el modelo mientras tanto
      this.mesh = mesh;
    }
    if (!this.mesh.parent) this.scene.add(this.mesh);
  }

  hide() {
    this.mesh?.removeFromParent();
  }

  get visible() {
    return !!this.mesh?.parent;
  }

  dispose() {
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    this.mesh = null;
    this.modelId = null;
    this.building = null;
  }
}
