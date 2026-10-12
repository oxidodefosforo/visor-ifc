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
src/viewer/properties.ts  ItemData de Fragments → ElementInfo (GlobalId, clase, nombre, tipo, material, Psets/Qtos)
src/ui/propertiesPanel.ts Render del panel (HTML escapado)
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
2. `npm version patch` (o `minor`) → sube `package.json` y crea la etiqueta `vX.Y.Z`.
3. `git push --follow-tags` → GitHub Actions (`release.yml`) compila en Windows, pasa la e2e y publica la
   Release con `Visor-IFC-Setup-X.Y.Z.exe`, `latest.yml` y `.blockmap`.
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

**No probado:** instalador y app en Windows real; flujo con GitHub Releases real; el workflow de
GitHub Actions (no hay repositorio aún). Modelos MEP (no había IFC MEP disponible), IFC2x3, modelos >100 MB, Firefox/Safari,
GPU real (solo render por software), Psets de tipo con valores (los tipos del modelo de prueba no
tienen Psets), relaciones IfcPropertyEnumeratedValue/List/Bounded (lógica escrita, sin datos).

## Fase 2 (no implementado)

Filtros por nivel y clase IFC, planos de sección, mediciones, varios modelos a la vez.
RVT: integración posterior vía Autodesk Platform Services (Model Derivative); no abrir RVT en local.
Otros pendientes: unidades junto a los valores (hoy se muestran en unidades del proyecto sin etiqueta),
árbol espacial, IFCZIP, conversión en Web Worker para no bloquear la UI en modelos grandes.
