import * as THREE from "three";
import * as OBC from "@thatopen/components";
import type * as OBF from "@thatopen/components-front";
import type * as FRAGS from "@thatopen/fragments";
import { applyConfig, configFromPreset, createPbr, guessPreset, type MatConfig } from "./materials";

/**
 * Apariencia realista de los elementos.
 *
 * - Intercepta la creación de materiales de Fragments (MaterialManager.new) para usar
 *   MeshStandardMaterial (PBR) en lugar de MeshLambertMaterial.
 * - Las asignaciones se aplican como «estilos» del Highlighter de That Open
 *   (`mat:g:*` por material IFC, prioridad 1; `mat:o:*` por elemento, prioridad 2).
 *   La selección (prioridad máxima) siempre se ve encima y, al deseleccionar,
 *   el Highlighter vuelve a pintar el material asignado.
 * - Solo se aplican en Vista realista; en Vista técnica se ven los colores del IFC.
 * - El perfil (material IFC → configuración) se guarda en este equipo y se
 *   puede exportar/importar como JSON para reutilizarlo entre proyectos.
 */
export type MaterialGroup = { name: string; localIds: number[]; color: string | null };
export type Profile = {
  version: 1;
  byMaterial: Record<string, MatConfig>;
  /** Por GlobalId: sobrescribe el material IFC del elemento. */
  byElement: Record<string, MatConfig>;
  customTextures: Record<string, string>;
};

const STORAGE = "visor.materials.profile";
const NO_MATERIAL = "(sin material)";

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function emptyProfile(): Profile {
  return { version: 1, byMaterial: {}, byElement: {}, customTextures: {} };
}

export class Appearance {
  realistic = false;
  profile: Profile = this.load();
  groups: MaterialGroup[] = [];
  private modelId: string | null = null;
  /** customId del estilo → configuración vigente. */
  private styleConfig = new Map<string, MatConfig>();
  /** customId → materiales Three creados por Fragments para ese estilo. */
  private registry = new Map<string, Set<THREE.MeshStandardMaterial>>();
  private guidByLocal = new Map<number, string>();
  private localByGuid = new Map<string, number>();
  onChange?: () => void;

  constructor(
    private fragments: OBC.FragmentsManager,
    private highlighter: OBF.Highlighter,
  ) {}

  /** Debe llamarse tras fragments.init() y antes de cargar modelos. */
  install() {
    const mm = this.fragments.core.models.materials as unknown as {
      new: (data: any, request: any) => THREE.Material;
    };
    const original = mm.new.bind(mm);
    mm.new = (data: any, request: any) => {
      const mat = original(data, request);
      if (!(mat instanceof THREE.MeshLambertMaterial)) return mat; // líneas/LOD
      const customId: string | undefined = data.customId;
      if (customId && !customId.startsWith("mat:")) return mat; // selección y otros estilos
      const cfg = customId ? (this.styleConfig.get(customId) ?? null) : null;
      const pbr = createPbr({ color: mat.color, opacity: mat.opacity, side: mat.side }, cfg, this.profile.customTextures);
      pbr.userData = { ...mat.userData, ...pbr.userData };
      pbr.depthTest = mat.depthTest;
      pbr.depthWrite = mat.depthWrite && pbr.depthWrite;
      pbr.polygonOffset = mat.polygonOffset;
      pbr.polygonOffsetFactor = mat.polygonOffsetFactor;
      pbr.polygonOffsetUnits = mat.polygonOffsetUnits;
      mat.dispose();
      if (customId) {
        let set = this.registry.get(customId);
        if (!set) this.registry.set(customId, (set = new Set()));
        set.add(pbr);
        pbr.addEventListener("dispose", () => set!.delete(pbr));
      }
      return pbr;
    };
  }

  // ---------------- Modelo ----------------

  /** Agrupa los elementos con geometría por material IFC (nombre). */
  async analyze(model: FRAGS.FragmentsModel) {
    this.modelId = model.modelId;
    const items = await model.getItemsWithGeometry();
    const ids = await Promise.all(items.map((i) => i.getLocalId()));
    const localIds = ids.filter((x): x is number => typeof x === "number");
    const groups = new Map<string, number[]>();
    const BATCH = 1500;
    for (let i = 0; i < localIds.length; i += BATCH) {
      const chunk = localIds.slice(i, i + BATCH);
      const data = await model.getItemsData(chunk, {
        attributesDefault: false,
        attributes: ["Name"],
        relations: {
          HasAssociations: { attributes: true, relations: true },
          IsDefinedBy: { attributes: false, relations: true }, // para llegar al tipo
          HasPropertySets: { attributes: false, relations: false },
          ObjectTypeOf: { attributes: false, relations: false },
          RepresentationMaps: { attributes: false, relations: false },
          ForLayerSet: { attributes: false, relations: false },
          AssociatedTo: { attributes: false, relations: false },
        },
        relationsDefault: { attributes: false, relations: false },
      });
      chunk.forEach((id, k) => {
        const name = firstMaterialName(data[k]) ?? NO_MATERIAL;
        let list = groups.get(name);
        if (!list) groups.set(name, (list = []));
        list.push(id);
      });
    }
    const guids = await model.getGuidsByLocalIds(localIds);
    this.guidByLocal.clear();
    this.localByGuid.clear();
    localIds.forEach((id, k) => {
      const g = guids[k];
      if (g) {
        this.guidByLocal.set(id, g);
        this.localByGuid.set(g, id);
      }
    });
    this.groups = [...groups.entries()]
      .map(([name, ids]) => ({ name, localIds: ids, color: null }))
      .sort((a, b) => b.localIds.length - a.localIds.length);
    if (this.realistic) await this.applyAll();
    this.onChange?.();
  }

  reset() {
    this.modelId = null;
    this.groups = [];
    this.guidByLocal.clear();
    this.localByGuid.clear();
    for (const id of [...this.styleConfig.keys()]) this.highlighter.styles.delete(id);
    this.styleConfig.clear();
  }

  // ---------------- Asignaciones ----------------

  configForMaterial(name: string): MatConfig | null {
    return this.profile.byMaterial[name] ?? null;
  }

  setMaterialConfig(name: string, cfg: MatConfig | null) {
    if (cfg) this.profile.byMaterial[name] = cfg;
    else delete this.profile.byMaterial[name];
    this.save();
    const id = `mat:g:${hash(name)}`;
    // Si el estilo ya existe, se actualizan sus materiales sin volver a resaltar (instantáneo).
    if (cfg && this.styleConfig.has(id)) {
      this.styleConfig.set(id, cfg);
      for (const m of this.registry.get(id) ?? []) applyConfig(m, cfg, this.profile.customTextures);
      this.onChange?.();
      return Promise.resolve();
    }
    return this.applyAll();
  }

  /** Asigna una configuración a elementos concretos (por localId) del modelo actual. */
  async setElementConfig(localIds: number[], cfg: MatConfig | null) {
    for (const id of localIds) {
      const g = this.guidByLocal.get(id);
      if (!g) continue;
      if (cfg) this.profile.byElement[g] = cfg;
      else delete this.profile.byElement[g];
    }
    this.save();
    await this.applyAll();
  }

  elementConfig(localId: number): MatConfig | null {
    const g = this.guidByLocal.get(localId);
    return g ? (this.profile.byElement[g] ?? null) : null;
  }

  /** Asigna presets por palabras clave a los materiales IFC que aún no tienen configuración. */
  async autoAssign() {
    let n = 0;
    for (const g of this.groups) {
      if (this.profile.byMaterial[g.name]) continue;
      const key = guessPreset(g.name);
      if (key) {
        this.profile.byMaterial[g.name] = configFromPreset(key);
        n++;
      }
    }
    this.save();
    await this.applyAll();
    return n;
  }

  async setRealistic(on: boolean) {
    this.realistic = on;
    await this.applyAll();
  }

  /** Reconstruye los estilos del Highlighter a partir del perfil. */
  async applyAll() {
    const desired = new Map<string, { cfg: MatConfig; priority: number; ids: number[] }>();
    if (this.realistic && this.modelId) {
      for (const g of this.groups) {
        const cfg = this.profile.byMaterial[g.name];
        if (cfg) desired.set(`mat:g:${hash(g.name)}`, { cfg, priority: 1, ids: g.localIds });
      }
      for (const [guid, cfg] of Object.entries(this.profile.byElement)) {
        const id = this.localByGuid.get(guid);
        if (id === undefined) continue;
        const key = `mat:o:${hash(JSON.stringify(cfg))}`;
        const entry = desired.get(key) ?? { cfg, priority: 2, ids: [] };
        entry.ids.push(id);
        desired.set(key, entry);
      }
    }
    // Fragments (3.4.8) reutiliza el hueco de definición que libera la selección para un estilo
    // nuevo creado a la vez y no da por cambiadas las mallas: al deseleccionar, los elementos se
    // quedaban NARANJAS (verificado). Por eso la selección se quita antes de cambiar estilos y no se
    // restaura (así además se ve el material aplicado, y no hay carreras con el usuario).
    if (!OBC.ModelIdMapUtils.isEmpty(this.highlighter.selection["select"] ?? {})) await this.highlighter.clear("select");

    // Retirar estilos que ya no aplican
    for (const id of [...this.styleConfig.keys()]) {
      if (!desired.has(id)) {
        this.styleConfig.delete(id);
        this.highlighter.styles.delete(id); // limpia su selección y repinta
      }
    }
    for (const [id, { cfg, priority, ids }] of desired) {
      const known = this.styleConfig.get(id);
      this.styleConfig.set(id, cfg);
      if (known) for (const m of this.registry.get(id) ?? []) applyConfig(m, cfg, this.profile.customTextures);
      else
        this.highlighter.styles.set(id, {
          color: new THREE.Color(cfg.color),
          opacity: cfg.opacity,
          transparent: cfg.opacity < 1,
          renderedFaces: 0,
          priority,
        } as never);
      const map: OBC.ModelIdMap = { [this.modelId!]: new Set(ids) };
      await this.highlighter.highlightByID(id, map, true, false);
    }
    if (!desired.size) await this.highlighter.updateColors();
    // updateColors lanza fragments.core.update EN PARALELO con los highlight (leído en el código de
    // components-front), no después: una actualización al final asegura que las mallas reflejan
    // los estilos ya aplicados. Medida de seguridad barata; no es la causa de ningún fallo observado.
    await this.fragments.core.update(true);
    this.onChange?.();
  }

  // ---------------- Texturas propias y perfil ----------------

  addCustomTexture(dataUrl: string) {
    const id = hash(dataUrl.slice(0, 2000) + dataUrl.length);
    this.profile.customTextures[id] = dataUrl;
    this.save();
    return id;
  }

  exportProfile() {
    return JSON.stringify({ ...this.profile, byElement: {} }, null, 2);
  }

  async importProfile(json: string) {
    const p = JSON.parse(json) as Partial<Profile>;
    if (!p || typeof p !== "object" || !p.byMaterial) throw new Error("El archivo no es un perfil de materiales del Visor IFC.");
    this.profile.byMaterial = { ...this.profile.byMaterial, ...p.byMaterial };
    this.profile.customTextures = { ...this.profile.customTextures, ...(p.customTextures ?? {}) };
    this.save();
    await this.applyAll();
  }

  async clearProfile() {
    this.profile = emptyProfile();
    this.save();
    await this.applyAll();
  }

  /** Para pruebas: materiales PBR creados por estilo. */
  debug() {
    return {
      styles: [...this.styleConfig.keys()],
      registry: Object.fromEntries([...this.registry].map(([k, v]) => [k, [...v].map((m) => ({ color: m.color.getHexString(), map: m.map?.name ?? null, roughness: m.roughness, metalness: m.metalness, opacity: m.opacity }))])),
    };
  }

  private load(): Profile {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) return { ...emptyProfile(), ...JSON.parse(raw) };
    } catch {}
    return emptyProfile();
  }

  private save() {
    try {
      localStorage.setItem(STORAGE, JSON.stringify(this.profile));
    } catch (e) {
      console.warn("No se pudo guardar el perfil de materiales (¿texturas propias demasiado grandes?)", e);
    }
  }
}

/** Primer nombre de material IFC: del elemento o, si no tiene, de su tipo. */
function firstMaterialName(item: FRAGS.ItemData | undefined): string | null {
  if (!item) return null;
  const visit = (node: FRAGS.ItemData, depth: number): string | null => {
    if (depth > 4) return null;
    const assoc = node.HasAssociations;
    if (Array.isArray(assoc)) {
      for (const a of assoc) {
        const cat = String((a._category as FRAGS.ItemAttribute | undefined)?.value ?? "").toUpperCase();
        const name = (a.Name as FRAGS.ItemAttribute | undefined)?.value;
        if (cat === "IFCMATERIAL" && name) return String(name);
        for (const v of Object.values(a)) {
          if (!Array.isArray(v)) continue;
          for (const child of v) {
            const r = visit({ HasAssociations: [child] } as FRAGS.ItemData, depth + 1);
            if (r) return r;
            const c = String((child._category as FRAGS.ItemAttribute | undefined)?.value ?? "").toUpperCase();
            const n = (child.Name as FRAGS.ItemAttribute | undefined)?.value;
            if (c === "IFCMATERIAL" && n) return String(n);
          }
        }
      }
    }
    // Material del tipo (IsDefinedBy aplanado contiene el objeto tipo)
    const defs = node.IsDefinedBy;
    if (Array.isArray(defs)) for (const d of defs) {
      const r = visit(d, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return visit(item, 0);
}
