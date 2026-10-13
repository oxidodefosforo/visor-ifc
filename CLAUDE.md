# CLAUDE.md — Visor IFC

Visor IFC local para coordinación BIM (modelos de Revit, incluido MEP). Se distribuye como
**aplicación de escritorio de Windows** (Electron + instalador NSIS + actualizaciones automáticas
desde GitHub Releases) y sigue funcionando como web local con `npm run dev`.
El IFC se procesa **solo en el navegador del usuario**: no hay backend ni peticiones externas
(verificado por la prueba e2e, que falla si hay cualquier petición fuera de localhost).

## Comandos

| Comando | Qué hace |
|---|---|
| `npm ci` | Instala exactamente las versiones de `package-lock.json`. |
| `npm run dev` | Copia el WASM (`predev`) y abre el servidor de desarrollo en http://localhost:5173 |
| `npm run build` | Copia el WASM, comprueba tipos (`tsc`) y genera `dist/`. |
| `npm run preview` | Sirve `dist/` para probar la versión compilada. |
| `npm run typecheck` | Solo comprobación de tipos. |
| `npm run test:e2e` | Prueba de extremo a extremo con IFC real sobre la versión compilada (compila si falta `dist/`). |
| `npm run test:e2e -- --dev` | Igual, contra el servidor de desarrollo. `--headed` para ver el navegador. |

| `npm run app` | Compila y abre la app de escritorio (Electron) sin instalar. |
| `npm run dist:win` | Genera `release/Visor-IFC-Setup-X.Y.Z.exe` (en Linux requiere wine + wine32). |
| `npm run release:win` | Igual y publica en GitHub Releases (requiere `GH_TOKEN`). Normalmente lo hace GitHub Actions. |
| `xvfb-run -a npm run test:e2e -- --electron` | La misma prueba e2e dentro de la app Electron (en Windows, sin xvfb-run). |

`IFC_FILE=ruta.ifc npm run test:e2e` usa otro modelo; por defecto el primer `.ifc` de `test-models/`.
En una máquina nueva, la prueba necesita una vez `npx playwright install chromium`.

## Versiones fijadas (exactas, sin ^ ni ~)

| Paquete | Versión | Nota |
|---|---|---|
| @thatopen/components | 3.4.9 | peer: three ≥0.182, web-ifc ≥0.0.77, fragments ~3.4.7 |
| @thatopen/components-front | 3.4.5 | Highlighter |
| @thatopen/fragments | 3.4.8 | |
| web-ifc | **0.0.77** | **No subir a 0.0.78** (ver decisiones). Forzada con `overrides`. |
| three | 0.186.1 | @types/three 0.186.0 |
| camera-controls | 3.1.2 | peer de components |
| vite | 8.3.4 | requiere Node ^20.19 o ≥22.12 |
| typescript | 7.0.2 | compilador nativo; `tsc` solo comprueba tipos (`noEmit`) |
| playwright | 1.56.0 | solo pruebas |
| electron | 44.7.0 | app de escritorio (Chromium 14x) |
| electron-builder | 26.15.3 | instalador NSIS |
| electron-updater | 6.8.9 | única dependencia de producción (`dependencies`); el resto es devDependencies porque Vite lo empaqueta en dist/ |
| three-mesh-bvh | 0.9.9 | interferencias (ya era dependencia de components; ahora fijada) |
| fflate | 0.8.3 | zip para .xlsx y deflate del PDF |
| iwer | 2.5.0 | solo pruebas: gafas WebXR emuladas (Meta, Quest 3). 2.6.0 salió el 2026-10-13: no se usa aún |

Versiones consultadas en el registro npm el 2026-10-12. La API se verificó contra los `.d.ts`
instalados y los tutoriales oficiales (docs.thatopen.com: IfcLoader, Highlighter, Hider).

## Arquitectura

```
index.html              Barra de herramientas, viewport, panel de propiedades, toast
src/main.ts             Arranque: crea UNA instancia de Viewer, conecta la UI, atajos, HMR/dispose
src/viewer/Viewer.ts    Motor: Components, World, FragmentsManager, IfcLoader, Highlighter, Hider
src/viewer/Navigator.ts   Navegación tipo Revizto (Recorrido/Órbita, WASD/QE, mirar, desplazar, rueda al cursor)
src/viewer/properties.ts  ItemData → ElementInfo (GlobalId, clase, nombre, tipo, nivel, material, Psets/Qtos con unidades)
src/ui/propertiesPanel.ts Panel de información estilo Revizto (buscador, secciones plegables, copiar, Copiar todo TSV)
src/ui/realismPanels.ts   Pestañas Materiales (grupos por material IFC, presets, editor, imagen propia, perfil) y Entorno
src/render/Appearance.ts  Apariencias: intercepta MaterialManager.new (Lambert→PBR) y aplica estilos «mat:g/mat:o» del Highlighter
src/render/materials.ts   Presets PBR, reglas de asignación automática, material triplanar (onBeforeCompile)
src/render/textures.ts    Texturas procedurales (canvas 2D, sin descargas) e imágenes propias
src/render/Environment.ts Vista realista: cielo físico (Sky), PMREM, sol con sombras, ACES, suelo, hora/orientación
src/viewer/VR.ts        Sesión WebXR immersive-vr: bucle de three, rig de cámara, locomoción con mandos, teletransporte
src/render/Ghost.ts     Copia translúcida del modelo para dar contexto (interferencias, IDS, comparar)
src/ui/swatch.ts        Muestras de material, rejilla de acabados y ventana flotante (Popover) sin controles nativos
src/ui/contextMenu.ts   Menú del botón derecho: acabado por instancia / tipo / material IFC + Encuadrar/Ocultar/Aislar
src/ui/vrUi.ts          Botón VR, página de sesión ?vr=<token> (modelo recibido de la app), instrucciones Quest Link
src/analysis/modelIndex.ts  Índice por modelo (clase, nombre, GUID, nivel, caja) y triángulos por elemento (getItemsGeometry)
src/analysis/clash.ts   Interferencias: barrido de cajas + BVH (cruce) + paridad de rayos (contenido)
src/analysis/compare.ts Firmas por GlobalId (caja, atributos, Psets) y diferencias con desplazamiento global
src/analysis/plan.ts    Corte horizontal de triángulos, cadenas de contorno; capas corte / por encima / por debajo
src/analysis/drawingExport.ts  PDF vectorial propio (A3, Helvetica WinAnsi, deflate) y DXF R12
src/analysis/xlsx.ts    Escritor .xlsx mínimo (fflate) y descarga
src/ui/analysis/*       Panel inferior «Análisis»: dock.ts + clashTab, idsTab, compareTab, fourdTab
src/ui/planView.ts      Vista «Planta 2D» (SVG, cotas con imán, exportación PDF/DXF)
electron/vrServer.cjs   Servidor 127.0.0.1 (puerto 47821 o libre) que sirve dist/ y la sesión VR; abre Chrome/Edge
tests/variant.mjs       Genera con web-ifc una 2.ª versión del IFC con cambios conocidos (para «Comparar»)
test-models/requisitos-estructura.ids  IDS de ejemplo (resultados contrastados con web-ifc en la e2e)
src/style.css           Estilos (tema oscuro)
scripts/copy-wasm.mjs   Copia node_modules/web-ifc/*.wasm → public/wasm/ (predev/prebuild)
tests/e2e.mjs           Prueba e2e Playwright + contraste con web-ifc en Node
electron/main.cjs       Proceso principal: protocolo app://visor/ → dist/, ventana, menú, actualizaciones, log
electron/preload.cjs    Puente seguro (contextBridge): versión, acciones de menú, estado de actualización
electron-builder.config.cjs  Instalador NSIS; destino de actualizaciones desde release.json o VISOR_GH_OWNER/REPO
release.json            { githubOwner, githubRepo } — vacío = instalador sin actualizaciones
.github/workflows/release.yml  Etiqueta vX.Y.Z → build + e2e + instalador + Release en Windows
build/icon.png          Icono (256 px; electron-builder genera el .ico)
test-models/            IFC de prueba (school_str.ifc, Revit, IFC4, de ThatOpen/engine_components)
```

Flujo de carga: `File` → `Uint8Array` → validación (extensión, cabecera ISO-10303-21, esquema)
→ `IfcLoader.load()` (web-ifc WASM en el hilo principal convierte a Fragments, con progreso 0..1
por fases) → `FragmentsManager` (worker) → `onItemSet` añade `model.object` a la escena →
`camera.fitToItems()`.

## Decisiones

- **Sin React.** La UI es una barra de botones y un panel; React no aporta ventaja y su
  StrictMode/re-render complica garantizar una sola instancia del motor WebGL. TypeScript + DOM.
- **Todo local.** `IfcLoader.setup({ autoSetWasm: false, wasm: { path: "/wasm/", absolute: true } })`
  porque `autoSetWasm` descarga de unpkg. El worker de Fragments se importa con
  `@thatopen/fragments/worker?url` (Vite lo empaqueta) en lugar de `FragmentsManager.getWorker()`,
  que también descarga de unpkg.
- **web-ifc 0.0.77, no 0.0.78.** En 0.0.78 (última en npm a 2026-10-12) el `web-ifc.wasm` de
  navegador no coincide con su JS: `BindingError: function StreamMeshes called with 4 arguments,
  expected 3`. Reproducido de forma aislada (sin That Open) en Chromium; la variante Node sí funciona.
  Al subir de versión, repetir `npm run test:e2e` (el primer paso es la carga).
- **Un modelo a la vez** (fase 1). Abrir otro sustituye al actual; `closeModel()` limpia selección,
  llama a `fragments.core.disposeModel(id)` e `ifcLoader.cleanUp()`. La e2e comprueba que geometrías
  GPU y escena vuelven al estado inicial y que recargar no acumula.
- **Una sola instancia del visor.** main.ts crea el Viewer una vez; `import.meta.hot.dispose` y
  `pagehide` llaman a `viewer.dispose()` (→ `components.dispose()`). main.ts no acepta HMR, así que
  editar TS provoca recarga completa; CSS se actualiza en caliente. Verificado: siempre 1 canvas.
- **Datos de propiedades** con `model.getItemsData(ids, config)`. Forma real observada (Fragments
  3.4.8, IFC de Revit): `IsDefinedBy` llega **aplanado** y contiene directamente `IFCPROPERTYSET`,
  `IFCELEMENTQUANTITY` y el objeto de tipo (`IFC…TYPE`, con `HasPropertySets` y `HasAssociations`).
  La config de relaciones aplica por nombre a cualquier profundidad: se desactivan `ObjectTypeOf`,
  `DefinesOcurrence`, `RepresentationMaps`… porque desde el tipo llevarían a todas sus instancias.
- **GlobalId** con `model.getGuidsByLocalIds`. `localId` = ID de entidad IFC (`#2491`).
- **Clase IFC** se muestra como `IfcSlab` (mapa desde los esquemas IFC2X3/IFC4/IFC4X3 de web-ifc);
  Fragments la da en mayúsculas.
- **Resaltado delante siempre.** Se mantiene el `polygonOffsetFactor = Math.random()` del tutorial
  oficial contra z-fighting, pero el material con `userData.customId === "select"` recibe -2: con
  factor aleatorio, en caras coplanares (p. ej. cubierta) el resaltado a veces no se veía.
- **Ocultar:** `highlighter.clear()` vacía el mismo `ModelIdMap` de la selección; por eso
  `selection()` devuelve `ModelIdMapUtils.clone(...)`. (Bug real encontrado por la e2e.)
- **Errores** se convierten a `UserError` con mensaje en español + detalle técnico desplegable.
- `window.__viewer` se expone para pruebas/depuración (no es API pública).

## Navegación e información (v0.3, decisiones)

- **Teclas como Revizto** (verificado en help.revizto.com): W/A/S/D, **E sube, Q baja**, Shift acelera
  (×4). Se usa `e.code` (independiente del idioma del teclado). W/S siguen la dirección de la vista
  (vuelo), A/D lateral horizontal, E/Q vertical puro. Flechas equivalentes. +/− cambian velocidad
  (×0.125…×8). Velocidad base = 6 % de la diagonal del modelo por segundo (entre 0.8 y 40 m/s).
- **Movimiento por tiempo de pulsación**, no por fotogramas: cada tecla guarda cuándo se pulsó y al
  soltarla se aplica su tramo pendiente. Bug real encontrado por la e2e: con fotogramas lentos una
  pulsación corta se perdía.
- **Recorrido (por defecto):** el objetivo de camera-controls se mantiene a 1 cm de la cámara y los
  botones de camera-controls se desactivan; el ratón lo gestiona Navigator: izquierdo = mirar
  (arrastrar a la derecha = mirar a la derecha, pitch ±89°), derecho/central = desplazar con escala
  según la profundidad del punto agarrado (raycast GPU de That Open: `Raycasters.get(world).castRay`),
  rueda = avanzar el 25 % de la distancia al punto bajo el cursor (o 5 % del modelo si no hay nada).
- **Rueda sin esperar transiciones:** `setLookAt(..., true)` puede no resolver su promesa si otra
  transición la interrumpe; esperarla bloqueaba la rueda (bug real de la e2e).
- **Órbita:** controles estándar de camera-controls (izq. rotar, der. desplazar, rueda con
  `dollyToCursor`); pivote = punto del modelo en el centro de la pantalla.
- `fitToItems` necesita distancia libre: `Navigator.fit()` abre `minDistance`, encuadra y, en
  Recorrido, vuelve a acercar el objetivo a la cámara.
- Clic izquierdo sin arrastrar sigue seleccionando (el Highlighter ignora clics con movimiento).
- **Unidades:** de IFCPROJECT → UnitsInContext (IfcSIUnit con prefijo, IfcConversionBasedUnit,
  IfcDerivedUnit). Se aplican por tipo de medida (IFCLENGTHMEASURE → LENGTHUNIT…) y para cantidades
  por atributo (LengthValue…). Los valores de Psets llegan **sin convertir** (en unidades del proyecto,
  p. ej. mm), pero el importador **sí convierte a metros** atributos geométricos como `Elevation` del
  nivel (11399.99 mm → 11.4): por eso el nivel se muestra en m. Ángulos en rad también en grados.
- **Nivel** por `ContainedInStructure`; «Pertenece a» por `Decomposes`.
- El panel guarda el valor original en `data-raw` (la e2e compara contra web-ifc con tolerancia).
  Búsqueda y plegado de secciones se conservan entre selecciones (plegado en localStorage).

## Vista realista y materiales (v0.4, decisiones)

- **Dos vistas:** Técnica (colores del IFC, para coordinar) y Realista (texturas, cielo, sol, sombras).
  Las apariencias solo se aplican en Realista; volver a Técnica las retira y restaura la luz.
- **PBR:** `Appearance.install()` sustituye el `MaterialManager.new` de Fragments para devolver
  `MeshStandardMaterial` en vez de Lambert (también en Técnica; aspecto equivalente).
- **Texturas triplanares:** la geometría IFC no trae UV; se proyecta en coordenadas del mundo desde X/Y/Z
  y se mezcla por la normal (`onBeforeCompile`). Texturas procedurales generadas en canvas (hormigón,
  encofrado, ladrillo, bloque, enlucido, madera, parquet, cerámico, piedra, metal, asfalto, césped,
  grava) + imágenes propias del usuario (reducidas a ≤1024 px, guardadas en localStorage).
- **Apariencias = estilos del Highlighter de That Open**: `mat:g:<hash>` por material IFC (prioridad 1),
  `mat:o:<hash>` por elemento (prioridad 2); la selección tiene prioridad máxima y al deseleccionar
  vuelve la apariencia. Agrupación por material IFC (`HasAssociations`, o el del tipo).
- **Profundidad (bug real, verificado):** Fragments dibuja los elementos con estilo **sobre** la geometría
  base en la misma posición. El `polygonOffsetFactor = Math.random()` (anti z-fighting) se aplicaba
  también a los estilos y, según la carga, ganaba la base: núcleo/losas sin textura en ~50 % de las
  cargas. Ahora todo material con `customId` va delante (−1; selección −2). La e2e lo comprueba.
- **Selección y estilos nuevos (bug de Fragments 3.4.8, verificado):** si se crea un estilo mientras
  sus elementos están seleccionados, al deseleccionar quedaban naranjas (la definición reutiliza el
  hueco de la selección y las mallas no se reconstruyen). `applyAll` quita la selección antes de cambiar
  estilos y no la restaura (sin carreras y se ve el resultado).
- `applyAll` termina con `fragments.core.update(true)` y la deselección programa otro: `updateColors`
  del Highlighter lanza la actualización de mallas en paralelo con los highlight, no después.
- **Acero:** el preset «Acero estructural» es pintado/mate (metalness 0.25). Con metalness ~1 reflejaba
  el cielo y parecía cromo azulado. Inoxidable/aluminio aparte. Reglas de nombre: galvan→galvanizado,
  stainless/inoxidable→inoxidable, steel/acero/rebar→estructural.
- **Exposición:** base 0.175 (× control del panel). Calibrado con capturas: con 0.35 las caras al sol se
  saturaban y ACES aplanaba las texturas.
- **Entorno:** cielo físico (`Sky` de three) a cubemap para el fondo y PMREM para la iluminación; sol
  direccional con sombras (mapa 2048, se ajusta al tamaño del modelo), suelo neutro/césped/ninguno.
  Las mallas de Fragments se marcan `castShadow/receiveShadow` antes de cada render.
- Perfil (material IFC → configuración) en localStorage, exportable/importable en JSON para reutilizarlo
  entre proyectos (los nombres de material de Revit se repiten).
- Limitación: los objetos lejanos que Fragments dibuja simplificados (LOD) no llevan apariencia.

**Pruebas visuales — cuidado:** medir píxeles con un `renderer.render()` manual NO equivale a lo que
dibuja la app (se salta `onBeforeUpdate`, p. ej. el marcado de sombras): dio falsos fallos. Medir sobre
capturas reales (`page.screenshot`). Contar materiales en `mesh.material` también engaña: Fragments deja
materiales sin usar en la lista; mirar `geometry.groups` con `count > 0`. En SwiftShader, `textureGrad`
es lentísimo (capturas de >30 s): no usarlo.

## Escritorio y actualizaciones (decisiones)

- **Electron, no Tauri.** Mismo Chromium en todos los PCs (WebGL/WASM/workers ya validados), instalador
  NSIS y auto-actualización maduros (electron-updater). Coste: instalador de ~100 MB.
- **Protocolo `app://visor/`** (privilegiado: standard, secure, fetch, CORS) en vez de `file://`, para que
  el worker de Fragments y el WASM se carguen igual que en web. MIME `application/wasm` explícito.
  Ventana con `contextIsolation`, `sandbox`, sin `nodeIntegration`; navegación externa bloqueada.
- **Instalador por usuario** (`perMachine: false`): no pide administrador y permite actualizar sin permisos.
  Asistente clásico en español, elige carpeta, accesos en escritorio y menú Inicio.
- **Actualizaciones:** comprobación 3 s tras abrir; descarga automática; diálogo «Reiniciar ahora / Más
  tarde»; si no, se instala al cerrar. Instalación **silenciosa** (`quitAndInstall(true, true)` →
  `--updated /S --force-run`) y la app se reabre. Sin conexión: error silencioso en el log (solo se avisa
  si el usuario pulsó Ayuda → Buscar actualizaciones). SHA-512 verificado por electron-updater.
- El instalador solo incluye `resources/app-update.yml` si se compiló con owner (release.json o CI).
  Sin él, `updatesConfigured()` = false y Ayuda → Buscar actualizaciones lo explica.
- **El repo de GitHub debe ser público** (electron-updater no lee Releases privadas sin token).
- Sin firma de código: Windows SmartScreen avisa («Más información → Ejecutar de todas formas»).
  Para quitarlo hace falta un certificado de firma (Azure Trusted Signing u OV/EV).
- Log de la app: `%APPDATA%\Visor IFC\logs\main.log` (Ayuda → Abrir carpeta de registros).

## v0.5 — menú contextual, VR y análisis (decisiones)

- **Causa real de «la ventana desaparece» al elegir material:** `body` lleva `data-tab`, `data-view` y
  `data-dock-tab` y los manejadores hacían `closest("[data-tab]")`: un clic en CUALQUIER parte del panel subía
  hasta `body` y llamaba a `showTab()` → `renderMaterials()` destruía el `<select>` abierto. Ahora los selectores
  son `button[data-…]`. Además los desplegables de acabado se sustituyeron por una rejilla propia (Popover).
  Regla: no usar en `closest()` atributos que también estén en `body.dataset` (mismo fallo con `data-scope` en el
  propio menú).
- **Menú contextual:** clic derecho sin arrastre (<5 px, sin límite de tiempo: en CI cada fotograma tardaba segundos; `pointerup` en `window` porque camera-controls
  captura el puntero en Órbita). Selección con `Raycasters.castRay` → `localId`. Ámbitos: instancia (o selección
  múltiple), tipo (`IsDefinedBy` aplanado contiene el `IFC…TYPE`), material IFC. Estilos del Highlighter:
  `mat:g` (1) < `mat:t` (2) < `mat:o` (3). Perfil: `byType` con clave `CLASE|Nombre del tipo` (exportable).
- **VR:** Electron 44 **no tiene WebXR** (`navigator.xr` no existe ni con `--enable-features=WebXR`; comprobado).
  La app publica el modelo **ya convertido** (`model.getBuffer(false)`, Fragments comprimido) + perfil + entorno
  + cámara + ocultos en `electron/vrServer.cjs` (solo 127.0.0.1, token aleatorio) y abre Chrome/Edge en
  `http://localhost:47821/index.html?vr=<token>` (localhost = contexto seguro). En navegador con gafas, el botón
  entra directo. Durante la sesión se para el bucle de That Open (`components.enabled = false`) y three lleva
  el ritmo (`renderer.setAnimationLoop`); la cámara va en un `rig` (Group). `local-floor`: ojos a 1,6 m.
  Velocidad = clamp(base×0,35; 1,5; 6) m/s. Teletransporte: `model.raycast` con una cámara auxiliar en la pose
  del mando y el «ratón» en el centro del lienzo. Giro del rig desde el cuaternión (rotation.y salta >90°).
  El MIME `.mjs` es obligatorio: sin él el worker de Fragments no arranca y la carga se queda colgada sin error.
- **Ghosting:** en Fragments 3.4.8 un estilo/`setOpacity` se dibuja ENCIMA de la base (con opacidad 0,12 en todos
  los elementos seguían dibujándose los tramos opacos): no sirve para transparencia. Se aísla lo que interesa
  (Hider) y se dibuja `Ghost` (malla única translúcida, `depthWrite: false`, sin raycast).
- **Colores de análisis:** estilos `an:*` con prioridad 10 (encima de apariencias, debajo de selección);
  `Viewer.paint()` quita la selección antes (mismo bug de restos naranjas que applyAll).
- **Interferencias:** fase amplia por cajas (`getBoxes`) con solape > tolerancia en X/Y/Z (descarta caras que
  solo se tocan), fase fina `MeshBVH.intersectsGeometry` y, si no se cortan, paridad de rayos (contenido).
  Profundidad = menor solape de cajas (aproximada). En el modelo de prueba: 867 choques en ~2 s (vigas/losas y
  pilares/vigas que Revit no recorta). Encuadre a la zona de solape (una losa entera alejaba la vista).
- **Niveles:** `getSpatialStructure()` alterna nodos de categoría (`category`, localId null) y de elemento
  (`localId`, category null): un elemento es nivel si su nodo padre es la categoría IFCBUILDINGSTOREY.
- **Comparar:** segunda versión con `IfcLoader.load` como modelo auxiliar (oculto; solo se muestran sus
  elementos nuevos/eliminados). Firma = caja (`getBoxes`), atributos, tipo, material y Psets. **Desplazamiento
  global** = moda (al mm) de las diferencias de caja: `getBoxes` del modelo auxiliar llegaba a veces desplazado
  en bloque (coordinación de Fragments según `getCoordinates()` del archivo, que cambia al re-guardar con web-ifc).
  La colocación del modelo auxiliar se calcula con centroides de `getItemsGeometry` (espacio de datos real).
- **4D:** fases por clase y nivel; ocultar con `Hider` (`setHiddenExactly`), en ejecución con estilo `an:4d-active`.
  CSV `;` con BOM (Excel en español), fechas dd/mm/aaaa o ISO.
- **Planta 2D:** corte propio de triángulos (no `getSection`, sin documentar el formato del buffer). Franja del
  nivel [elev−0,3; siguiente−0,01]; cortados (grueso + relleno por cadenas cerradas), por encima a media altura del
  elemento (discontinuo), por debajo (fino). Escala A3 normalizada (1:20…1:5000). Planta: X = x, Y = −z del visor.
- **Excel:** .xlsx real (OOXML mínimo con fflate), validado con openpyxl. En Electron la descarga abre «Guardar como».

## Publicar una versión nueva

1. Cambios en el código + `npm run test:e2e`.
2. `npm version patch --no-git-tag-version` (o `minor`) → sube la versión en `package.json`; commit.
3. `git push` a main → GitHub Actions (`release.yml`, se activa al cambiar package.json) compila en Windows,
   pasa la e2e y publica la Release `vX.Y.Z` con `Visor-IFC-Setup-X.Y.Z.exe`, `.blockmap` y `latest.yml`.
   También se activa con una etiqueta `vX.Y.Z` o a mano (`gh workflow run release.yml`). Si la Release ya
   tiene latest.yml, no hace nada. Desde la sesión de Claude no se pueden subir etiquetas (403 del proxy):
   por eso el disparador principal es el cambio de package.json en main.
   Los registros de Actions no se pueden leer desde la sesión (blob storage bloqueado): el workflow
   vuelca errores y resultados como anotaciones (`gh api .../check-runs/<job>/annotations`).
4. Los programas instalados la detectan al abrirse. La Release nunca debe borrarse ni editarse a mano
   (latest.yml contiene el SHA-512 del instalador).

## Estado verificado (2026-10-12)

`npm run build` sin errores. `npm run test:e2e` 34/34 en build (3 ejecuciones) y dev (2 ejecuciones)
con `test-models/school_str.ifc` (8,6 MB, 1.526 elementos, IFC4 de Revit): carga en ~5-6 s en
Chromium headless con SwiftShader. Selección por clic real, Psets contrastados con web-ifc en
7 clases (IfcBeam, IfcColumn, IfcReinforcingBar, IfcMember, IfcSlab, IfcWall, IfcPlate).

Escritorio: e2e 34/34 dentro de Electron 44 (Linux, Xvfb). Instalador 0.2.0 generado en Linux con
wine/wine32 e instalado en Wine (archivos, accesos directos, entrada de desinstalación, icono y versión
del .exe). Actualización: feed local → detecta 0.2.1, descarga, verifica SHA-512, avisa en barra y
diálogo; archivo manipulado rechazado; sin conexión, silencioso. Instalación de 0.2.1 sobre 0.2.0 en
Wine con `--updated /S --force-run`: sustituye app.asar, registro 0.2.1, conserva %APPDATA% y relanza.
Notas Wine: su `tasklist` ignora filtros, así que la comprobación «app abierta» del instalador da falso
positivo (en la prueba se usó una variante sin esa comprobación); la ventana Electron no pinta en Wine.

Repositorio: https://github.com/oxidodefosforo/visor-ifc (público). Primer run de Actions (0.2.1): e2e
pasó en windows-latest; electron-builder --publish always subió el .exe pero falló antes de latest.yml
(log no legible) → el workflow ahora compila con --publish never y publica con `gh release`.

v0.3 (navegación + información): e2e 49/49 en build (×3), dev y Electron (48/48, sin portapapeles):
dirección de W/S/A/D/E/Q, Shift, velocidad, mirar, desplazar, rueda adelante/atrás, Órbita, nivel
contrastado con IFCRELCONTAINEDINSPATIALSTRUCTURE, unidades m³/mm, buscador y copia al portapapeles.

v0.4 (vista realista y materiales): e2e 62/62 en build y dev, 61/61 en Electron (SwiftShader con
`--ignore-gpu-blocklist`, que reproducía el fallo de profundidad). Texturas del núcleo estables en
capturas reales (3/3 tras la corrección; antes ~50 %). Asignación automática, cambio de preset y
edición en vivo, material por elemento (vidrio) sin restos de selección, perfil exportar/importar,
hora del día, vuelta a Técnica.

v0.5 (menú contextual, VR, análisis): e2e 93/93 en build (Chromium) y 85/85 en Electron (sin descargas ni
portapapeles, que en Electron abren diálogos del sistema). Comprobado: clic derecho → material por tipo (96
instancias) e instancia con prioridad; arrastrar con el derecho no abre el menú. VR con gafas emuladas (IWER,
Quest 3): andar, giro 30°, teletransporte sobre geometría real, salida y vuelta a la navegación; desde Electron
real el botón VR publica el modelo en el servidor local y un Chromium aparte lo carga con sus materiales y entra
en VR. Interferencias: 673 en ~3 s, muestra de 25 confirmada con la geometría de web-ifc en Node. IDS: 357/18,
82/217 y 203/0, idénticos a web-ifc. Comparar con una 2.ª versión generada (tests/variant.mjs): exactamente
1 nuevo, 1 eliminado, 2 modificados (marca B1→B1-REV2 y pilar +0,500 m en X). 4D: ocultos/en ejecución a mitad de
obra coinciden con la programación; CSV ida y vuelta. Planta 2D: PDF A3 (qpdf sin errores, revisado a la vista)
y DXF (ezdxf sin errores: 13.5k LINE, 69 POLYLINE, capas por clase). Excel validado con openpyxl.

**No probado:** VR con unas Quest reales (solo emulador IWER de Meta: sesión, mandos, teletransporte, salida;
y el paso app→Chrome con Electron real + servidor local); rendimiento VR con GPU real; IDS con facetas de
clasificación/partOf/material reales (solo propiedades en el modelo de prueba); 4D con un CSV de Project/Primavera
real; DXF abierto en AutoCAD (validado con ezdxf, sin errores); instalador y app en Windows real; sensación de la navegación con GPU real (aquí ~3 fps);
aspecto y rendimiento de la vista realista con GPU real (sombras 2048 px, PMREM);
unidades derivadas de MEP (IfcDerivedUnit: caudal, presión…) — lógica escrita, sin IFC MEP para probar. Modelos MEP (no había IFC MEP disponible), IFC2x3, modelos >100 MB, Firefox/Safari,
GPU real (solo render por software), Psets de tipo con valores (los tipos del modelo de prueba no
tienen Psets), relaciones IfcPropertyEnumeratedValue/List/Bounded (lógica escrita, sin datos).

## Fase 2 (no implementado)

Filtros por nivel y clase IFC, planos de sección y caja de sección, mediciones 3D, varios modelos federados.
Del archivo de referencia (Visor_IFC.html «Auditoría») quedan: issues y BCF (importar/exportar), viewpoints,
mediciones, caja/plano de sección, árbol espacial y por categoría, colorear por categoría, rayos X, cubo de vistas,
informes PDF de tablas, glTF/OBJ de referencia. En v0.5 se hizo el bloque «Análisis» (interferencias, IDS,
comparar, 4D, planta 2D).
RVT: integración posterior vía Autodesk Platform Services (Model Derivative); no abrir RVT en local.
Otros pendientes: unidades junto a los valores (hoy se muestran en unidades del proyecto sin etiqueta),
árbol espacial, IFCZIP, conversión en Web Worker para no bloquear la UI en modelos grandes.
