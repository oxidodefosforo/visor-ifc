import * as THREE from "three";
import { proceduralTexture, imageTexture, type TextureKey } from "./textures";

/**
 * Materiales realistas (PBR, MeshStandardMaterial) con textura proyectada en
 * coordenadas del mundo (triplanar): la geometría IFC no trae UV, así que la
 * textura se proyecta desde X, Y y Z y se mezcla según la normal. Resultado
 * continuo entre elementos (un muro y el contiguo comparten el mismo patrón).
 */
export type MatConfig = {
  preset: string;
  color: string; // tinte (multiplica la textura) o color liso
  roughness: number;
  metalness: number;
  opacity: number;
  /** Tamaño real que cubre una repetición de la textura, en metros. */
  scale: number;
  texture: TextureKey | `custom:${string}` | null;
};

export type Preset = MatConfig & { name: string; group: string };

const P = (preset: string, name: string, group: string, c: Omit<MatConfig, "preset">): Preset => ({ preset, name, group, ...c });

export const PRESETS: Preset[] = [
  P("concrete", "Hormigón", "Estructura", { color: "#ffffff", roughness: 0.9, metalness: 0, opacity: 1, scale: 2, texture: "concrete" }),
  P("formwork", "Hormigón visto (encofrado)", "Estructura", { color: "#ffffff", roughness: 0.85, metalness: 0, opacity: 1, scale: 2.4, texture: "formwork" }),
  // Acero estructural: pintado / galvanizado mate. Un metal pulido (metalness ~1) refleja el cielo y
  // se ve como cromo azulado (comprobado en la vista realista); por eso va aparte como «inoxidable».
  P("steel", "Acero estructural (pintado)", "Estructura", { color: "#8d939a", roughness: 0.55, metalness: 0.25, opacity: 1, scale: 0.5, texture: null }),
  P("steel-galv", "Acero galvanizado", "Estructura", { color: "#b4b8bc", roughness: 0.5, metalness: 0.6, opacity: 1, scale: 0.6, texture: "brushed" }),
  P("brick", "Ladrillo", "Fachada", { color: "#ffffff", roughness: 0.85, metalness: 0, opacity: 1, scale: 0.9, texture: "brick" }),
  P("block", "Bloque de hormigón", "Fachada", { color: "#ffffff", roughness: 0.9, metalness: 0, opacity: 1, scale: 0.8, texture: "block" }),
  P("plaster", "Enlucido / pintura blanca", "Acabados", { color: "#f2f0ea", roughness: 0.92, metalness: 0, opacity: 1, scale: 1.5, texture: "plaster" }),
  P("paint", "Pintura (color)", "Acabados", { color: "#9fb4c7", roughness: 0.75, metalness: 0, opacity: 1, scale: 1, texture: null }),
  P("stone", "Piedra / granito", "Acabados", { color: "#ffffff", roughness: 0.6, metalness: 0, opacity: 1, scale: 1, texture: "stone" }),
  P("tiles", "Cerámico (300×300)", "Acabados", { color: "#ffffff", roughness: 0.35, metalness: 0, opacity: 1, scale: 1.2, texture: "tiles" }),
  P("wood", "Madera", "Acabados", { color: "#ffffff", roughness: 0.6, metalness: 0, opacity: 1, scale: 1, texture: "wood" }),
  P("parquet", "Parquet", "Acabados", { color: "#ffffff", roughness: 0.45, metalness: 0, opacity: 1, scale: 1.2, texture: "parquet" }),
  P("aluminium", "Aluminio", "Carpintería", { color: "#e3e5e8", roughness: 0.3, metalness: 1, opacity: 1, scale: 0.5, texture: "brushed" }),
  P("stainless", "Acero inoxidable", "Carpintería", { color: "#d0d3d6", roughness: 0.25, metalness: 1, opacity: 1, scale: 0.5, texture: "brushed" }),
  P("glass", "Vidrio", "Carpintería", { color: "#a9c6d6", roughness: 0.05, metalness: 0, opacity: 0.28, scale: 1, texture: null }),
  P("asphalt", "Asfalto", "Exterior", { color: "#ffffff", roughness: 0.95, metalness: 0, opacity: 1, scale: 2, texture: "asphalt" }),
  P("gravel", "Grava", "Exterior", { color: "#ffffff", roughness: 0.95, metalness: 0, opacity: 1, scale: 1, texture: "gravel" }),
  P("grass", "Césped", "Exterior", { color: "#ffffff", roughness: 1, metalness: 0, opacity: 1, scale: 2, texture: "grass" }),
];

export const presetByKey = (k: string) => PRESETS.find((p) => p.preset === k);

export function configFromPreset(key: string): MatConfig {
  const p = presetByKey(key) ?? PRESETS[0];
  const { name: _n, group: _g, ...cfg } = p;
  return { ...cfg };
}

/** Asignación automática por palabras clave del nombre del material IFC (Revit en inglés o español). */
const RULES: [RegExp, string][] = [
  [/glass|glaz|vidrio|cristal|acristal/i, "glass"],
  [/alumin/i, "aluminium"],
  [/stainless|inoxidable/i, "stainless"],
  [/galvan/i, "steel-galv"],
  [/steel|acero|metal|iron|hierro|rebar|armadura/i, "steel"],
  [/brick|ladrillo|clay|arcilla/i, "brick"],
  [/block|bloque|cmu|masonry|mamposter/i, "block"],
  [/parquet|flooring|tarima/i, "parquet"],
  [/wood|timber|madera|oak|pine|roble|pino|plywood|contrachapado/i, "wood"],
  [/tile|cer[aá]mic|porcelan|azulejo|baldosa/i, "tiles"],
  [/stone|piedra|granit|marble|m[aá]rmol/i, "stone"],
  [/asphalt|asfalto|bitum/i, "asphalt"],
  [/gravel|grava/i, "gravel"],
  [/grass|c[eé]sped|lawn/i, "grass"],
  [/plaster|gypsum|yeso|enlucid|stucco|drywall|plasterboard|pladur|paint|pintura/i, "plaster"],
  [/concrete|hormig[oó]n|concreto|cement|cemento|precast|prefabric/i, "concrete"],
];

export function guessPreset(materialName: string): string | null {
  for (const [re, key] of RULES) if (re.test(materialName)) return key;
  return null;
}

// ---------------- Material PBR triplanar ----------------

type TriplanarData = { scale: { value: number } };

function textureFor(cfg: MatConfig, customTextures: Record<string, string>) {
  if (!cfg.texture) return null;
  if (cfg.texture.startsWith("custom:")) {
    const id = cfg.texture.slice(7);
    const url = customTextures[id];
    return url ? imageTexture(id, url) : null;
  }
  return proceduralTexture(cfg.texture as TextureKey).texture;
}

function installTriplanar(mat: THREE.MeshStandardMaterial, data: TriplanarData) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tpScale = data.scale;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTpPos;\nvarying vec3 vTpNormal;")
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        mat4 tpInvView = inverse(viewMatrix);
        vTpPos = (tpInvView * mvPosition).xyz;
        vTpNormal = normalize((tpInvView * vec4(transformedNormal, 0.0)).xyz);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vTpPos;\nvarying vec3 vTpNormal;\nuniform float tpScale;")
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
          vec3 tpW = pow(abs(normalize(vTpNormal)), vec3(4.0));
          tpW /= (tpW.x + tpW.y + tpW.z);
          vec3 tpP = vTpPos / tpScale;
          vec4 tpCol = texture2D(map, tpP.zy) * tpW.x + texture2D(map, tpP.xz) * tpW.y + texture2D(map, tpP.xy) * tpW.z;
          diffuseColor *= tpCol;
        #endif`,
      );
  };
  mat.customProgramCacheKey = () => "visor-triplanar";
}

/** Material PBR a partir del material base de Fragments (color IFC) y una configuración opcional. */
export function createPbr(
  base: { color?: THREE.ColorRepresentation; opacity?: number; side?: THREE.Side },
  cfg: MatConfig | null,
  customTextures: Record<string, string>,
): THREE.MeshStandardMaterial {
  const data: TriplanarData = { scale: { value: 1 } };
  const mat = new THREE.MeshStandardMaterial({ side: base.side ?? THREE.FrontSide });
  mat.userData.triplanar = data;
  mat.userData.baseColor = new THREE.Color(base.color ?? 0xcccccc);
  mat.userData.baseOpacity = base.opacity ?? 1;
  installTriplanar(mat, data);
  applyConfig(mat, cfg, customTextures);
  return mat;
}

/** Aplica (o retira, con null) una configuración a un material ya creado, sin recrearlo. */
export function applyConfig(mat: THREE.MeshStandardMaterial, cfg: MatConfig | null, customTextures: Record<string, string>) {
  const data = mat.userData.triplanar as TriplanarData;
  const prevMap = mat.map;
  if (!cfg) {
    mat.color.copy(mat.userData.baseColor);
    mat.roughness = 0.85;
    mat.metalness = 0;
    mat.opacity = mat.userData.baseOpacity;
    mat.map = null;
  } else {
    mat.color.set(cfg.color);
    mat.roughness = cfg.roughness;
    mat.metalness = cfg.metalness;
    mat.opacity = cfg.opacity;
    mat.map = textureFor(cfg, customTextures);
    data.scale.value = Math.max(cfg.scale, 0.01);
  }
  mat.transparent = mat.opacity < 1;
  mat.depthWrite = mat.opacity >= 0.99;
  mat.envMapIntensity = cfg?.preset === "glass" ? 1.6 : 1;
  if (!!prevMap !== !!mat.map) mat.needsUpdate = true; // cambia el #define USE_MAP
}
