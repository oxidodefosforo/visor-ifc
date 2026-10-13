import * as THREE from "three";
import type * as OBC from "@thatopen/components";
import type * as FRAGS from "@thatopen/fragments";
import type { Navigator } from "./Navigator";
import type { Environment } from "../render/Environment";

/**
 * Vista en gafas de realidad virtual (WebXR, sesión «immersive-vr»).
 * Pensado para Meta Quest con Link / Air Link: Chrome o Edge en Windows exponen las gafas
 * como dispositivo WebXR a través de OpenXR. Electron NO incluye WebXR (comprobado:
 * `navigator.xr` no existe en Electron 44), así que la app de escritorio abre esta misma
 * página en el navegador (ver electron/vrServer.cjs).
 *
 * Se reutiliza el mismo renderizador, escena y modelo de Fragments (sin duplicar memoria).
 * Durante la sesión se detiene el bucle de That Open (Components) y se usa el de three
 * (`renderer.setAnimationLoop`), que es el que sincroniza con las gafas.
 *
 * Controles (mandos Touch):
 *  - Joystick izquierdo: andar (adelante/atrás/lados, en la dirección de la mirada, en horizontal).
 *  - Joystick derecho: ←/→ giro por pasos de 30°, ↑/↓ subir/bajar.
 *  - Gatillo (cualquier mando): apuntar con el láser y soltar para teletransportarse al punto.
 *  - Botón lateral (grip): ×4 velocidad.
 */
export type VRState = "unsupported" | "available" | "active";

const DEADZONE = 0.18;
const SNAP_DEG = 30;
const EYE_HEIGHT = 1.6;

type Hand = {
  controller: THREE.Group;
  ray: THREE.Line;
  handedness: XRHandedness | "";
  source: XRInputSource | null;
  triggerDown: boolean;
  aimAt: number;
};

export class VRMode {
  state: VRState = "unsupported";
  onStateChange: ((s: VRState) => void) | null = null;
  /** Último resultado de teletransporte (para pruebas/diagnóstico). */
  lastTeleport: number[] | null = null;
  /** Último punto del modelo alcanzado por el láser y origen del rayo (pruebas/diagnóstico). */
  lastHit: { point: number[]; origin: number[]; dir: number[] } | null = null;
  private session: XRSession | null = null;
  private rig = new THREE.Group();
  private hands: Hand[] = [];
  private marker: THREE.Mesh;
  private target: THREE.Vector3 | null = null;
  private aimBusy = false;
  private snapReady = true;
  private lastTime = 0;
  private lastFragUpdate = 0;
  private frame = 0;
  private moved = false;
  private savedParent: THREE.Object3D | null = null;
  private helperCam = new THREE.PerspectiveCamera(5, 1, 0.05, 5000);

  constructor(
    private world: OBC.SimpleWorld<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>,
    private components: OBC.Components,
    private fragments: OBC.FragmentsManager,
    private nav: Navigator,
    private env: Environment,
  ) {
    this.rig.name = "visor-vr-rig";
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.18, 0.26, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true, opacity: 0.9 }),
    );
    this.marker.name = "visor-vr-marker";
    this.marker.renderOrder = 999;
    this.marker.visible = false;
  }

  /** Comprueba si el navegador tiene gafas WebXR disponibles. */
  async detect() {
    let ok = false;
    try {
      ok = !!navigator.xr && (await navigator.xr.isSessionSupported("immersive-vr"));
    } catch {
      ok = false;
    }
    this.setState(this.session ? "active" : ok ? "available" : "unsupported");
    if (navigator.xr && !this.listening) {
      this.listening = true;
      navigator.xr.addEventListener("devicechange", () => void this.detect());
    }
    return ok;
  }
  private listening = false;

  private setState(s: VRState) {
    this.state = s;
    this.onStateChange?.(s);
  }

  /** Entra en VR (debe llamarse desde un clic del usuario). */
  async enter() {
    if (this.session) return;
    if (!navigator.xr) throw new Error("Este navegador no tiene WebXR.");
    const session = await navigator.xr.requestSession("immersive-vr", {
      optionalFeatures: ["local-floor", "bounded-floor"],
    });
    const renderer = this.world.renderer!.three;
    const camera = this.world.camera.three as THREE.PerspectiveCamera;
    const scene = this.world.scene.three;

    // Pose inicial: los ojos donde estaba la cámara, mirando en la misma dirección (solo giro horizontal).
    const pos = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    this.rig.position.set(pos.x, pos.y - EYE_HEIGHT, pos.z);
    this.rig.rotation.set(0, Math.atan2(-dir.x, -dir.z), 0);
    scene.add(this.rig);
    this.savedParent = camera.parent;
    this.rig.add(camera);
    camera.position.set(0, EYE_HEIGHT, 0);
    camera.quaternion.identity();
    this.rig.add(this.marker);
    this.setupHands(renderer);

    // Parar el bucle de That Open: three lleva el ritmo de las gafas.
    this.nav.enabled = false;
    this.world.camera.controls.enabled = false;
    this.components.enabled = false;

    renderer.xr.enabled = true;
    try {
      renderer.xr.setReferenceSpaceType("local-floor");
      await renderer.xr.setSession(session);
    } catch {
      // Sin «local-floor» (p. ej. algunos runtimes): espacio «local» y los ojos a la altura de la cámara.
      renderer.xr.setReferenceSpaceType("local");
      this.rig.position.y = pos.y;
      await renderer.xr.setSession(session);
    }
    this.session = session;
    session.addEventListener("end", this.onEnd, { once: true });
    this.lastTime = performance.now();
    renderer.setAnimationLoop(this.loop);
    this.setState("active");
  }

  async exit() {
    await this.session?.end().catch(() => this.onEnd());
  }

  get active() {
    return !!this.session;
  }

  /** Posición de los ojos en el mundo (pruebas/diagnóstico). */
  eyePosition() {
    return this.world.camera.three.getWorldPosition(new THREE.Vector3()).toArray();
  }

  /** Giro horizontal del grupo de cámara en grados (pruebas/diagnóstico). */
  rigYaw() {
    // Desde el cuaternión: rotation.y (Euler) salta de representación pasados ±90°.
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.rig.quaternion);
    return THREE.MathUtils.radToDeg(Math.atan2(-f.x, -f.z));
  }

  private setupHands(renderer: THREE.WebGLRenderer) {
    if (this.hands.length) return;
    for (let i = 0; i < 2; i++) {
      const controller = renderer.xr.getController(i);
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
      const ray = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.8 }));
      ray.name = "visor-vr-ray";
      ray.scale.z = 3;
      ray.visible = false;
      controller.add(ray);
      const hand: Hand = { controller, ray, handedness: "", source: null, triggerDown: false, aimAt: 0 };
      controller.addEventListener("connected", (e) => {
        const src = (e as unknown as { data: XRInputSource }).data;
        hand.source = src;
        hand.handedness = src.handedness;
        ray.visible = src.targetRayMode === "tracked-pointer";
      });
      controller.addEventListener("disconnected", () => {
        hand.source = null;
        ray.visible = false;
      });
      this.hands.push(hand);
    }
    for (const h of this.hands) this.rig.add(h.controller);
  }

  private loop = (time: number) => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.locomotion(dt);
    this.updateAim(now);

    // Fragments decide qué piezas y con qué detalle dibujar según la cámara: se le avisa al moverse.
    if (now - this.lastFragUpdate > (this.moved ? 120 : 600)) {
      this.lastFragUpdate = now;
      this.moved = false;
      void this.fragments.core.update(true);
    }
    if (this.frame++ % 30 === 0) this.env.markShadows();
    const renderer = this.world.renderer!.three;
    renderer.render(this.world.scene.three, this.world.camera.three);
    void time;
  };

  private gamepad(hand: XRHandedness) {
    return this.hands.find((h) => h.handedness === hand)?.source?.gamepad ?? null;
  }

  private locomotion(dt: number) {
    const left = this.gamepad("left");
    const right = this.gamepad("right");
    const camera = this.world.camera.three;
    // Mandos con mapeo «xr-standard»: axes[2], axes[3] = joystick; buttons[1] = grip.
    const fast = (left?.buttons[1]?.value ?? 0) > 0.5 || (right?.buttons[1]?.value ?? 0) > 0.5;
    // Velocidad de paseo cómoda en VR (1,5–6 m/s según el tamaño del modelo y el selector +/−), ×4 con grip.
    const speed = THREE.MathUtils.clamp(this.nav.baseSpeed * 0.35, 1.5, 6) * (fast ? 4 : 1);

    const lx = dz(left?.axes[2] ?? 0);
    const ly = dz(left?.axes[3] ?? 0);
    if (lx || ly) {
      const fwd = camera.getWorldDirection(new THREE.Vector3());
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      const rightV = new THREE.Vector3(-fwd.z, 0, fwd.x);
      this.rig.position.addScaledVector(fwd, -ly * speed * dt).addScaledVector(rightV, lx * speed * dt);
      this.moved = true;
    }

    const rx = right?.axes[2] ?? 0;
    const ry = dz(right?.axes[3] ?? 0);
    if (ry) {
      this.rig.position.y += -ry * speed * 0.6 * dt;
      this.moved = true;
    }
    // Giro por pasos alrededor de la cabeza (evita mareo frente al giro continuo).
    if (Math.abs(rx) > 0.7 && this.snapReady) {
      this.snapReady = false;
      this.snapTurn(rx > 0 ? -SNAP_DEG : SNAP_DEG);
    } else if (Math.abs(rx) < 0.3) {
      this.snapReady = true;
    }
  }

  private snapTurn(deg: number) {
    const head = this.world.camera.three.getWorldPosition(new THREE.Vector3());
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
    this.rig.position.sub(head).applyQuaternion(q).add(head);
    this.rig.quaternion.premultiply(q);
    this.moved = true;
  }

  /** Gatillo: apuntar (láser + marca) y al soltar, teletransporte. */
  private updateAim(now: number) {
    for (const h of this.hands) {
      const pressed = (h.source?.gamepad?.buttons[0]?.value ?? 0) > 0.5;
      if (pressed && !h.triggerDown) {
        h.triggerDown = true;
        this.target = null;
      }
      if (pressed && !this.aimBusy && now - h.aimAt > 90) {
        h.aimAt = now;
        void this.aim(h);
      }
      if (!pressed && h.triggerDown) {
        h.triggerDown = false;
        if (this.target) this.teleport(this.target);
        this.target = null;
        this.marker.visible = false;
        h.ray.scale.z = 3;
      }
    }
  }

  private async aim(h: Hand) {
    const model = [...this.fragments.list.values()][0] as FRAGS.FragmentsModel | undefined;
    if (!model) return;
    this.aimBusy = true;
    try {
      // Rayo desde el mando: una cámara auxiliar con la pose del mando y el «ratón» en el centro del lienzo.
      const c = this.helperCam;
      h.controller.updateMatrixWorld(true);
      h.controller.matrixWorld.decompose(c.position, c.quaternion, new THREE.Vector3());
      const dom = this.world.renderer!.three.domElement;
      const r = dom.getBoundingClientRect();
      c.aspect = r.width / Math.max(1, r.height);
      c.updateProjectionMatrix();
      c.updateMatrixWorld(true);
      const hit = await model.raycast({ camera: c, mouse: new THREE.Vector2(r.left + r.width / 2, r.top + r.height / 2), dom });
      if (!h.triggerDown) return;
      if (!hit) {
        this.target = null;
        this.marker.visible = false;
        h.ray.scale.z = 30;
        return;
      }
      const p = hit.point.clone();
      this.lastHit = { point: p.toArray(), origin: c.position.toArray(), dir: c.getWorldDirection(new THREE.Vector3()).toArray() };
      const n = hit.normal?.clone().transformDirection(hit.object.matrixWorld) ?? new THREE.Vector3(0, 1, 0);
      const origin = c.position.clone();
      h.ray.scale.z = origin.distanceTo(p);
      if (n.y < 0.6) {
        // Pared o techo: se queda delante, sin atravesarla, a la altura de los pies actual.
        p.addScaledVector(origin.clone().sub(p).setY(0).normalize(), 0.5);
        p.y = this.rig.position.y;
      }
      this.target = p;
      this.marker.visible = true;
      this.marker.position.copy(this.rig.worldToLocal(p.clone())).add(new THREE.Vector3(0, 0.02, 0));
    } catch {
      this.target = null;
    } finally {
      this.aimBusy = false;
    }
  }

  /** Lleva los pies (el centro del área de juego bajo la cabeza) al punto. */
  private teleport(p: THREE.Vector3) {
    const head = this.world.camera.three.getWorldPosition(new THREE.Vector3());
    const offset = new THREE.Vector3(head.x - this.rig.position.x, 0, head.z - this.rig.position.z);
    this.rig.position.set(p.x - offset.x, p.y, p.z - offset.z);
    this.lastTeleport = p.toArray();
    this.moved = true;
  }

  private onEnd = () => {
    if (!this.session) return;
    this.session = null;
    const renderer = this.world.renderer!.three;
    renderer.setAnimationLoop(null);
    renderer.xr.enabled = false;
    const camera = this.world.camera.three as THREE.PerspectiveCamera;
    // Volver a la vista normal donde estaba el usuario en VR, mirando hacia donde miraba.
    const pos = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    if (this.savedParent) this.savedParent.add(camera);
    else this.rig.remove(camera);
    camera.position.copy(pos);
    this.rig.removeFromParent();
    this.marker.visible = false;
    this.target = null;
    for (const h of this.hands) h.triggerDown = false;
    // three restaura tamaño y proyección del lienzo; se recalcula por si acaso.
    const r = renderer.domElement.getBoundingClientRect();
    if (r.width && r.height) {
      camera.aspect = r.width / r.height;
      camera.updateProjectionMatrix();
    }
    const t = pos.clone().addScaledVector(dir, 0.01);
    this.world.camera.controls.enabled = true;
    void this.world.camera.controls.setLookAt(pos.x, pos.y, pos.z, t.x, t.y, t.z, false);
    this.components.enabled = true;
    // Reanuda el bucle de That Open (update es privado pero es el mismo que arranca init()).
    (this.components as unknown as { update: () => void }).update();
    this.nav.enabled = true;
    void this.fragments.core.update(true);
    void this.detect();
  };

  dispose() {
    void this.exit();
    for (const h of this.hands) {
      h.ray.geometry.dispose();
      (h.ray.material as THREE.Material).dispose();
    }
    this.marker.geometry.dispose();
    (this.marker.material as THREE.Material).dispose();
  }
}

const dz = (v: number) => (Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE));
