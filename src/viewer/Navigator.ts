import * as THREE from "three";
import * as OBC from "@thatopen/components";
import CameraControls from "camera-controls";

/**
 * Navegación tipo Revizto sobre los camera-controls de That Open.
 *
 * Modo «Recorrido» (fly, por defecto):
 *   W/S adelante/atrás según la vista · A/D lateral · E sube · Q baja · Shift ×4
 *   (también flechas) · arrastrar con botón izquierdo = mirar alrededor ·
 *   arrastrar con botón derecho o central = desplazar · rueda = acercarse/alejarse
 *   hacia el punto bajo el cursor.
 * Modo «Órbita»: botón izquierdo orbita alrededor del punto del modelo bajo el
 *   centro de la vista; derecho desplaza; rueda acerca hacia el cursor. WASD/QE también funcionan.
 *
 * En Recorrido el objetivo de camera-controls se mantiene a EPS de la cámara para
 * que todo giro sea un giro sobre sí misma; el ratón se gestiona aquí directamente.
 */
export type NavMode = "fly" | "orbit";

const EPS = 0.01; // m: distancia cámara→objetivo en Recorrido
const SPEED_LEVELS = [0.125, 0.25, 0.5, 1, 2, 4, 8];
const LOOK_SENS = 0.0035; // rad por píxel
const MOVE_KEYS: Record<string, [number, number, number]> = {
  // [adelante, derecha, arriba]
  KeyW: [1, 0, 0], ArrowUp: [1, 0, 0],
  KeyS: [-1, 0, 0], ArrowDown: [-1, 0, 0],
  KeyD: [0, 1, 0], ArrowRight: [0, 1, 0],
  KeyA: [0, -1, 0], ArrowLeft: [0, -1, 0],
  KeyE: [0, 0, 1],
  KeyQ: [0, 0, -1],
};

export type NavState = { mode: NavMode; speedMultiplier: number };

export class Navigator {
  mode: NavMode = "fly";
  private speedIndex = 3;
  private modelDiag = 50;
  private keys = new Map<string, number>(); // tecla → instante en que se pulsó
  private shift = false;
  private raf = 0;
  private lastFrame = 0;
  private drag: null | { button: number; x: number; y: number; depth: number; id: number } = null;
  private wheelAccum = 0;
  private wheelBusy = false;
  private wheelPos = new THREE.Vector2();
  private ac: AbortController | null = null;
  enabled = false; // solo con un modelo cargado

  constructor(
    private world: OBC.SimpleWorld<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>,
    private components: OBC.Components,
    private onChange?: (s: NavState) => void,
  ) {}

  private get controls(): CameraControls {
    return this.world.camera.controls;
  }
  private get camera() {
    return this.world.camera.three as THREE.PerspectiveCamera;
  }
  private get dom() {
    return this.world.renderer!.three.domElement;
  }

  /** Posición/dirección finales (para pruebas y diagnóstico). */
  debugPose() {
    const { pos, dir } = this.pose();
    return { pos: pos.toArray(), dir: dir.toArray(), speed: this.baseSpeed };
  }

  get state(): NavState {
    return { mode: this.mode, speedMultiplier: SPEED_LEVELS[this.speedIndex] };
  }

  /** Velocidad base en m/s según el tamaño del modelo. */
  get baseSpeed() {
    return THREE.MathUtils.clamp(this.modelDiag * 0.06, 0.8, 40) * SPEED_LEVELS[this.speedIndex];
  }

  attach() {
    this.ac = new AbortController();
    const o = { signal: this.ac.signal };
    const dom = this.dom;
    dom.addEventListener("pointerdown", this.onPointerDown, o);
    dom.addEventListener("pointermove", this.onPointerMove, o);
    dom.addEventListener("pointerup", this.onPointerUp, o);
    dom.addEventListener("pointercancel", this.onPointerUp, o);
    dom.addEventListener("wheel", this.onWheel, { ...o, passive: false });
    dom.addEventListener("contextmenu", (e) => e.preventDefault(), o);
    window.addEventListener("keydown", this.onKeyDown, o);
    window.addEventListener("keyup", this.onKeyUp, o);
    window.addEventListener("blur", () => this.keys.clear(), o);
    this.applyMode();
  }

  detach() {
    this.ac?.abort();
    this.ac = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.keys.clear();
  }

  setModelBounds(box: THREE.Box3 | null) {
    const size = box && !box.isEmpty() ? box.getSize(new THREE.Vector3()).length() : 50;
    this.modelDiag = Math.max(size, 1);
    this.controls.maxDistance = Math.max(this.modelDiag * 10, 1000);
  }

  setSpeed(delta: number) {
    this.speedIndex = THREE.MathUtils.clamp(this.speedIndex + delta, 0, SPEED_LEVELS.length - 1);
    this.emit();
  }

  async setMode(mode: NavMode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === "orbit") {
      // Pivote: lo que hay en el centro de la pantalla, o el centro de la vista a media distancia.
      const hit = await this.pick(new THREE.Vector2(0, 0));
      const { pos, dir } = this.pose();
      const pivot = hit ? hit.point : pos.clone().addScaledVector(dir, this.modelDiag * 0.3);
      this.applyMode();
      await this.controls.setLookAt(pos.x, pos.y, pos.z, pivot.x, pivot.y, pivot.z, false);
    } else {
      this.applyMode();
      this.collapseTarget(false);
    }
    this.emit();
  }

  /** Ejecuta un encuadre de That Open (fitToItems) y deja la cámara lista para el modo actual. */
  async fit(run: () => Promise<void>) {
    this.controls.minDistance = 0;
    await run();
    if (this.mode === "fly") this.collapseTarget(true);
    else this.controls.minDistance = 0.05;
  }

  private emit() {
    this.onChange?.(this.state);
  }

  private applyMode() {
    const c = this.controls;
    const A = CameraControls.ACTION;
    if (this.mode === "fly") {
      c.mouseButtons.left = A.NONE;
      c.mouseButtons.right = A.NONE;
      c.mouseButtons.middle = A.NONE;
      c.mouseButtons.wheel = A.NONE;
      c.minDistance = 0;
    } else {
      c.mouseButtons.left = A.ROTATE;
      c.mouseButtons.right = A.TRUCK;
      c.mouseButtons.middle = A.TRUCK;
      c.mouseButtons.wheel = A.DOLLY;
      c.dollyToCursor = true;
      c.minDistance = 0.05;
      c.truckSpeed = 2;
    }
  }

  /** Posición y dirección finales de la cámara (incluye transiciones en curso). */
  private pose() {
    const pos = this.controls.getPosition(new THREE.Vector3(), true);
    const target = this.controls.getTarget(new THREE.Vector3(), true);
    const dir = target.clone().sub(pos);
    if (dir.lengthSq() < 1e-12) this.camera.getWorldDirection(dir);
    return { pos, target, dir: dir.normalize() };
  }

  private collapseTarget(smooth: boolean) {
    const { pos, dir } = this.pose();
    const t = pos.clone().addScaledVector(dir, EPS);
    void this.controls.setLookAt(pos.x, pos.y, pos.z, t.x, t.y, t.z, smooth);
  }

  /** Mueve cámara y objetivo juntos (traslación pura). */
  private translate(delta: THREE.Vector3, smooth = false) {
    const { pos, target } = this.pose();
    pos.add(delta);
    target.add(delta);
    return this.controls.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, smooth);
  }

  private ndc(e: { clientX: number; clientY: number }) {
    const r = this.dom.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private async pick(ndc: THREE.Vector2): Promise<{ point: THREE.Vector3; distance: number } | null> {
    try {
      const caster = this.components.get(OBC.Raycasters).get(this.world);
      const hit = (await caster.castRay({ position: ndc })) as { point?: THREE.Vector3 } | null;
      if (!hit?.point) return null;
      return { point: hit.point.clone(), distance: hit.point.distanceTo(this.camera.position) };
    } catch {
      return null;
    }
  }

  // ---------------- Teclado ----------------
  private isTyping(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    this.shift = e.shiftKey;
    if (!this.enabled || this.isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code in MOVE_KEYS) {
      e.preventDefault();
      if (!this.keys.has(e.code)) this.keys.set(e.code, performance.now()); // ignora autorrepetición
      this.startLoop();
    } else if (e.key === "+" || e.code === "NumpadAdd") {
      this.setSpeed(1);
    } else if (e.key === "-" || e.code === "NumpadSubtract") {
      this.setSpeed(-1);
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    const pressedAt = this.keys.get(e.code);
    if (pressedAt !== undefined) {
      // Aplica el tramo pendiente de esta tecla: aunque se pulse y suelte dentro
      // de un mismo fotograma (equipos lentos), el recorrido = tiempo pulsada × velocidad.
      const now = performance.now();
      this.move([[e.code, now - Math.max(this.lastFrame, pressedAt)]]);
      this.keys.delete(e.code);
    }
    this.shift = e.shiftKey;
  };

  /** Movimiento por tiempo real de pulsación: [tecla, milisegundos]. */
  private move(entries: [string, number][]) {
    let f = 0, r = 0, u = 0, nf = 0, nr = 0, nu = 0;
    for (const [code, ms] of entries) {
      const t = THREE.MathUtils.clamp(ms, 0, 250) / 1000; // límite: evita saltos tras pausas
      const [a, b, c] = MOVE_KEYS[code];
      f += a * t; r += b * t; u += c * t;
      nf += a; nr += b; nu += c;
    }
    if (!f && !r && !u) return;
    const { dir } = this.pose();
    const up = new THREE.Vector3(0, 1, 0);
    const right = dir.clone().cross(up);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    right.normalize();
    // En diagonal (p. ej. W+D) no se va más rápido que en línea recta.
    const norm = Math.max(1, Math.hypot(nf, nr, nu));
    const move = dir.multiplyScalar(f).addScaledVector(right, r).addScaledVector(up, u);
    void this.translate(move.multiplyScalar((this.baseSpeed * (this.shift ? 4 : 1)) / norm));
  }

  private startLoop() {
    if (this.raf) return;
    this.lastFrame = performance.now();
    const step = (now: number) => {
      if (this.keys.size === 0 || !this.enabled) {
        this.raf = 0;
        this.lastFrame = now;
        return;
      }
      this.move([...this.keys].map(([code, pressedAt]) => [code, now - Math.max(this.lastFrame, pressedAt)]));
      this.lastFrame = now;
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  // ---------------- Ratón (modo Recorrido) ----------------
  private onPointerDown = (e: PointerEvent) => {
    if (!this.enabled || this.mode !== "fly" || this.drag) return;
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    this.drag = { button: e.button, x: e.clientX, y: e.clientY, depth: this.modelDiag * 0.3, id: e.pointerId };
    this.dom.setPointerCapture?.(e.pointerId);
    if (e.button !== 0) {
      // Para desplazar, la escala depende de la profundidad del punto agarrado.
      const d = this.drag;
      void this.pick(this.ndc(e)).then((hit) => {
        if (hit && this.drag === d) d.depth = Math.max(hit.distance, 0.5);
      });
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id || this.mode !== "fly") return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!dx && !dy) return;
    const { pos, dir } = this.pose();
    if (d.button === 0) {
      // Mirar alrededor: arrastrar a la derecha = mirar a la derecha.
      const yaw = Math.atan2(dir.x, dir.z) - dx * LOOK_SENS;
      const pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)) - dy * LOOK_SENS, -1.55, 1.55);
      const nd = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      const t = pos.clone().addScaledVector(nd, EPS);
      void this.controls.setLookAt(pos.x, pos.y, pos.z, t.x, t.y, t.z, false);
    } else {
      // Desplazar: el punto agarrado sigue al cursor.
      const h = this.dom.clientHeight || 1;
      const wpp = (2 * d.depth * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      void this.translate(right.multiplyScalar(-dx * wpp).addScaledVector(up, dy * wpp));
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.drag && e.pointerId === this.drag.id) {
      this.dom.releasePointerCapture?.(e.pointerId);
      this.drag = null;
    }
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled || this.mode !== "fly") return;
    e.preventDefault();
    // Normaliza: un «clic» de rueda ≈ 1
    const unit = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 3 : 1 / 100;
    this.wheelAccum += -e.deltaY * unit;
    this.wheelPos.copy(this.ndc(e));
    if (!this.wheelBusy) void this.flushWheel();
  };

  private async flushWheel() {
    this.wheelBusy = true;
    try {
      while (Math.abs(this.wheelAccum) > 1e-3) {
        const ndc = this.wheelPos.clone();
        const hit = await this.pick(ndc);
        const steps = THREE.MathUtils.clamp(this.wheelAccum, -5, 5);
        this.wheelAccum = 0;
        // Dirección: rayo de la cámara hacia el cursor.
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.camera);
        const dist = hit ? hit.distance : this.modelDiag * 0.25;
        // Cada paso recorre el 25 % de la distancia al punto (nunca lo atraviesa al acercarse).
        const amount =
          steps > 0
            ? dist * (1 - Math.pow(0.75, steps))
            : -Math.max(dist, this.modelDiag * 0.05) * (Math.pow(1 / 0.75, -steps) - 1);
        // No se espera a que termine la transición: si otro giro de rueda la interrumpe,
        // su promesa podría no resolverse nunca y la rueda quedaría bloqueada.
        void this.translate(ray.ray.direction.clone().multiplyScalar(amount), true);
      }
    } finally {
      this.wheelBusy = false;
    }
  }
}
