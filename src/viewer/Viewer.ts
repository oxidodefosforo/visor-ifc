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

export type LoadProgress = {
  /** 0..1 */
  value: number;
  stage: string;
};

export type ViewerEvents = {
  onSelectionChange?: (info: ElementInfo | null, count: number) => void;
  onVisibilityChange?: (state: VisibilityState) => void;
  onNavChange?: (state: NavState) => void;
};

export type VisibilityState = "all" | "partial" | "isolated";

const SELECT_STYLE = "select";

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

  /** Cierra el modelo actual y libera su memoria (GPU + worker + web-ifc). */
  async closeModel() {
    const id = this.currentModelId;
    if (!id) return;
    await this.highlighter.clear(SELECT_STYLE);
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

  /** Elementos seleccionados (localIds del modelo actual). */
  selectedLocalIds(): number[] {
    const sel = this.selection();
    if (!sel || !this.currentModelId) return [];
    return [...(sel[this.currentModelId] ?? [])];
  }

  setNavMode(mode: NavMode) {
    return this.nav.setMode(mode);
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
    const [data] = await model.getItemsData([localId], {
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
    });
    const [guid] = await model.getGuidsByLocalIds([localId]);
    return parseItemData(data ?? {}, { localId, guid: guid ?? null }, this.units);
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.world?.camera?.controls.removeEventListener("update", this.onCameraUpdate);
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
