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

## Controles
| Acción | Cómo |
|---|---|
| Abrir modelo | Botón **Abrir IFC…** o arrastrar el archivo al visor |
| Orbitar | Arrastrar con el botón izquierdo |
| Desplazar | Arrastrar con el botón derecho |
| Zoom | Rueda del ratón |
| Encuadrar todo | Botón o tecla **F** |
| Seleccionar | Clic sobre un elemento (se pinta de naranja y sus datos salen a la derecha) |
| Deseleccionar | **Esc** |
| Ocultar selección | Botón **Ocultar** o tecla **H** |
| Ver solo la selección | Botón **Aislar** o tecla **I** |
| Volver a ver todo | Botón **Restaurar** o tecla **R** |
| Cerrar modelo y liberar memoria | Botón **Cerrar modelo** |

En el panel se ven GlobalId, clase IFC, nombre, tipo, material y los conjuntos de propiedades
(Psets y cantidades) de la instancia y del tipo.

## Problemas frecuentes
- **«No se pudo iniciar el motor IFC»**: cierra con `Ctrl + C` y vuelve a ejecutar `npm run dev`
  (copia los archivos WASM que necesita el lector IFC).
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
