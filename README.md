# Visor IFC

Visor de modelos IFC para Windows. El archivo IFC **no se sube a ningún sitio**: se procesa en tu ordenador.

## Instalar el programa (recomendado)

1. Haz doble clic en `Visor-IFC-Setup-X.Y.Z.exe`.
2. Si Windows muestra «Windows protegió su PC», pulsa **Más información → Ejecutar de todas formas**
   (aparece porque el instalador no tiene firma digital comercial).
3. Sigue el asistente: **Solo para mí → Siguiente → Instalar → Finalizar**. No pide permisos de administrador.
4. Ábrelo desde el icono **Visor IFC** del escritorio o del menú Inicio.

**Actualizaciones:** al abrirse, el programa busca versiones nuevas. Si hay una, la descarga sola y te
pregunta si quieres reiniciar; si eliges «Más tarde», se instala al cerrar el programa.
También puedes usar **Ayuda → Buscar actualizaciones…**. La versión instalada aparece arriba a la derecha.

**Desinstalar:** Configuración de Windows → Aplicaciones → Aplicaciones instaladas → Visor IFC → Desinstalar.

---

## Versión de desarrollo (para modificar el programa)

Lo siguiente solo hace falta para trabajar en el código o probarlo sin instalar.

### Instalación de desarrollo (solo la primera vez)

#### 1. Instala Node.js
Node.js es el programa que ejecuta el visor en tu ordenador.

1. Entra en https://nodejs.org y descarga la versión **LTS** (22 o superior).
2. Instálala con las opciones por defecto (Siguiente, Siguiente…).
3. Comprueba que funciona: abre una ventana de comandos (tecla Windows, escribe `cmd`, Intro) y escribe:
   ```
   node -v
   ```
   Debe responder algo como `v22.x.x`. Si dice que no reconoce el comando, reinicia el ordenador.

#### 2. Descomprime el proyecto
Descomprime `visor-ifc.zip` en una carpeta, por ejemplo `C:\BIM\visor-ifc`.

#### 3. Abre una ventana de comandos en esa carpeta
En el Explorador de archivos, entra en la carpeta `visor-ifc`, haz clic en la barra de dirección
(donde aparece la ruta), escribe `cmd` y pulsa Intro. Se abre una ventana negra ya situada en la carpeta.

#### 4. Instala las librerías
```
npm ci
```
Descarga las librerías con las versiones exactas del proyecto (1-3 minutos, unos 250 MB en `node_modules`).
Solo hace falta repetirlo si borras la carpeta `node_modules`.

### Uso diario (desarrollo)

En la ventana de comandos, dentro de la carpeta del proyecto:
```
npm run dev
```
Se abrirá el navegador en **http://localhost:5173** (si no se abre, copia esa dirección en Chrome o Edge).
Deja la ventana negra abierta mientras usas el visor; para pararlo, pulsa `Ctrl + C` en ella.

## Controles (como Revizto)
Abajo en el centro eliges el modo: **Recorrido** (por defecto) u **Órbita**. El botón **?** muestra esta ayuda.

| Acción | Cómo |
|---|---|
| Avanzar / retroceder | **W** / **S** (o flechas ↑ ↓) |
| Izquierda / derecha | **A** / **D** (o flechas ← →) |
| Subir / bajar | **E** / **Q** |
| Ir más rápido | Mantener **Shift** (×4) |
| Velocidad | **+** / **−** o los botones del selector |
| Mirar alrededor | Arrastrar con el botón izquierdo (en Órbita: girar alrededor del modelo) |
| Desplazar | Arrastrar con el botón derecho |
| Acercar / alejar | Rueda, hacia el punto bajo el cursor |
| Seleccionar | Clic sobre un elemento: se pinta de naranja y su información sale a la derecha |
| Encuadrar todo | **F** |
| Ocultar / aislar / restaurar | **H** / **I** / **R** |
| Deseleccionar | **Esc** |

**Panel de información:** clase IFC, nombre, GlobalId, tipo, nivel, material, ID de elemento y todos los
conjuntos de propiedades y cantidades con sus unidades. Escribe en «Buscar propiedad o valor…» para filtrar,
haz clic en un valor para copiarlo y usa **Copiar todo** para pegar la ficha en Excel.

## Vista realista y materiales
Arriba, el selector **Técnica / Realista** cambia el tipo de vista:
- **Técnica:** colores del IFC, para coordinar.
- **Realista:** materiales con textura, cielo, sol y sombras.

**Pestaña Materiales** (panel derecho): lista los materiales IFC del modelo con su nº de elementos.
- **Asignar automáticamente:** pone hormigón, acero, vidrio, ladrillo… según el nombre del material.
- En cada material eliges un acabado (Hormigón, Encofrado, Ladrillo, Bloque, Enlucido, Pintura, Piedra,
  Cerámico, Madera, Parquet, Acero, Aluminio, Vidrio, Asfalto, Grava, Césped…). Haz clic en el nombre para
  ajustar **color, escala de la textura, rugosidad, metálico y opacidad**, o **carga una imagen tuya**
  (foto de una textura) como textura.
- **Ver** selecciona en el modelo los elementos de ese material.
- Con elementos seleccionados puedes darles un material distinto al de su grupo.
- **Exportar / Importar perfil** guarda tus asignaciones en un archivo para reutilizarlas en otros
  proyectos (los nombres de material de Revit suelen repetirse). Las asignaciones se recuerdan en el equipo.

**Pestaña Entorno:** hora del día, orientación del sol, exposición, sombras y tipo de suelo.

### Cambiar materiales con el botón derecho (lo más rápido)
Haz **clic derecho sobre un elemento** (sin arrastrar; arrastrar con el derecho sigue desplazando la vista).
Se abre un menú con tres pestañas para elegir **a qué** se aplica el acabado:
- **Esta instancia:** solo ese elemento (si haces clic derecho sobre una selección de varios, a toda la selección).
- **Tipo:** todos los elementos del mismo tipo de Revit (p. ej. «Floor : Generic 300mm»).
- **Material IFC:** todos los elementos con ese material.

Elige el acabado en la rejilla: se aplica al momento y el menú sigue abierto para probar otro. Manda
**instancia > tipo > material**. «Quitar (heredar)» vuelve al nivel de abajo. Desde el mismo menú: Encuadrar,
Ocultar, Aislar y Seleccionar el tipo. Esc o clic fuera para cerrarlo.

## Gafas de realidad virtual (Meta Quest con Link / Air Link)
1. Conecta las gafas al PC con **Link** (cable) o **Air Link** y abre la app **Meta Quest Link** en el PC.
2. Solo la primera vez: en Meta Quest Link → **Configuración → General → Tiempo de ejecución de OpenXR →
   «Usar Meta Quest Link»**.
3. En el Visor IFC pulsa **VR** (arriba). La aplicación de escritorio abre el modelo en **Chrome o Edge**
   (con sus materiales, entorno y la vista actual; todo en tu PC, sin subir nada). Ponte las gafas y pulsa
   **Entrar en VR** en esa ventana. (Si usas el visor en Chrome/Edge directamente, entra en VR sin pasos extra.)

| Mando | Acción |
|---|---|
| Joystick izquierdo | Andar hacia donde miras |
| Joystick derecho ← → | Girar 30° |
| Joystick derecho ↑ ↓ | Subir / bajar |
| Gatillo | Apuntar con el láser y soltar: teletransporte |
| Botón lateral (grip) | Mantener: 4× más rápido |

## Análisis (botón «Análisis»)
Abre un panel abajo con cuatro herramientas. Cada una tiene un botón **Excel** con el informe.
- **Interferencias:** elige las clases del conjunto A y del B (por defecto todo menos armadura) y la
  tolerancia en mm. Busca choques reales con la geometría (cruces y elementos contenidos). Clic en una fila:
  A en rojo, B en azul y el resto transparente; ↑ ↓ para recorrerlas; estado Nuevo/Activo/Resuelto/Aprobado.
- **Validación IDS:** abre un archivo **.ids** (buildingSMART). Lista cada requisito con cuántos elementos
  cumplen (verde) y cuáles no (rojo) y el motivo. En `test-models/requisitos-estructura.ids` hay un ejemplo.
- **Comparar:** abre otra versión del mismo proyecto (otro IFC). Compara por GlobalId: **nuevos** (verde),
  **eliminados** (rojo) y **modificados** (naranja), con el detalle de qué cambió (propiedades, desplazamiento,
  dimensiones). Indica si el archivo que abres es la versión nueva o la anterior.
- **4D:** «Generar por niveles» crea una programación (cimentación → estructura → cerramientos → instalaciones,
  nivel a nivel) con la fecha de inicio y los días por actividad. Mueve la barra o pulsa **Reproducir**: lo no
  empezado se oculta y lo que está en ejecución se ve en verde. «Descargar CSV» la guarda para editarla en Excel
  (columnas Actividad; Inicio; Fin; Nivel; Clase IFC; GlobalId) e «Importar CSV…» la vuelve a cargar.

## Planta 2D (botón «Planta 2D»)
Elige el nivel y la altura de corte (1,2 m por defecto). Se dibuja el corte real de la geometría (trazo grueso y
relleno), lo que queda por encima en discontinuo (vigas, losa superior) y lo de debajo en fino, con las cotas
generales. **Cota:** clic en dos puntos (se pegan a los vértices); Ctrl+Z deshace. Rueda para zoom y arrastrar
para moverte. **PDF (A3)** a escala normalizada con cajetín, o **DXF** (metros, una capa por clase IFC) para
abrirlo en AutoCAD/Revit. Esc para volver al 3D.

## Problemas frecuentes
- **«No se pudo iniciar el motor IFC»**: cierra con `Ctrl + C` y vuelve a ejecutar `npm run dev`
  (copia los archivos WASM que necesita el lector IFC).
- **VR: «Este navegador no detecta las gafas»**: comprueba que Meta Quest Link está abierto, las gafas
  conectadas y que Link es el tiempo de ejecución de OpenXR (paso 2); usa Chrome o Edge y recarga la página.
- **Archivos .rvt**: no se abren directamente; exporta a IFC desde Revit. La lectura de RVT se
  evaluará más adelante con Autodesk Platform Services.
- **Modelos muy grandes**: la carga puede tardar y el navegador puede quedarse sin memoria. Cierra otras
  pestañas o exporta por disciplinas.

## Prueba automática (opcional)
Comprueba carga, geometría, selección, propiedades (comparadas con el IFC original), ocultar/aislar/restaurar
y cierre, usando el IFC de `test-models/`:
```
npx playwright install chromium
npm run build
npm run test:e2e
```
Para probar con tu modelo: `set IFC_FILE=C:\ruta\modelo.ifc` y después `npm run test:e2e`.
Las capturas quedan en `test-results/`.

## Publicar una versión nueva (para que se actualicen los programas instalados)
Requiere un repositorio **público** en GitHub con este proyecto (ver `CLAUDE.md`):
```
npm version patch --no-git-tag-version
git commit -am "Versión X.Y.Z"
git push
```
GitHub compila el instalador, ejecuta la prueba y lo publica; los programas instalados se actualizan solos.

Detalles técnicos, versiones y decisiones: ver `CLAUDE.md`.
