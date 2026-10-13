import * as THREE from "three";
import * as OBC from "@thatopen/components";
import * as OBF from "@thatopen/components-front";
import type * as FRAGS from "@thatopen/fragments";
// El worker de Fragments se sirve desde node_modules (no desde unpkg).
// `?url` hace que Vite lo copie como recurso y devuelva su URL final.
import fragmentsWorkerUrl from "@thatopen/fragments/worker?url";
import { parseItemData, readProjectUnits, type ElementInfo, type ProjectUnits } from "./properties";
import { Navigator, type NavMode, type NavState } from "./Navigator";
import { Appearance } from "../render/Appearance";
import { Environment, type EnvSettings } from "../render/Environment";
import { VRMode } from "./VR";
import { Ghost } from "../render/Ghost";

export type LoadProgress = {
  /** 0..1 */
  value: number;
  stage: string;
};

export type ViewerEvents = {
  onSelectionChange?: (info: ElementInfo | null, count: number) => void;
  onVisibilityChange?: (state: VisibilityState) => void;
  onNavChange?: (state: NavState) => void;
  /** Antes de cerrar el modelo (las herramientas de análisis liberan sus datos). */
  onModelClosing?: () => void;
};

export type VisibilityState = "all" | "partial" | "isolated";

const SELECT_STYLE = "select";

/** Datos de un elemento para el panel de información (y la comparación de versiones). */
export const ELEMENT_DATA_CONFIG: Partial<FRAGS.ItemsDataConfig> = {
  attributesDefault: true,
  // Verificado con un IFC real de Revit: el importador de Fragments "aplana"
  // IsDefinedBy, que contiene directamente los IfcPropertySet/IfcElementQuantity
  // y también el objeto de tipo (p. ej. IFCBEAMTYPE) con sus HasPropertySets.
  // La configuración de relaciones se aplica por nombre a cualquier profundidad.
  relations: {
    IsDefinedBy: { attributes: true, relations: true },
    IsTypedBy: { attributes: true, relations: true }, // otros importadores / IFC4
    HasPropertySets: { attributes: true, relations: true }, // Psets del tipo
    HasProperties: { attributes: true, relations: false },
    Quantities: { attributes: true, relations: false },
    HasAssociations: { attributes: true, relations: false }, // materiales
    ContainedInStructure: { attributes: true, relations: false }, // nivel / planta
    Decomposes: { attributes: true, relations: false }, // conjunto al que pertenece
    // Relaciones inversas que llevarían a TODAS las instancias del tipo/pset
    ObjectTypeOf: { attributes: false, relations: false },
    DefinesOcurrence: { attributes: false, relations: false },
    DefinesOccurrence: { attributes: false, relations: false },
    Types: { attributes: false, relations: false },
    RepresentationMaps: { attributes: false, relations: false },
  },
  relationsDefault: { attributes: false, relations: false },
};

/** Etiquetas legibles para las fases que informa el importador IFC. */
const STAGE_LABEL: Record<FRAGS.ProgressData["process"], string> = {
  geometries: "Procesando geometría",
  attributes: "Leyendo atributos",
  relations: "Leyendo relaciones y propiedades",
  conversion: "Convirtiendo a Fragments",
};

/**
 * Encapsula todo el motor 3D (That Open Components + Fragments + web-ifc).
 * Debe existir UNA sola instancia por página: main.ts la crea una vez y la
 * libera con dispose() en recargas en caliente (HMR) o al salir.
 */
export class Viewer {
  readonly components = new OBC.Components();
  private world!: OBC.SimpleWorld<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>;
  private fragments!: OBC.FragmentsManager;
  private ifcLoader!: OBC.IfcLoader;
  private highlighter!: OBF.Highlighter;
  private hider!: OBC.Hider;
  nav!: Navigator;
  appearance!: Appearance;
  env!: Environment;
  vr!: VRMode;
  private ghost!: Ghost;
  private focusActive = false;
  private units: ProjectUnits = {};
  private currentModelId: string | null = null;
  private loading = false;
  private disposed = false;
  private selectionRequest = 0;
  private visibility: VisibilityState = "all";

  constructor(private container: HTMLElement, private events: ViewerEvents = {}) {}

  async init() {
    const worlds = this.components.get(OBC.Worlds);
    this.world = worlds.create<OBC.SimpleScene, OBC.OrthoPerspectiveCamera, OBC.SimpleRenderer>();
    this.world.scene = new OBC.SimpleScene(this.components);
    this.world.scene.setup();
    this.world.scene.three.background = new THREE.Color(0x1b1f24);
    this.world.renderer = new OBC.SimpleRenderer(this.components, this.container);
    this.world.camera = new OBC.OrthoPerspectiveCamera(this.components);
    await this.world.camera.controls.setLookAt(30, 25, 30, 0, 0, 0);
    this.components.init();

    const grid = this.components.get(OBC.Grids).create(this.world);
    this.components.get(OBC.Raycasters).get(this.world);

    // --- Fragments (worker local) ---
    this.fragments = this.components.get(OBC.FragmentsManager);
    this.fragments.init(fragmentsWorkerUrl);
    this.world.camera.controls.addEventListener("update", this.onCameraUpdate);
    this.fragments.list.onItemSet.add(({ value: model }) => {
      model.useCamera(this.world.camera.three);
      this.world.scene.three.add(model.object);
      this.fragments.core.update(true);
    });
    // Reduce el parpadeo (z-fighting) entre caras coplanares, como indica la doc oficial.
    // Excepción verificada en pruebas: el material de selección debe ir SIEMPRE delante;
    // con un desfase aleatorio, a veces quedaba detrás de una cara coplanar y el
    // elemento seleccionado no se veía resaltado.
    this.fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
      if ("isLodMaterial" in material && material.isLodMaterial) return;
      material.polygonOffset = true;
      const customId: string | undefined = material.userData?.customId;
      if (customId === SELECT_STYLE) {
        material.polygonOffsetFactor = -2;
        material.polygonOffsetUnits = -2;
      } else if (customId) {
        // Cualquier estilo (apariencias «mat:*» de la vista realista) va delante de la base.
        // Fragments dibuja los elementos resaltados sobre la geometría base en la misma posición;
        // con el desfase aleatorio, en ~la mitad de las cargas ganaba la base y el núcleo/losas
        // se veían sin textura (causa verificada ocultando el material base).
        material.polygonOffsetFactor = -1;
        material.polygonOffsetUnits = -1;
      } else {
        material.polygonOffsetUnits = 1;
        material.polygonOffsetFactor = Math.random();
      }
    });

    // --- web-ifc (WASM local en /wasm/, copiado por scripts/copy-wasm.mjs) ---
    this.ifcLoader = this.components.get(OBC.IfcLoader);
    await this.ifcLoader.setup({
      autoSetWasm: false, // si fuera true, descargaría el WASM desde unpkg
      wasm: { path: `${import.meta.env.BASE_URL}wasm/`, absolute: true },
    });

    // --- Selección ---
    this.highlighter = this.components.get(OBF.Highlighter);
    this.highlighter.setup({
      world: this.world,
      selectName: SELECT_STYLE,
      selectMaterialDefinition: {
        color: new THREE.Color("#ffb020"),
        opacity: 1,
        transparent: false,
        renderedFaces: 0,
      },
    });
    this.highlighter.zoomToSelection = false;
    this.highlighter.events[SELECT_STYLE].onHighlight.add((map) => void this.handleSelection(map));
    this.highlighter.events[SELECT_STYLE].onClear.add(() => {
      this.selectionRequest++;
      this.events.onSelectionChange?.(null, 0);
      this.refreshTilesSoon();
    });
    this.highlighter.events[SELECT_STYLE].onHighlight.add(() => this.refreshTilesSoon());

    this.hider = this.components.get(OBC.Hider);

    // --- Apariencia realista (materiales PBR + texturas) y entorno (cielo, sol, sombras) ---
    this.appearance = new Appearance(this.fragments, this.highlighter);
    this.appearance.install(); // antes de cargar modelos: intercepta la creación de materiales
    this.env = new Environment(this.world, grid);

    // --- Navegación tipo Revizto (WASD/QE, mirar con el ratón, rueda hacia el cursor) ---
    this.nav = new Navigator(this.world, this.components, (s) => this.events.onNavChange?.(s));
    this.nav.attach();

    this.ghost = new Ghost(this.world.scene.three);

    // --- Realidad virtual (WebXR) ---
    this.vr = new VRMode(this.world, this.components, this.fragments, this.nav, this.env);
  }

  /**
   * Tras seleccionar/deseleccionar, el Highlighter repinta con updateColors, que actualiza las mallas
   * de Fragments en paralelo con los highlight (no después). Una actualización posterior asegura que
   * la apariencia de debajo (vista realista) se restaura sin tener que mover la cámara.
   */
  private refreshTimer = 0;
  private refreshTilesSoon() {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      if (this.fragments?.initialized && !this.disposed) void this.fragments.core.update(true);
    }, 120);
  }

  private onCameraUpdate = () => {
    if (this.fragments?.initialized) this.fragments.core.update();
  };

  get hasModel() {
    return this.currentModelId !== null;
  }

  get isLoading() {
    return this.loading;
  }

  /** Carga un IFC local. Todo el proceso ocurre en el navegador. */
  async loadIfc(file: File, onProgress: (p: LoadProgress) => void) {
    if (this.loading) throw new UserError("Ya se está cargando un modelo. Espera a que termine.");
    this.loading = true;
    try {
      onProgress({ value: 0, stage: "Leyendo archivo" });
      const bytes = new Uint8Array(await file.arrayBuffer());
      validateIfcBytes(file.name, bytes);

      // Primera fase: un solo modelo a la vez.
      if (this.currentModelId) await this.closeModel();

      const modelId = `${file.name.replace(/\.ifc$/i, "")}-${Date.now()}`;
      const model = await this.ifcLoader.load(bytes, true, modelId, {
        processData: {
          progressCallback: (value, data) => {
            onProgress({ value: Math.min(0.95, value * 0.95), stage: STAGE_LABEL[data.process] ?? "Procesando" });
          },
        },
      });
      this.currentModelId = model.modelId;
      this.units = await readProjectUnits(model).catch(() => ({}));
      this.nav.setModelBounds(model.box);
      this.env.setModelBounds(model.box);
      this.nav.enabled = true;
      onProgress({ value: 0.97, stage: "Preparando vista" });
      await this.fragments.core.update(true);
      await this.fitAll();
      this.setVisibility("all");
      // Agrupar por material IFC (para el panel Materiales) sin retrasar la apertura.
      void this.appearance.analyze(model).catch((e) => console.warn("No se pudieron agrupar los materiales", e));
      onProgress({ value: 1, stage: "Modelo cargado" });
      return { modelId: model.modelId, name: file.name };
    } catch (err) {
      throw toUserError(err);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Abre un modelo ya convertido a Fragments (lo usa la vista VR en el navegador, que recibe
   * el modelo de la app de escritorio sin volver a procesar el IFC).
   */
  async loadFragments(buffer: ArrayBuffer, name: string, step: (s: string) => void = () => {}) {
    if (this.loading) throw new UserError("Ya se está cargando un modelo. Espera a que termine.");
    this.loading = true;
    try {
      if (this.currentModelId) await this.closeModel();
      const modelId = `${name.replace(/\.ifc$/i, "")}-${Date.now()}`;
      step("fragments.load");
      const model = await this.fragments.core.load(buffer, { modelId, camera: this.world.camera.three });
      this.currentModelId = model.modelId;
      step("unidades");
      this.units = await readProjectUnits(model).catch(() => ({}));
      this.nav.setModelBounds(model.box);
      this.env.setModelBounds(model.box);
      this.nav.enabled = true;
      step("update");
      await this.fragments.core.update(true);
      step("encuadre");
      await this.fitAll();
      this.setVisibility("all");
      step("materiales");
      await this.appearance.analyze(model).catch((e) => console.warn("No se pudieron agrupar los materiales", e));
      return { modelId: model.modelId, name };
    } catch (err) {
      throw toUserError(err);
    } finally {
      this.loading = false;
    }
  }

  /**
   * Carga OTRA versión del IFC como modelo auxiliar (comparación). Se procesa igual (local) y
   * empieza oculto; quien lo carga decide qué mostrar y debe liberarlo con disposeAux().
   */
  async loadAuxIfc(file: File, onProgress: (p: LoadProgress) => void) {
    if (this.loading) throw new UserError("Ya se está cargando un modelo. Espera a que termine.");
    this.loading = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      validateIfcBytes(file.name, bytes);
      const id = `aux-${file.name.replace(/\.ifc$/i, "")}-${Date.now()}`;
      const model = await this.ifcLoader.load(bytes, true, id, {
        processData: { progressCallback: (value, data) => onProgress({ value: Math.min(0.95, value * 0.95), stage: STAGE_LABEL[data.process] ?? "Procesando" }) },
      });
      model.object.visible = false;
      await this.fragments.core.update(true);
      return model;
    } catch (err) {
      throw toUserError(err);
    } finally {
      this.loading = false;
    }
  }

  async disposeAux(model: FRAGS.FragmentsModel) {
    this.auxVisible.delete(model);
    for (const [name, map] of Object.entries(this.highlighter.selection)) {
      if (map[model.modelId]) await this.highlighter.clear(name);
    }
    await this.fragments.core.disposeModel(model.modelId);
    this.ifcLoader.cleanUp();
    await this.fragments.core.update(true);
  }

  /** Colorea elementos de un modelo auxiliar (estilo propio, prioridad de análisis). */
  async paintAux(model: FRAGS.FragmentsModel, name: string, color: string, ids: number[]) {
    const id = `an:${name}`;
    if (!this.highlighter.styles.has(id)) this.highlighter.styles.set(id, { color: new THREE.Color(color), opacity: 1, transparent: false, renderedFaces: 0, priority: 10 } as never);
    this.paintStyles.add(id);
    await this.highlighter.highlightByID(id, { [model.modelId]: new Set(ids) }, true, false);
  }

  /** Visibilidad deseada de los modelos auxiliares (se reaplica tras «mostrar todo»). */
  private auxVisible = new Map<FRAGS.FragmentsModel, number[]>();
  private async reapplyAux() {
    for (const [m, ids] of this.auxVisible) await this.showOnlyAux(m, ids);
  }

  /** Muestra solo estos elementos de un modelo auxiliar. */
  async showOnlyAux(model: FRAGS.FragmentsModel, ids: number[]) {
    this.auxVisible.set(model, ids);
    await model.setVisible(undefined, false);
    if (ids.length) await model.setVisible(ids, true);
    model.object.visible = ids.length > 0;
    await this.fragments.core.update(true);
  }

  /** Modelo actual en formato Fragments (para pasarlo a la vista VR del navegador). */
  async modelBuffer(): Promise<ArrayBuffer | null> {
    const model = this.currentModelId ? this.fragments.list.get(this.currentModelId) : null;
    if (!model) return null;
    const buf = await model.getBuffer(false);
    return buf instanceof ArrayBuffer ? buf : new Uint8Array(buf as ArrayBufferLike).slice().buffer;
  }

  /** Pose de la cámara (posición y punto al que mira). */
  cameraPose() {
    const c = this.world.camera.controls;
    return { pos: c.getPosition(new THREE.Vector3()).toArray(), target: c.getTarget(new THREE.Vector3()).toArray() };
  }

  async setCameraPose(p: { pos: number[]; target: number[] }) {
    const [x, y, z] = p.pos;
    const d = new THREE.Vector3(...(p.target as [number, number, number])).sub(new THREE.Vector3(x, y, z));
    const t = new THREE.Vector3(x, y, z).addScaledVector(d.normalize(), 0.01);
    await this.world.camera.controls.setLookAt(x, y, z, t.x, t.y, t.z, false);
    await this.fragments.core.update(true);
  }

  /** Cierra el modelo actual y libera su memoria (GPU + worker + web-ifc). */
  async closeModel() {
    const id = this.currentModelId;
    if (!id) return;
    await this.highlighter.clear(SELECT_STYLE);
    for (const s of this.paintStyles) this.highlighter.styles.delete(s);
    this.paintStyles.clear();
    this.ghost.dispose();
    this.focusActive = false;
    this.events.onModelClosing?.();
    this.currentModelId = null;
    this.appearance.reset();
    this.nav.enabled = false;
    this.units = {};
    await this.fragments.core.disposeModel(id);
    this.ifcLoader.cleanUp();
    this.setVisibility("all");
    this.events.onSelectionChange?.(null, 0);
  }

  async fitAll() {
    if (!this.currentModelId) return;
    await this.nav.fit(() => this.world.camera.fitToItems());
  }

  async fitSelection() {
    const sel = this.selection();
    if (!sel) return;
    await this.nav.fit(() => this.world.camera.fitToItems(sel));
  }

  async hideSelected() {
    const sel = this.selection();
    if (!sel) return false;
    // clear() vacía el mismo objeto de selección: se usa la copia de selection().
    await this.highlighter.clear(SELECT_STYLE);
    await this.hider.set(false, sel);
    await this.fragments.core.update(true);
    this.setVisibility("partial");
    return true;
  }

  async isolateSelected() {
    const sel = this.selection();
    if (!sel) return false;
    await this.hider.isolate(sel);
    await this.fragments.core.update(true);
    this.setVisibility("isolated");
    return true;
  }

  async showAll() {
    if (!this.currentModelId) return;
    await this.hider.set(true);
    await this.reapplyAux();
    await this.fragments.core.update(true);
    this.setVisibility("all");
  }

  async clearSelection() {
    await this.highlighter.clear(SELECT_STYLE);
  }

  /** Vista realista (texturas, cielo, sol, sombras) o técnica (colores del IFC). */
  async setRealistic(on: boolean) {
    await this.env.setEnabled(on);
    await this.appearance.setRealistic(on);
    await this.fragments.core.update(true);
  }

  updateEnvironment(patch: Partial<EnvSettings>) {
    this.env.update(patch);
  }

  /** Selecciona elementos del modelo actual por localId (p. ej. todos los de un material). */
  async selectLocalIds(ids: number[]) {
    if (!this.currentModelId || !ids.length) return;
    await this.highlighter.highlightByID(SELECT_STYLE, { [this.currentModelId]: new Set(ids) }, true, false);
  }

  /** Elemento bajo un punto de la pantalla (coordenadas de ventana), o null. */
  async pickAt(clientX: number, clientY: number): Promise<number | null> {
    if (!this.currentModelId) return null;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    try {
      const hit = (await this.components.get(OBC.Raycasters).get(this.world).castRay({ position: ndc })) as { localId?: number } | null;
      return typeof hit?.localId === "number" ? hit.localId : null;
    } catch {
      return null;
    }
  }

  /** Oculta / aísla / encuadra elementos concretos (menú contextual). */
  async hideLocalIds(ids: number[]) {
    if (!this.currentModelId || !ids.length) return;
    await this.highlighter.clear(SELECT_STYLE);
    await this.hider.set(false, { [this.currentModelId]: new Set(ids) });
    await this.fragments.core.update(true);
    this.setVisibility("partial");
  }

  async isolateLocalIds(ids: number[]) {
    if (!this.currentModelId || !ids.length) return;
    await this.hider.isolate({ [this.currentModelId]: new Set(ids) });
    await this.fragments.core.update(true);
    this.setVisibility("isolated");
  }

  async fitLocalIds(ids: number[]) {
    if (!this.currentModelId || !ids.length) return;
    const map = { [this.currentModelId]: new Set(ids) };
    await this.nav.fit(() => this.world.camera.fitToItems(map));
  }

  /** Encuadra una caja (m): elementos de un modelo auxiliar, interferencias… */
  async fitBox(min: number[], max: number[], margin = 0.5) {
    const box = new THREE.Box3(new THREE.Vector3(min[0], min[1], min[2]), new THREE.Vector3(max[0], max[1], max[2]));
    const size = box.getSize(new THREE.Vector3()).length();
    box.expandByScalar(Math.max(margin, size * 0.6));
    await this.nav.fit(async () => {
      await this.world.camera.controls.fitToBox(box, true);
    });
  }

  get modelId() {
    return this.currentModelId;
  }

  /** Modelo de Fragments abierto (para las herramientas de análisis). */
  get model(): FRAGS.FragmentsModel | null {
    return this.currentModelId ? (this.fragments.list.get(this.currentModelId) ?? null) : null;
  }

  private paintStyles = new Set<string>();

  /**
   * Colorea grupos de elementos (análisis: interferencias, IDS, comparación, 4D). Sustituye a la
   * coloración anterior. Van por encima de las apariencias realistas y por debajo de la selección.
   */
  async paint(groups: { name: string; color: string; opacity?: number; ids: number[] }[]) {
    if (!this.currentModelId) return;
    // Mismo cuidado que Appearance.applyAll: crear estilos con selección activa deja restos naranjas.
    if (!OBC.ModelIdMapUtils.isEmpty(this.highlighter.selection[SELECT_STYLE] ?? {})) await this.highlighter.clear(SELECT_STYLE);
    const wanted = new Set(groups.filter((g) => g.ids.length).map((g) => `an:${g.name}`));
    // Los estilos que ya no hacen falta se VACÍAN, no se borran: borrar la definición mientras Fragments
    // actualiza mallas dejaba índices sin definición («Cannot destructure property 'preserveOriginalMaterial'»,
    // visto en CI Windows). Cada nombre tiene un color fijo, así que no hace falta recrearlos.
    for (const id of this.paintStyles) {
      if (!wanted.has(id) && !OBC.ModelIdMapUtils.isEmpty(this.highlighter.selection[id] ?? {})) await this.highlighter.clear(id);
    }
    for (const g of groups) {
      if (!g.ids.length) continue;
      const id = `an:${g.name}`;
      const opacity = g.opacity ?? 1;
      const color = new THREE.Color(g.color);
      const prev = this.highlighter.styles.get(id) as { color: THREE.Color; opacity: number } | undefined;
      if (!prev || !prev.color.equals(color) || prev.opacity !== opacity) {
        if (prev) this.highlighter.styles.delete(id);
        this.highlighter.styles.set(id, { color, opacity, transparent: opacity < 1, renderedFaces: 0, priority: 10 } as never);
      }
      this.paintStyles.add(id);
      await this.highlighter.highlightByID(id, { [this.currentModelId]: new Set(g.ids) }, true, false);
    }
    if (!wanted.size) await this.highlighter.updateColors();
    await this.fragments.core.update(true);
  }

  async clearPaint() {
    if (!this.paintStyles.size) return;
    await this.paint([]);
  }

  /**
   * Muestra solo estos elementos y el resto del modelo como fantasma translúcido (contexto).
   * null: vuelve a mostrar todo.
   */
  async focusElements(ids: number[] | null) {
    const model = this.model;
    if (!model) return;
    if (!ids) {
      this.ghost.hide();
      if (this.focusActive) {
        this.focusActive = false;
        await this.showAll();
      }
      return;
    }
    this.focusActive = true;
    await this.hider.isolate({ [model.modelId]: new Set(ids) });
    await this.reapplyAux();
    await this.ghost.show(model);
    await this.fragments.core.update(true);
    this.setVisibility("isolated");
  }

  /** Oculta exactamente estos elementos y muestra el resto (4D). */
  async setHiddenExactly(ids: number[]) {
    if (!this.currentModelId) return;
    await this.hider.set(true);
    await this.reapplyAux();
    if (ids.length) await this.hider.set(false, { [this.currentModelId]: new Set(ids) });
    await this.fragments.core.update(true);
    this.setVisibility(ids.length ? "partial" : "all");
  }

  /** Elementos seleccionados (localIds del modelo actual). */
  selectedLocalIds(): number[] {
    const sel = this.selection();
    if (!sel || !this.currentModelId) return [];
    return [...(sel[this.currentModelId] ?? [])];
  }

  setNavMode(mode: NavMode) {
    return this.nav.setMode(mode);
  }

  /** Elementos ocultos ahora mismo (para pasar la misma vista a VR). */
  async hiddenLocalIds(): Promise<number[]> {
    if (!this.currentModelId) return [];
    const m = (await this.hider.getVisibilityMap(false)) as Record<string, Iterable<number>>;
    return [...(m[this.currentModelId] ?? [])];
  }

  /** Datos de visibilidad para pruebas/diagnóstico. */
  async visibilityCounts() {
    if (!this.currentModelId) return { visible: 0, hidden: 0 };
    const visible = await this.hider.getVisibilityMap(true);
    const hidden = await this.hider.getVisibilityMap(false);
    const count = (m: Record<string, number[]>) => Object.values(m).reduce((n, ids) => n + ids.length, 0);
    return { visible: count(visible), hidden: count(hidden) };
  }

  /** Selecciona programáticamente por GlobalId (útil para pruebas). */
  async selectByGuid(guid: string) {
    const map = await this.fragments.guidsToModelIdMap([guid]);
    if (OBC.ModelIdMapUtils.isEmpty(map)) return false;
    await this.highlighter.highlightByID(SELECT_STYLE, map, true, false);
    return true;
  }

  /** Información de depuración: escena, memoria y modelos. */
  debugInfo() {
    return {
      models: [...this.fragments.list.keys()],
      sceneChildren: this.world.scene.three.children.length,
      renderer: this.world.renderer?.three.info.memory,
    };
  }

  /** Para pruebas automatizadas: lanza un clic de selección en un píxel del lienzo. */
  get canvas() {
    return this.world.renderer!.three.domElement;
  }

  get fragmentsManager() {
    return this.fragments;
  }

  private selection(): OBC.ModelIdMap | null {
    const sel = this.highlighter.selection[SELECT_STYLE];
    if (!sel || OBC.ModelIdMapUtils.isEmpty(sel)) return null;
    // Copia profunda: el Highlighter reutiliza y vacía sus Sets internos.
    return OBC.ModelIdMapUtils.clone(sel);
  }

  private setVisibility(state: VisibilityState) {
    this.visibility = state;
    this.events.onVisibilityChange?.(state);
  }

  get visibilityState() {
    return this.visibility;
  }

  private async handleSelection(map: OBC.ModelIdMap) {
    const request = ++this.selectionRequest;
    const entries = Object.entries(map).filter(([, ids]) => ids.size > 0);
    const count = entries.reduce((n, [, ids]) => n + ids.size, 0);
    if (count === 0) return this.events.onSelectionChange?.(null, 0);

    // Se muestran los datos del primer elemento seleccionado.
    const [modelId, ids] = entries[0];
    const localId = ids.values().next().value as number;
    const info = await this.getElementInfo(modelId, localId);
    if (request !== this.selectionRequest) return; // llegó otra selección mientras tanto
    this.events.onSelectionChange?.(info, count);
  }

  async getElementInfo(modelId: string, localId: number): Promise<ElementInfo | null> {
    const model = this.fragments.list.get(modelId);
    if (!model) return null;
    const [data] = await model.getItemsData([localId], ELEMENT_DATA_CONFIG);
    const [guid] = await model.getGuidsByLocalIds([localId]);
    return parseItemData(data ?? {}, { localId, guid: guid ?? null }, this.units);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.world?.camera?.controls.removeEventListener("update", this.onCameraUpdate);
      this.vr?.dispose();
      this.nav?.detach();
      this.env?.dispose();
      await this.closeModel();
    } catch (e) {
      console.warn("Error al cerrar el modelo durante dispose", e);
    }
    this.components.dispose();
  }
}

/** Error con mensaje ya pensado para el usuario. */
export class UserError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "UserError";
  }
}

function validateIfcBytes(name: string, bytes: Uint8Array) {
  if (!/\.ifc$/i.test(name)) {
    if (/\.ifczip$/i.test(name)) throw new UserError("Los archivos .ifczip todavía no están soportados. Descomprímelo y abre el .ifc.");
    if (/\.rvt$/i.test(name)) throw new UserError("Los archivos .rvt no se pueden abrir directamente. Exporta el modelo a IFC desde Revit.");
    throw new UserError(`"${name}" no es un archivo .ifc.`);
  }
  if (bytes.byteLength === 0) throw new UserError("El archivo está vacío.");
  const head = new TextDecoder().decode(bytes.subarray(0, 512));
  if (!head.includes("ISO-10303-21")) {
    throw new UserError(
      "El archivo no tiene cabecera IFC (ISO-10303-21). Puede estar dañado o ser IFC-XML, que no está soportado.",
    );
  }
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(new TextDecoder().decode(bytes.subarray(0, 4096)))?.[1];
  if (schema && !/^IFC(2X3|4|4X3)/i.test(schema)) {
    throw new UserError(`Esquema IFC no soportado: ${schema}. Se admiten IFC2x3, IFC4 e IFC4x3.`);
  }
}

function toUserError(err: unknown): UserError {
  if (err instanceof UserError) return err;
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const lower = raw.toLowerCase();
  if (lower.includes("wasm") || lower.includes("webassembly")) {
    return new UserError(
      "No se pudo iniciar el motor IFC (web-ifc WASM). Ejecuta de nuevo «npm run dev» para copiar los archivos WASM.",
      raw,
    );
  }
  if (lower.includes("worker")) {
    return new UserError("No se pudo iniciar el proceso en segundo plano de Fragments.", raw);
  }
  if (err instanceof RangeError || lower.includes("memory") || lower.includes("allocation")) {
    return new UserError("El navegador se quedó sin memoria al procesar el modelo. Prueba con un IFC más pequeño o cierra otras pestañas.", raw);
  }
  return new UserError("No se pudo cargar el modelo IFC. Revisa que el archivo sea un IFC válido.", raw);
}
