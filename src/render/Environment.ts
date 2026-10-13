import * as THREE from "three";
import * as OBC from "@thatopen/components";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { proceduralTexture } from "./textures";

/**
 * Entorno de la Vista realista: cielo físico (Sky de three), iluminación de
 * entorno generada desde ese cielo (PMREM), sol direccional con sombras suaves,
 * mapeo de tonos ACES, suelo opcional y exposición. En Vista técnica se
 * restaura todo tal como lo deja That Open.
 */
export type EnvSettings = {
  /** Hora solar (6–20); determina la elevación del sol. */
  hour: number;
  /** Orientación del sol en grados (0 = norte del modelo, sentido horario). */
  azimuth: number;
  shadows: boolean;
  ground: "none" | "neutral" | "grass";
  exposure: number;
};

export const DEFAULT_ENV: EnvSettings = { hour: 15, azimuth: 225, shadows: true, ground: "neutral", exposure: 1 };

type World = OBC.SimpleWorld<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>;

export class Environment {
  enabled = false;
  settings: EnvSettings = { ...DEFAULT_ENV, ...loadSettings() };
  private sky = new Sky();
  private sun = new THREE.DirectionalLight(0xffffff, 3);
  private hemi = new THREE.HemisphereLight(0xdfeaff, 0x5a5246, 0.35);
  private ground: THREE.Mesh;
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  /** Fondo: el cielo renderizado una vez a un cubemap (mucho más barato que el shader del cielo en cada píxel). */
  private skyCube = new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType });
  private cubeCam = new THREE.CubeCamera(1, 2000, this.skyCube);
  private box = new THREE.Box3(new THREE.Vector3(-25, 0, -25), new THREE.Vector3(25, 20, 25));
  private saved: { bg: THREE.Color | THREE.Texture | null; tone: THREE.ToneMapping; exposure: number; lights: { l: THREE.Light; i: number }[] } | null = null;
  private envTimer = 0;
  private grassTex: THREE.Texture | null = null;

  constructor(
    private world: World,
    private grid: OBC.SimpleGrid | null,
  ) {
    const renderer = world.renderer!.three;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.sky.scale.setScalar(450000);
    this.sky.name = "visor-sky";
    this.sun.name = "visor-sun";
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.shadow.radius = 3;
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x9a968c, roughness: 1, metalness: 0 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.name = "visor-ground";
    // Sombras: Fragments crea/recicla mallas al moverse; se marcan antes de cada render.
    world.renderer!.onBeforeUpdate.add(this.markShadows);
  }

  setModelBounds(box: THREE.Box3 | null) {
    if (box && !box.isEmpty()) this.box.copy(box);
    this.layout();
  }

  async setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    const renderer = this.world.renderer!.three;
    const scene = this.world.scene.three;
    if (on) {
      const lights: { l: THREE.Light; i: number }[] = [];
      scene.traverse((o) => {
        if ((o as THREE.Light).isLight && !o.name.startsWith("visor-")) {
          const l = o as THREE.Light;
          lights.push({ l, i: l.intensity });
          l.intensity *= 0.15; // la luz la ponen el cielo y el sol
        }
      });
      this.saved = { bg: scene.background as THREE.Color | null, tone: renderer.toneMapping, exposure: renderer.toneMappingExposure, lights };
      scene.background = null;
      scene.add(this.sun, this.sun.target, this.hemi, this.ground);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap se eliminó en three r18x; radius suaviza
      if (this.grid) this.grid.visible = false;
      this.apply();
    } else {
      scene.remove(this.sun, this.sun.target, this.hemi, this.ground);
      scene.environment = null;
      if (this.saved) {
        scene.background = this.saved.bg;
        renderer.toneMapping = this.saved.tone;
        renderer.toneMappingExposure = this.saved.exposure;
        for (const { l, i } of this.saved.lights) l.intensity = i;
      }
      renderer.shadowMap.enabled = false;
      if (this.grid) this.grid.visible = true;
      this.forceMaterialRecompile();
    }
  }

  update(patch: Partial<EnvSettings>) {
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
    if (this.enabled) this.apply();
  }

  /** Dirección del sol (vector unitario hacia el sol). */
  sunDirection() {
    const { hour, azimuth } = this.settings;
    // Elevación sencilla: 0° a las 6 y 18 h, máximo 65° a las 12 h.
    const elev = THREE.MathUtils.degToRad(Math.max(-4, 65 * Math.sin(((hour - 6) / 12) * Math.PI)));
    const az = THREE.MathUtils.degToRad(azimuth);
    return new THREE.Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev)).normalize();
  }

  private apply() {
    const renderer = this.world.renderer!.three;
    const s = this.settings;
    // Calibrado comparando capturas con el cielo físico (HDR) + sol: con 0.35 las caras al sol se
    // saturaban y ACES aplanaba las texturas (el hormigón se veía liso). 0.175 conserva textura,
    // sombras y un cielo azul. El control «Exposición» del panel multiplica este valor.
    renderer.toneMappingExposure = s.exposure * 0.175;
    const dir = this.sunDirection();
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 1.2;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.8;
    u.sunPosition.value.copy(dir);
    const daylight = THREE.MathUtils.clamp(dir.y * 4, 0, 1);
    this.sun.intensity = 3.2 * daylight;
    this.sun.color.setHSL(0.09, 0.6, 0.55 + 0.4 * daylight);
    this.hemi.intensity = 0.15 + 0.35 * daylight;
    this.sun.castShadow = s.shadows;
    this.ground.visible = s.ground !== "none";
    const gm = this.ground.material as THREE.MeshStandardMaterial;
    if (s.ground === "grass") {
      if (!this.grassTex) {
        this.grassTex = proceduralTexture("grass").texture.clone(); // repetición propia del suelo
        this.grassTex.needsUpdate = true;
      }
      gm.map = this.grassTex;
      gm.color.set(0xffffff);
    } else {
      gm.map = null;
      gm.color.set(0x9a968c);
    }
    gm.needsUpdate = true;
    this.layout();
    this.scheduleEnvMap();
    this.forceMaterialRecompile();
  }

  /** Sol, sombras y suelo ajustados al tamaño del modelo. */
  private layout() {
    const center = this.box.getCenter(new THREE.Vector3());
    const size = this.box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 5);
    const dir = this.sunDirection();
    this.sun.position.copy(center).addScaledVector(dir, radius * 2);
    this.sun.target.position.copy(center);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = 0.1;
    cam.far = radius * 4;
    cam.updateProjectionMatrix();
    const g = Math.max(radius * 12, 200);
    this.ground.scale.set(g, g, 1);
    this.ground.position.set(center.x, this.box.min.y - 0.02, center.z);
    const gm = this.ground.material as THREE.MeshStandardMaterial;
    if (gm.map) gm.map.repeat.set(g / 2, g / 2);
  }

  /** La iluminación de entorno se recalcula desde el cielo (con retardo al mover controles). */
  private scheduleEnvMap() {
    window.clearTimeout(this.envTimer);
    this.envTimer = window.setTimeout(() => {
      if (!this.enabled) return;
      const tmp = new THREE.Scene();
      const sky = new Sky();
      sky.scale.setScalar(1000);
      (sky.material.uniforms as typeof this.sky.material.uniforms).sunPosition.value.copy(this.sky.material.uniforms.sunPosition.value);
      for (const k of ["turbidity", "rayleigh", "mieCoefficient", "mieDirectionalG"] as const)
        sky.material.uniforms[k].value = this.sky.material.uniforms[k].value;
      tmp.add(sky);
      const renderer = this.world.renderer!.three;
      // Fondo: cubemap del cielo (sin mapeo de tonos aquí; se aplica al dibujar la escena)
      const tone = renderer.toneMapping;
      renderer.toneMapping = THREE.NoToneMapping;
      this.cubeCam.update(renderer, tmp);
      renderer.toneMapping = tone;
      this.world.scene.three.background = this.skyCube.texture;
      this.envRT?.dispose();
      this.envRT = this.pmrem.fromScene(tmp, 0, 0.1, 2000);
      this.world.scene.three.environment = this.envRT.texture;
      this.world.scene.three.environmentIntensity = 0.4;
      this.world.scene.three.backgroundIntensity = 0.6;
      sky.material.dispose();
      sky.geometry.dispose();
    }, 120);
  }

  private markShadows = () => {
    if (!this.enabled || !this.settings.shadows) return;
    this.world.scene.three.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || o === this.ground) return;
      const mat = m.material as THREE.Material | THREE.Material[];
      const isShell = Array.isArray(mat) ? mat.some((x) => (x as THREE.MeshStandardMaterial).isMeshStandardMaterial) : (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial;
      if (isShell) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
  };

  /** Cambiar sombras/entorno exige recompilar los programas de los materiales. */
  private forceMaterialRecompile() {
    this.world.scene.three.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (!m) return;
      for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true;
    });
  }

  dispose() {
    this.world.renderer?.onBeforeUpdate.remove(this.markShadows);
    window.clearTimeout(this.envTimer);
    this.envRT?.dispose();
    this.grassTex?.dispose();
    this.pmrem.dispose();
    this.sky.material.dispose();
    this.sky.geometry.dispose();
    this.skyCube.dispose();
    this.ground.geometry.dispose();
    (this.ground.material as THREE.Material).dispose();
    this.sun.dispose();
  }
}

function loadSettings(): Partial<EnvSettings> {
  try {
    return JSON.parse(localStorage.getItem("visor.env") ?? "{}");
  } catch {
    return {};
  }
}
function saveSettings(s: EnvSettings) {
  try {
    localStorage.setItem("visor.env", JSON.stringify(s));
  } catch {}
}
