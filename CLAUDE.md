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

**No probado:** instalador y app en Windows real; sensación de la navegación con GPU real (aquí ~3 fps);
unidades derivadas de MEP (IfcDerivedUnit: caudal, presión…) — lógica escrita, sin IFC MEP para probar. Modelos MEP (no había IFC MEP disponible), IFC2x3, modelos >100 MB, Firefox/Safari,
GPU real (solo render por software), Psets de tipo con valores (los tipos del modelo de prueba no
tienen Psets), relaciones IfcPropertyEnumeratedValue/List/Bounded (lógica escrita, sin datos).

## Fase 2 (no implementado)

Filtros por nivel y clase IFC, planos de sección, mediciones, varios modelos a la vez.
RVT: integración posterior vía Autodesk Platform Services (Model Derivative); no abrir RVT en local.
Otros pendientes: unidades junto a los valores (hoy se muestran en unidades del proyecto sin etiqueta),
árbol espacial, IFCZIP, conversión en Web Worker para no bloquear la UI en modelos grandes.
