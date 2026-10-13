// Prueba de extremo a extremo con un IFC REAL y un navegador real (Chromium vía Playwright).
//
// Uso:
//   npm run build && npm run test:e2e              (prueba la versión compilada)
//   npm run test:e2e -- --dev                      (prueba el servidor de desarrollo)
//   npm run build && npm run test:e2e -- --electron (aplicación de escritorio; en Linux: xvfb-run)
//   IFC_FILE=ruta/al/modelo.ifc npm run test:e2e   (otro IFC; por defecto el primero de test-models/)
//
// Qué comprueba (todo con el flujo real de la interfaz, sin geometría ficticia):
//   1. Carga mediante el botón «Abrir IFC…» y progreso por fases.
//   2. Que se dibuja geometría (píxeles del modelo en el lienzo WebGL).
//   3. Encuadre completo.
//   4. Selección con un clic real del ratón + resaltado (píxeles naranjas).
//   5. GlobalId, clase, nombre y Psets del panel, contrastados con web-ifc leyendo el IFC en Node.
//   6. Ocultar, aislar y restaurar (conteos del Hider y píxeles).
//   7. Cerrar modelo: liberación de memoria GPU y de la escena; recarga posterior.
//   8. Errores comprensibles con un archivo no IFC.
//   9. Que no se hace NINGUNA petición fuera de localhost.
import { chromium, _electron } from "playwright";
import { createServer, preview, build } from "vite";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import * as WebIFC from "web-ifc";
import { createRequire } from "node:module";
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { makeVariant } from "./variant.mjs";

const root = resolve(import.meta.dirname, "..");
const outDir = join(root, "test-results");
mkdirSync(outDir, { recursive: true });
const DEV = process.argv.includes("--dev");
const ELECTRON = process.argv.includes("--electron");
const HEADED = process.argv.includes("--headed");

const ifcPath = process.env.IFC_FILE
  ? resolve(process.env.IFC_FILE)
  : (() => {
      const dir = join(root, "test-models");
      const f = existsSync(dir) && readdirSync(dir).find((n) => n.toLowerCase().endsWith(".ifc"));
      if (!f) {
        console.error("✗ No hay ningún .ifc en test-models/. Copia uno allí o usa IFC_FILE=… (ver README).");
        process.exit(2);
      }
      return join(dir, f);
    })();

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---------- Referencia independiente: web-ifc en Node ----------
async function groundTruth(guid) {
  const api = new WebIFC.IfcAPI();
  await api.Init();
  const model = api.OpenModel(new Uint8Array(readFileSync(ifcPath)));
  const id = api.GetExpressIdFromGuid(model, guid);
  const line = api.GetLine(model, id);
  const val = (v) => (v && typeof v === "object" && "value" in v ? v.value : v);
  const psets = {};
  const rels = api.GetLineIDsWithType(model, WebIFC.IFCRELDEFINESBYPROPERTIES);
  for (let i = 0; i < rels.size(); i++) {
    const rel = api.GetLine(model, rels.get(i));
    if (!rel.RelatedObjects.some((o) => val(o) === id)) continue;
    const def = api.GetLine(model, val(rel.RelatingPropertyDefinition));
    const items = def.HasProperties ?? def.Quantities ?? [];
    const props = {};
    for (const p of items) {
      const pl = api.GetLine(model, val(p));
      const v = pl.NominalValue ?? pl.LengthValue ?? pl.AreaValue ?? pl.VolumeValue ?? pl.CountValue ?? pl.WeightValue;
      props[val(pl.Name)] = val(v);
    }
    psets[val(def.Name)] = props;
  }
  let storey = null;
  const cont = api.GetLineIDsWithType(model, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
  for (let i = 0; i < cont.size() && !storey; i++) {
    const rel = api.GetLine(model, cont.get(i));
    if (rel.RelatedElements.some((o) => val(o) === id)) storey = val(api.GetLine(model, val(rel.RelatingStructure)).Name);
  }
  const cls = api.GetNameFromTypeCode(api.GetLineType(model, id));
  api.CloseModel(model);
  return { expressId: id, ifcClass: cls, name: val(line.Name), psets, storey };
}

// ---------- Lectura de píxeles del lienzo WebGL ----------
const pixelStats = (page) =>
  page.evaluate(() => {
    const v = window.__viewer;
    const r = v.world.renderer.three;
    r.render(v.world.scene.three, v.world.camera.three); // render y lectura en la misma tarea
    const c = r.domElement;
    const tmp = document.createElement("canvas");
    tmp.width = c.width;
    tmp.height = c.height;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const dpr = c.width / c.clientWidth;
    let model = 0, highlight = 0;
    const samples = [];
    for (let y = 0; y < c.height; y += 2)
      for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4, R = d[i], G = d[i + 1], B = d[i + 2];
        if (R > 200 && G > 120 && G < 200 && B < 90) highlight++;
        else if (R > 125 && Math.abs(R - G) < 14 && Math.abs(G - B) < 14) {
          model++;
          if (samples.length < 4000) samples.push([x / dpr, y / dpr]);
        }
      }
    const rect = c.getBoundingClientRect();
    return { model, highlight, samples, left: rect.left, top: rect.top };
  });

const propsPanel = (page) =>
  page.evaluate(() => {
    const out = { identity: {}, psets: {}, text: {} };
    document.querySelectorAll('[data-testid="identity"] tr').forEach((tr) => {
      out.identity[tr.querySelector("th").textContent] = tr.querySelector("td").textContent;
    });
    document.querySelectorAll("#props details.sec:not([data-testid])").forEach((d) => {
      const name = d.querySelector("summary").childNodes[0].textContent.trim();
      const props = {}, text = {};
      d.querySelectorAll("tr").forEach((tr) => {
        const k = tr.querySelector("th").textContent, td = tr.querySelector("td");
        props[k] = td.dataset.raw;
        text[k] = td.textContent;
      });
      out.psets[name] = props;
      out.text[name] = text;
    });
    return out;
  });

const fmt = (v) => (v == null ? "—" : String(v));
/** El panel guarda el valor original en data-raw: debe coincidir con el IFC (números con tolerancia). */
const same = (panelRaw, ifcValue) => {
  if (panelRaw === undefined) return false;
  if (typeof ifcValue === "number") return Math.abs(Number(panelRaw) - ifcValue) <= Math.abs(ifcValue) * 1e-9 + 1e-12;
  return panelRaw === fmt(ifcValue);
};

// ---------- Emulador WebXR (IWER) ----------
const IWER_INIT =
  readFileSync(join(root, "node_modules/iwer/build/iwer.min.js"), "utf8") +
  "\n;window.__xrdev = new IWER.XRDevice(IWER.metaQuest3); window.__xrdev.installRuntime({ forceInstall: true });";

// ---------- Referencia independiente para interferencias: geometría de web-ifc en Node ----------
let wifc = null;
async function webIfcModel() {
  if (wifc) return wifc;
  const api = new WebIFC.IfcAPI();
  await api.Init();
  const model = api.OpenModel(new Uint8Array(readFileSync(ifcPath)));
  api.CreateIfcGuidToExpressIdMapping(model);
  wifc = { api, model };
  return wifc;
}
/** Triángulos (coordenadas IFC) de un elemento por GlobalId, triangulados por web-ifc. */
async function webIfcTriangles(guid) {
  const { api, model } = await webIfcModel();
  const id = api.GetExpressIdFromGuid(model, guid);
  const flat = api.GetFlatMesh(model, id);
  const out = [];
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  for (let i = 0; i < flat.geometries.size(); i++) {
    const pg = flat.geometries.get(i);
    m.fromArray(pg.flatTransformation);
    const g = api.GetGeometry(model, pg.geometryExpressID);
    const verts = api.GetVertexArray(g.GetVertexData(), g.GetVertexDataSize());
    const idx = api.GetIndexArray(g.GetIndexData(), g.GetIndexDataSize());
    for (const k of idx) {
      v.set(verts[k * 6], verts[k * 6 + 1], verts[k * 6 + 2]).applyMatrix4(m);
      out.push(v.x, v.y, v.z);
    }
    g.delete?.();
  }
  return new Float32Array(out);
}
async function webIfcIntersect(guidA, guidB) {
  const geo = (t) => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(t, 3)); return g; };
  const a = geo(await webIfcTriangles(guidA)), b = geo(await webIfcTriangles(guidB));
  return new MeshBVH(a).intersectsGeometry(b, new THREE.Matrix4());
}
/** Recuento de elementos de una clase que tienen (o no) una propiedad, leído con web-ifc. */
async function webIfcPropCount(type, psetName, propName) {
  const { api, model } = await webIfcModel();
  const val = (x) => (x && typeof x === "object" && "value" in x ? x.value : x);
  const ids = api.GetLineIDsWithType(model, type);
  const all = new Set();
  for (let i = 0; i < ids.size(); i++) all.add(ids.get(i));
  const withProp = new Set();
  const rels = api.GetLineIDsWithType(model, WebIFC.IFCRELDEFINESBYPROPERTIES);
  for (let i = 0; i < rels.size(); i++) {
    const rel = api.GetLine(model, rels.get(i));
    const objs = rel.RelatedObjects.map(val).filter((o) => all.has(o));
    if (!objs.length) continue;
    const def = api.GetLine(model, val(rel.RelatingPropertyDefinition));
    if (val(def.Name) !== psetName || !def.HasProperties) continue;
    if (def.HasProperties.some((h) => val(api.GetLine(model, val(h)).Name) === propName)) objs.forEach((o) => withProp.add(o));
  }
  return { total: all.size, pass: withProp.size, fail: all.size - withProp.size };
}

// ---------- Servidor / aplicación ----------
let server, url, browser, page, electronApp;
const GL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
if (ELECTRON) {
  if (!existsSync(join(root, "dist", "index.html"))) await build({ root, logLevel: "warn" });
  electronApp = await _electron.launch({
    args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), ...GL_ARGS, root],
    cwd: root,
    env: { ...process.env, VISOR_VR_NO_BROWSER: "1" },
  });
  page = await electronApp.firstWindow();
  await page.setViewportSize({ width: 1400, height: 850 }).catch(() => {});
  url = page.url();
  console.log(`Aplicación de escritorio Electron: ${url}`);
} else {
  if (DEV) {
    server = await createServer({ root, server: { port: 5199, open: false }, logLevel: "warn" });
    await server.listen();
    url = server.resolvedUrls.local[0];
  } else {
    if (!existsSync(join(root, "dist", "index.html"))) await build({ root, logLevel: "warn" });
    server = await preview({ root, preview: { port: 5198, open: false }, logLevel: "warn" });
    url = server.resolvedUrls.local[0];
  }
  console.log(`Servidor ${DEV ? "dev" : "preview (build)"}: ${url}`);
  browser = await chromium.launch({ headless: !HEADED, args: GL_ARGS });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, permissions: ["clipboard-read", "clipboard-write"] });
  page = await ctx.newPage();
  // Gafas VR emuladas (IWER de Meta, Quest 3): sustituye a navigator.xr para probar la sesión WebXR.
  await page.addInitScript({ content: IWER_INIT });
}
console.log(`IFC de prueba: ${ifcPath}\n`);

const external = [];
const consoleErrors = [];
page.on("request", (r) => {
  const u = new URL(r.url());
  if (/^(blob|data|app|devtools|file):/.test(u.protocol)) return;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) external.push(r.url());
});
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(e.message));

const openViaButton = async (file) => {
  if (ELECTRON) {
    // En Electron el diálogo nativo no se puede automatizar: se rellena el mismo <input> que abre el botón.
    await page.setInputFiles("#file-input", file);
    return;
  }
  const chooser = page.waitForEvent("filechooser");
  await page.click("#btn-open");
  await (await chooser).setFiles(file);
};
const waitState = (s) =>
  page.waitForFunction((s) => document.body.dataset.modelState === s || document.body.dataset.modelState === "error", s, {
    timeout: 300_000,
  });

try {
  if (!ELECTRON) await page.goto(url);
  await page.waitForSelector("body[data-viewer-ready]", { timeout: 30_000 });
  check("El visor se inicia (WebGL + worker + WASM)", true);
  const viewerInstances = await page.evaluate(() => document.querySelectorAll("#viewport canvas").length);
  check("Una sola instancia del visor (un único canvas)", viewerInstances === 1, `${viewerInstances} canvas`);

  // 1. Carga + progreso
  await page.evaluate(() => {
    window.__stages = [];
    new MutationObserver(() => {
      const t = document.getElementById("progress-stage").textContent;
      if (window.__stages.at(-1) !== t) window.__stages.push(t);
    }).observe(document.getElementById("progress-stage"), { childList: true, characterData: true, subtree: true });
  });
  const t0 = Date.now();
  await openViaButton(ifcPath);
  await waitState("loaded");
  const state = await page.evaluate(() => document.body.dataset.modelState);
  const loadSecs = ((Date.now() - t0) / 1000).toFixed(1);
  check("Carga del IFC con el botón", state === "loaded", `${basename(ifcPath)} en ${loadSecs} s`);
  if (state !== "loaded") throw new Error(`Carga fallida: ${await page.textContent("#toast")}`);
  const stages = await page.evaluate(() => window.__stages);
  check("Progreso por fases visible", stages.length >= 3, stages.join(" → "));
  check("Mensaje de bienvenida oculto tras cargar", await page.isHidden("#empty"));

  // 2-3. Geometría y encuadre
  await page.click("#btn-fit");
  await page.waitForTimeout(800);
  const px = await pixelStats(page);
  const total = await page.evaluate(() => {
    const c = window.__viewer.world.renderer.three.domElement;
    return (c.width * c.height) / 4;
  });
  check("Geometría real dibujada", px.model > total * 0.02, `${((px.model / total) * 100).toFixed(1)} % del lienzo`);
  const mem = await page.evaluate(() => window.__viewer.debugInfo());
  check("Geometrías en GPU", mem.renderer.geometries > 0, JSON.stringify(mem.renderer));
  await page.screenshot({ path: join(outDir, "01-cargado.png") });

  // Navegación tipo Revizto (modo Recorrido por defecto)
  const pose = () => page.evaluate(() => window.__viewer.nav.debugPose());
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const len = (v) => Math.hypot(...v);
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const box = await page.locator("#viewport canvas").boundingBox();
  check("HUD de navegación visible en modo Recorrido", (await page.isVisible("#nav-hud")) && (await page.getAttribute('[data-mode="fly"]', "class")).includes("active"));
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  const keyMove = async (code, ms = 700, shift = false) => {
    const a = await pose();
    if (shift) await page.keyboard.down("Shift");
    await page.keyboard.down(code);
    await page.waitForTimeout(ms);
    await page.keyboard.up(code);
    if (shift) await page.keyboard.up("Shift");
    await page.waitForTimeout(300);
    const z = await pose();
    const d = sub(z.pos, a.pos);
    const right = [-a.dir[2], 0, a.dir[0]]; // dir × (0,1,0)
    const rn = len(right) || 1;
    return { d, dist: len(d), fwd: dot(d, a.dir) / (len(d) || 1), right: dot(d, right) / rn / (len(d) || 1), up: d[1] / (len(d) || 1), dirSame: len(sub(z.dir, a.dir)) < 1e-6 };
  };
  const mW = await keyMove("KeyW"), mS = await keyMove("KeyS"), mA = await keyMove("KeyA"), mD = await keyMove("KeyD");
  const mE = await keyMove("KeyE"), mQ = await keyMove("KeyQ");
  check("W/S avanzan y retroceden según la vista", mW.fwd > 0.99 && mS.fwd < -0.99 && mW.dist > 0.5, `W ${mW.dist.toFixed(2)} m, S ${mS.dist.toFixed(2)} m`);
  check("A/D se desplazan a izquierda/derecha", mA.right < -0.99 && mD.right > 0.99 && Math.abs(mA.up) < 1e-6, `A ${mA.dist.toFixed(2)} m, D ${mD.dist.toFixed(2)} m`);
  check("E sube y Q baja (vertical)", mE.up > 0.999 && mQ.up < -0.999, `E +${mE.d[1].toFixed(2)} m, Q ${mQ.d[1].toFixed(2)} m`);
  check("Las teclas no giran la vista", [mW, mS, mA, mD, mE, mQ].every((m) => m.dirSame));
  const mShift = await keyMove("KeyW", 700, true);
  const mW2 = await keyMove("KeyW", 700);
  check("Shift acelera el movimiento", mShift.dist > mW2.dist * 2, `${mShift.dist.toFixed(2)} m con Shift vs ${mW2.dist.toFixed(2)} m sin Shift`);
  const v0 = await page.textContent("#speed-val");
  await page.click("#speed-up");
  const v1 = await page.textContent("#speed-val");
  await page.click("#speed-down");
  check("Control de velocidad", v0 === "1×" && v1 === "2×" && (await page.textContent("#speed-val")) === "1×", `${v0} → ${v1}`);

  let a = await pose();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5 + 120, box.y + box.height * 0.5 - 30, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  let z = await pose();
  const rightA = [-a.dir[2], 0, a.dir[0]];
  check(
    "Arrastrar con botón izquierdo = mirar (gira sin moverse)",
    len(sub(z.pos, a.pos)) < 0.05 && dot(z.dir, rightA) > 0.1 && z.dir[1] > a.dir[1],
    `giro ${((Math.acos(Math.min(1, dot(z.dir, a.dir))) * 180) / Math.PI).toFixed(1)}°, hacia la derecha y arriba`,
  );
  a = await pose();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + box.width * 0.5 - 100, box.y + box.height * 0.5, { steps: 10 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(300);
  z = await pose();
  check("Arrastrar con botón derecho = desplazar (sin girar)", len(sub(z.pos, a.pos)) > 0.1 && len(sub(z.dir, a.dir)) < 1e-6, `${len(sub(z.pos, a.pos)).toFixed(2)} m`);

  await page.click("#btn-fit");
  await page.waitForTimeout(1200);
  a = await pose();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -100);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1500);
  z = await pose();
  const wd = sub(z.pos, a.pos);
  check("Rueda: acerca hacia el cursor", len(wd) > 0.5 && dot(wd, a.dir) / len(wd) > 0.95, `${len(wd).toFixed(2)} m hacia el centro de la vista`);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1500);
  const z2 = await pose();
  check("Rueda: aleja al girarla al revés", dot(sub(z2.pos, z.pos), a.dir) < -0.5);

  await page.click('[data-mode="orbit"]');
  await page.waitForTimeout(800);
  const orbitDist = () => page.evaluate(() => window.__viewer.world.camera.controls.distance);
  const d0 = await orbitDist();
  a = await pose();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  z = await pose();
  const d1 = await orbitDist();
  check("Modo Órbita: gira alrededor de un punto del modelo", d0 > 1 && Math.abs(d1 - d0) < d0 * 0.02 && len(sub(z.pos, a.pos)) > 1, `radio ${d0.toFixed(1)} m, desplazamiento ${len(sub(z.pos, a.pos)).toFixed(1)} m`);
  await page.click('[data-mode="fly"]');
  await page.waitForTimeout(500);
  check("Volver a Recorrido", (await page.evaluate(() => document.body.dataset.navMode)) === "fly" && (await orbitDist()) < 0.05);
  await page.click("#btn-fit");
  await page.waitForTimeout(800);
  const afterFit = await pixelStats(page);
  check("«Encuadrar todo» vuelve a mostrar el modelo", afterFit.model > total * 0.02);

  // 4. Selección con clic real
  let selected = false;
  const pts = afterFit.samples;
  for (let k = 0; k < 25 && !selected; k++) {
    const [x, y] = pts[Math.floor((k + 0.5) * (pts.length / 25))];
    await page.mouse.click(afterFit.left + x, afterFit.top + y);
    try {
      await page.waitForSelector('[data-testid="identity"]', { timeout: 3000 });
      selected = true;
    } catch {}
  }
  check("Selección con clic sobre el modelo", selected);
  if (!selected) throw new Error("No se pudo seleccionar ningún elemento con el ratón");
  await page.waitForTimeout(500);
  const pxSel = await pixelStats(page);
  check("Elemento resaltado en naranja", pxSel.highlight > 20, `${pxSel.highlight} píxeles`);
  const panel = await propsPanel(page);
  await page.screenshot({ path: join(outDir, "02-seleccion.png") });

  // 5. Contraste con web-ifc
  const guid = panel.identity["GlobalId"];
  const truth = await groundTruth(guid);
  check("GlobalId mostrado existe en el IFC", truth.expressId > 0, `${guid} → #${truth.expressId}`);
  check("Clase IFC correcta", panel.identity["Clase IFC"] === truth.ifcClass, `${panel.identity["Clase IFC"]} / ${truth.ifcClass}`);
  check("Nombre correcto", panel.identity["Nombre"] === (truth.name ?? "—"), panel.identity["Nombre"]);
  const expected = Object.keys(truth.psets).sort();
  const shown = Object.keys(panel.psets).sort();
  check("Conjuntos de propiedades de instancia completos", expected.every((n) => shown.includes(n)), `IFC: [${expected.join(", ")}] · panel: [${shown.join(", ")}]`);
  let mismatches = [];
  for (const [ps, props] of Object.entries(truth.psets))
    for (const [k, v] of Object.entries(props))
      if (!same(panel.psets[ps]?.[k], v)) mismatches.push(`${ps}.${k}: IFC=${fmt(v)} panel=${panel.psets[ps]?.[k]}`);
  check("Valores de propiedades idénticos al IFC", mismatches.length === 0, mismatches.slice(0, 5).join("; ") || `${Object.values(truth.psets).reduce((n, p) => n + Object.keys(p).length, 0)} valores`);

  // 5b. Un elemento de cada clase con geometría, contrastado con web-ifc
  const guids = await page.evaluate(async () => {
    const [model] = [...window.__viewer.fragmentsManager.list.values()];
    const cats = (await model.getItemsWithGeometryCategories()).filter(Boolean);
    const out = [];
    for (const cat of [...new Set(cats)].slice(0, 8)) {
      const items = await model.getItemsOfCategories([new RegExp(`^${cat}$`)]);
      const id = Object.values(items).flat()[0];
      if (id !== undefined) out.push((await model.getGuidsByLocalIds([id]))[0]);
    }
    return out;
  });
  const perClass = [];
  for (const g of guids) {
    await page.evaluate((g) => window.__viewer.selectByGuid(g), g);
    await page.waitForFunction((g) => [...document.querySelectorAll('[data-testid="identity"] tr')].some((tr) => tr.querySelector("th").textContent === "GlobalId" && tr.querySelector("td").textContent === g), g, { timeout: 10_000 });
    const pnl = await propsPanel(page);
    const t = await groundTruth(g);
    const bad = [];
    if (pnl.identity["Clase IFC"] !== t.ifcClass) bad.push("clase");
    if (pnl.identity["Nombre"] !== (t.name ?? "—")) bad.push("nombre");
    for (const [ps, props] of Object.entries(t.psets))
      for (const [k, v] of Object.entries(props)) if (!same(pnl.psets[ps]?.[k], v)) bad.push(`${ps}.${k}`);
    if (t.storey && !(pnl.identity["Nivel"] ?? "").startsWith(t.storey)) bad.push("nivel");
    perClass.push(`${t.ifcClass}${bad.length ? ` ✗(${bad.join(",")})` : " ✓"}`);
  }
  check("Datos correctos en un elemento de cada clase", perClass.every((s) => s.endsWith("✓")), perClass.join(" · "));

  // Panel de información: nivel, unidades, búsqueda y copia
  const beamGuid = guids.find(Boolean);
  await page.evaluate((g) => window.__viewer.selectByGuid(g), beamGuid);
  await page.waitForFunction((g) => [...document.querySelectorAll('[data-testid="identity"] tr')].some((tr) => tr.querySelector("th").textContent === "GlobalId" && tr.querySelector("td").textContent === g), beamGuid);
  const pb = await propsPanel(page);
  const tb = await groundTruth(beamGuid);
  check("Nivel (planta) del elemento", !!tb.storey && (pb.identity["Nivel"] ?? "").startsWith(tb.storey), pb.identity["Nivel"]);
  const unitTexts = Object.values(pb.text).flatMap((o) => Object.values(o));
  check("Valores con unidades del proyecto", unitTexts.some((t) => / m³$/.test(t)) && unitTexts.some((t) => / mm$/.test(t)), unitTexts.filter((t) => / (m³|m²|mm)$/.test(t)).slice(0, 4).join(", "));
  const firstProp = Object.keys(Object.values(pb.psets)[0] ?? {})[0];
  await page.fill(".prop-search", firstProp);
  await page.waitForTimeout(200);
  const visibleRows = await page.$$eval("#props tr:not([hidden])", (rows) => rows.filter((r) => r.closest("details:not([hidden])")).map((r) => r.textContent.toLowerCase()));
  check("Buscador filtra propiedades", visibleRows.length > 0 && visibleRows.every((t) => t.includes(firstProp.toLowerCase())) && (await page.textContent(".search-count")).includes("resultado"), `«${firstProp}»: ${visibleRows.length} fila(s)`);
  await page.fill(".prop-search", "");
  if (!ELECTRON) {
    await page.click('[data-testid="identity"] tr:nth-child(3) td');
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch((e) => "ERR " + e.message));
    check("Clic en un valor lo copia al portapapeles", clip === beamGuid && (await page.textContent("#toast")).includes("Copiado"), clip);
  }
  await page.screenshot({ path: join(outDir, "05-panel.png") });
  await page.evaluate((g) => window.__viewer.selectByGuid(g), guid);
  await page.waitForFunction((g) => [...document.querySelectorAll('[data-testid="identity"] tr')].some((tr) => tr.querySelector("th").textContent === "GlobalId" && tr.querySelector("td").textContent === g), guid);

  // 6. Ocultar / aislar / restaurar
  const counts0 = await page.evaluate(() => window.__viewer.visibilityCounts());
  await page.click("#btn-hide");
  await page.waitForTimeout(600);
  const counts1 = await page.evaluate(() => window.__viewer.visibilityCounts());
  check("Ocultar: 1 elemento oculto", counts1.hidden === 1 && counts1.visible === counts0.visible - 1, JSON.stringify(counts1));
  check("Ocultar: selección y resaltado eliminados", (await pixelStats(page)).highlight === 0 && (await page.isDisabled("#btn-hide")));
  check("Indicador «Hay elementos ocultos»", (await page.textContent("#visibility-badge")) === "Hay elementos ocultos" && (await page.isVisible("#visibility-badge")));
  await page.screenshot({ path: join(outDir, "03-oculto.png") });

  await page.click("#btn-show");
  await page.waitForTimeout(600);
  const counts2 = await page.evaluate(() => window.__viewer.visibilityCounts());
  check("Restaurar: todo visible", counts2.hidden === 0 && counts2.visible === counts0.visible, JSON.stringify(counts2));

  const ok = await page.evaluate((g) => window.__viewer.selectByGuid(g), guid);
  await page.waitForSelector('[data-testid="identity"]');
  await page.click("#btn-isolate");
  await page.waitForTimeout(600);
  const counts3 = await page.evaluate(() => window.__viewer.visibilityCounts());
  check("Aislar: solo 1 elemento visible", ok && counts3.visible === 1, JSON.stringify(counts3));
  await page.click("#btn-fit-sel");
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(outDir, "04-aislado.png") });
  await page.keyboard.press("r");
  await page.waitForTimeout(600);
  const counts4 = await page.evaluate(() => window.__viewer.visibilityCounts());
  check("Restaurar con la tecla R", counts4.hidden === 0, JSON.stringify(counts4));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Esc deselecciona", (await page.textContent("#props")).includes("Haz clic en un elemento"));

  // 6b. Vista realista y materiales (texturas)
  {
    const usedMaterials = () =>
      page.evaluate(() => {
        const used = {};
        window.__viewer.world.scene.three.traverse((o) => {
          if (!o.isMesh || o.name.startsWith("visor-")) return;
          for (const m of [].concat(o.material)) {
            const k = m.userData?.customId ?? "base";
            used[k] = used[k] ?? { n: 0, maps: [], opacity: [] };
            used[k].n++;
            if (m.map?.name && !used[k].maps.includes(m.map.name)) used[k].maps.push(m.map.name);
            if (!used[k].opacity.includes(m.opacity)) used[k].opacity.push(m.opacity);
          }
        });
        return used;
      });
    const waitFor = async (fn, arg, timeout = 90_000) => {
      try {
        return await page.waitForFunction(fn, arg, { timeout, polling: 500 });
      } catch (e) {
        const state = await page.evaluate(() => JSON.stringify({ view: document.body.dataset.view, ...window.__viewer.appearance.debug() })).catch(() => "?");
        throw new Error(`${e.message.split("\n")[0]} · esperando: ${fn.toString().slice(0, 140)} · estado: ${state.slice(0, 700)}`);
      }
    };
    await page.setViewportSize({ width: 900, height: 560 }); // en SwiftShader cada fotograma realista cuesta segundos
    await page.evaluate(() => localStorage.removeItem("visor.materials.profile"));
    await page.evaluate(() => window.__viewer.appearance.clearProfile());
    await page.evaluate(() => window.__viewer.fitAll());
    check("Los materiales base son PBR (MeshStandardMaterial)", await page.evaluate(() => { let ok = false, bad = false; window.__viewer.world.scene.three.traverse((o) => { if (o.isMesh && !o.name.startsWith("visor-")) for (const m of [].concat(o.material)) { if (m.isMeshStandardMaterial) ok = true; if (m.isMeshLambertMaterial && !m.userData?.customId) bad = true; } }); return ok && !bad; }));

    await page.click('[data-tab="materials"]');
    await page.waitForSelector(".mat-list .mat", { timeout: 60_000 });
    const groups = await page.$$eval(".mat", (els) => els.map((e) => ({ name: e.dataset.name, count: Number(e.querySelector(".count").textContent) })));
    const ifcMaterials = (() => {
      const names = new Set();
      for (const m of readFileSync(ifcPath, "latin1").matchAll(/=IFCMATERIAL\('([^']*)'/g)) names.add(m[1]);
      return names;
    })();
    const withGeometry = await page.evaluate(async () => (await [...window.__viewer.fragmentsManager.list.values()][0].getItemsIdsWithGeometry()).length);
    const total = groups.reduce((n, g) => n + g.count, 0);
    check(
      "Panel Materiales: grupos por material IFC con recuento",
      groups.length > 1 && groups.filter((g) => g.name !== "(sin material)").every((g) => ifcMaterials.has(g.name)) && total === withGeometry,
      groups.map((g) => `${g.name} (${g.count})`).join(" · ") + ` = ${total} de ${withGeometry} elementos con geometría`,
    );

    const t0 = Date.now();
    await page.click('[data-act="auto"]');
    await waitFor(() => document.body.dataset.view === "realistic");
    const presets = await page.$$eval(".mat", (els) => Object.fromEntries(els.map((e) => [e.dataset.name, e.dataset.preset])));
    const concreteName = groups.find((g) => /concrete/i.test(g.name))?.name;
    const steelName = groups.find((g) => /steel/i.test(g.name))?.name;
    check("Asignación automática por nombre (hormigón → Hormigón, acero → Acero)", presets[concreteName] === "concrete" && presets[steelName] === "steel", JSON.stringify(presets));
    // El cielo y el mapa de entorno se generan con un pequeño retardo (Environment.scheduleEnvMap)
    await page.waitForFunction(() => !!window.__viewer.world.scene.three.environment, null, { timeout: 30_000 }).catch(() => {});
    const env = await page.evaluate(() => { const v = window.__viewer, sc = v.world.scene.three, r = v.world.renderer.three; return { env: !!sc.environment, bg: !!sc.background?.isCubeTexture, aces: r.toneMapping === 4, shadows: r.shadowMap.enabled, sun: !!sc.getObjectByName("visor-sun") }; });
    check("Vista realista: cielo, iluminación de entorno, sol con sombras y ACES", env.env && env.bg && env.aces && env.shadows && env.sun, `${JSON.stringify(env)} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await waitFor((name) => Object.keys(window.__viewer.appearance.debug().registry).length > 0, null);
    let used = await usedMaterials();
    const textured = Object.entries(used).filter(([k, u]) => k.startsWith("mat:g:") && u.maps.length);
    check("Elementos dibujados con material texturizado", textured.length > 0, textured.map(([k, u]) => `${u.maps.join("+")} en ${u.n} malla(s)`).join(", "));
    // Regresión: Fragments dibuja los elementos con estilo sobre la geometría base en la misma
    // posición; si un estilo no va delante (desfase de profundidad), se ve el material base.
    const offs = await page.evaluate(() => {
      let maxStyle = -Infinity, minBase = Infinity;
      window.__viewer.world.scene.three.traverse((o) => {
        if (!o.isMesh || o.userData.tileId === undefined) return;
        for (const m of [].concat(o.material)) {
          if (m.isLodMaterial || m.isShaderMaterial || !m.polygonOffset) continue;
          if (m.userData?.customId) maxStyle = Math.max(maxStyle, m.polygonOffsetFactor);
          else minBase = Math.min(minBase, m.polygonOffsetFactor);
        }
      });
      return { maxStyle, minBase };
    });
    check("Apariencias por delante de la geometría base (sin parpadeo ni material base encima)", offs.maxStyle < 0 && offs.maxStyle < offs.minBase, JSON.stringify(offs));
    await page.screenshot({ path: join(outDir, "06-realista.png"), timeout: 240_000 });

    // Cambiar a ladrillo y editar en vivo
    const sel = (n) => `.mat[data-name="${n.replace(/"/g, '\\"')}"]`;
    // Selector de acabados propio (no un desplegable nativo, que se cerraba solo al redibujar el panel)
    await page.click(`${sel(concreteName)} [data-act="pick"]`);
    await page.click('.picker [data-preset="brick"]');
    await waitFor(() => Object.values(window.__viewer.appearance.debug().registry).flat().some((m) => m.map === "brick"));
    await page.click(`${sel(concreteName)} .mat-row`);
    await page.waitForSelector(`${sel(concreteName)} .editor`);
    await page.$eval(`${sel(concreteName)} input[data-key="roughness"]`, (el) => { el.value = "0.25"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await waitFor(() => Object.values(window.__viewer.appearance.debug().registry).flat().some((m) => m.map === "brick" && Math.abs(m.roughness - 0.25) < 1e-6));
    check("Cambiar preset (Ladrillo) y editar rugosidad en vivo", true);
    const saved = await page.evaluate((n) => JSON.parse(localStorage.getItem("visor.materials.profile")).byMaterial[n], concreteName);
    check("El perfil de materiales se guarda en el equipo", saved?.preset === "brick" && saved?.roughness === 0.25, JSON.stringify(saved));

    // Selección sobre la vista realista y asignación por elemento
    const groupIds = await page.evaluate((n) => window.__viewer.appearance.groups.find((g) => g.name === n).localIds, concreteName);
    await page.evaluate((ids) => window.__viewer.selectLocalIds(ids), groupIds);
    await waitFor(() => { let s = false; window.__viewer.world.scene.three.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) if (m.userData?.customId === "select") s = true; }); return s; });
    check("La selección se ve por encima del material", true);
    await page.waitForSelector('[data-testid="sel-box"]');
    await page.click('[data-act="sel-pick"]');
    await page.click('.picker [data-preset="glass"]');
    await page.evaluate(() => window.__viewer.clearSelection());
    // Tras deseleccionar: el vidrio debe estar y NO debe quedar ningún material de selección (bug de
    // Fragments: los elementos se quedaban naranjas si el estilo se creaba con la selección activa).
    // Se miran los tramos de geometría que realmente se dibujan (Fragments deja materiales sin usar en la lista).
    await waitFor(() => {
      let g = false, sel = false;
      window.__viewer.world.scene.three.traverse((o) => {
        if (!o.isMesh || !Array.isArray(o.material)) return;
        for (const gr of o.geometry.groups) {
          const m = o.material[gr.materialIndex];
          if (!m || gr.count === 0) continue;
          if (String(m.userData?.customId).startsWith("mat:o:") && m.opacity < 1) g = true;
          if (m.userData?.customId === "select") sel = true;
        }
      });
      return g && !sel;
    });
    used = await usedMaterials();
    check("Material por elemento (vidrio) aplicado sobre el del grupo al deseleccionar", Object.entries(used).some(([k, u]) => k.startsWith("mat:o:") && u.opacity.some((o) => o < 1)), Object.entries(used).map(([k, u]) => `${k}:${u.n}${u.maps.length ? "(" + u.maps + ")" : ""}${u.opacity.some((o) => o < 1) ? "[transp.]" : ""}`).join(" "));
    await page.screenshot({ path: join(outDir, "07-vidrio-ladrillo.png"), timeout: 240_000 });

    // Menú del botón derecho: material por TIPO y por INSTANCIA
    {
      // Punto de la pantalla sobre un elemento cuyo tipo tiene varias instancias (se busca con el raycast de la app).
      const target = await page.evaluate(async () => {
        const v = window.__viewer, r = v.canvas.getBoundingClientRect();
        for (let gy = 0.3; gy <= 0.8; gy += 0.05)
          for (let gx = 0.2; gx <= 0.8; gx += 0.05) {
            const x = r.left + r.width * gx, y = r.top + r.height * gy;
            const id = await v.pickAt(x, y);
            if (id === null) continue;
            const c = v.appearance.elementContext(id);
            if (c.type && c.type.localIds.length > 1 && !c.own) return { x, y, id, type: c.type.key, n: c.type.localIds.length };
          }
        return null;
      });
      if (!target) throw new Error("No se encontró en pantalla ningún elemento con tipo IFC compartido");
      await page.mouse.move(target.x, target.y);
      await page.mouse.down({ button: "right" });
      await page.mouse.up({ button: "right" });
      try {
        await page.waitForSelector(".ctx-menu:not([hidden])", { timeout: 30_000 });
      } catch (e) {
        const why = await page.evaluate(() => window.__ctx?.lastIgnored).catch(() => "?");
        throw new Error(`El menú contextual no se abrió (${why})`);
      }
      const menuId = Number(await page.getAttribute(".ctx-menu", "data-local-id"));
      const tabs = await page.$$eval(".ctx-tab", (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
      check("Clic derecho sobre un elemento abre el menú de materiales (instancia / tipo / material IFC)", menuId === target.id && tabs.length === 3, tabs.join(" | "));
      await page.click('.ctx-tab[data-scope="type"]');
      await page.click('.ctx-menu [data-preset="wood"]');
      await waitFor((k) => window.__viewer.appearance.profile.byType[k]?.preset === "wood" && Object.values(window.__viewer.appearance.debug().registry).flat().some((m) => m.map === "wood"), target.type);
      await waitFor(() => {
        let ok = false;
        window.__viewer.world.scene.three.traverse((o) => {
          if (!o.isMesh || !Array.isArray(o.material)) return;
          for (const gr of o.geometry.groups) { const m = o.material[gr.materialIndex]; if (m && gr.count > 0 && String(m.userData?.customId).startsWith("mat:t:") && m.map?.name === "wood") ok = true; }
        });
        return ok;
      });
      const stillOpen = await page.isVisible(".ctx-menu");
      check("Material por tipo: todas las instancias del tipo con Madera (el menú sigue abierto)", stillOpen, `${target.type} · ${target.n} elementos`);
      await page.click('.ctx-tab[data-scope="instance"]');
      await page.click('.ctx-menu [data-preset="paint"]');
      await waitFor((id) => window.__viewer.appearance.elementContext(id).own?.preset === "paint" && /por instancia/.test(document.querySelector(".ctx-sub")?.textContent ?? ""), target.id);
      const ctxAfter = await page.evaluate((id) => { const c = window.__viewer.appearance.elementContext(id); return { own: c.own?.preset, type: c.typeCfg?.preset, sub: document.querySelector(".ctx-sub")?.textContent }; }, target.id);
      const typeOthers = await page.evaluate((k) => { const a = window.__viewer.appearance; return a.types.get(k).localIds.filter((i) => a.elementContext(i).own).length; }, target.type);
      check("Material por instancia: solo ese elemento cambia y manda sobre el del tipo", ctxAfter.own === "paint" && ctxAfter.type === "wood" && typeOthers === 1 && /por instancia/.test(ctxAfter.sub), JSON.stringify(ctxAfter));
      await page.screenshot({ path: join(outDir, "08-menu-contextual.png"), timeout: 240_000 });
      await page.keyboard.press("Escape");
      check("Esc cierra el menú", await page.isHidden(".ctx-menu"));
      // Arrastrar con el derecho desplaza la vista y NO abre el menú
      await page.mouse.move(target.x, target.y);
      await page.mouse.down({ button: "right" });
      await page.mouse.move(target.x + 40, target.y + 10, { steps: 4 });
      await page.mouse.up({ button: "right" });
      await page.waitForTimeout(300);
      check("Arrastrar con el botón derecho no abre el menú", await page.isHidden(".ctx-menu"));
      await page.evaluate(() => window.__viewer.fitAll());
    }

    // Exportar / importar perfil
    const exported = await page.evaluate(() => window.__viewer.appearance.exportProfile());
    await page.evaluate(() => window.__viewer.appearance.clearProfile());
    await page.evaluate((j) => window.__viewer.appearance.importProfile(j), exported);
    const reimported = await page.evaluate((n) => window.__viewer.appearance.configForMaterial(n), concreteName);
    check("Exportar e importar el perfil de materiales (incluye tipos)", reimported?.preset === "brick" && JSON.parse(exported).byMaterial[concreteName]?.preset === "brick" && Object.values(JSON.parse(exported).byType ?? {}).some((c) => c.preset === "wood"));

    // Entorno: hora del día
    await page.click('[data-tab="env"]');
    const sunA = await page.evaluate(() => window.__viewer.world.scene.three.getObjectByName("visor-sun").position.toArray());
    await page.$eval('input[data-env="hour"]', (el) => { el.value = "8"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    const sunB = await page.evaluate(() => window.__viewer.world.scene.three.getObjectByName("visor-sun").position.toArray());
    check("Entorno: la hora del día mueve el sol", sunA[1] > sunB[1], `altura del sol ${sunA[1].toFixed(1)} → ${sunB[1].toFixed(1)}`);
    await page.$eval('input[data-env="hour"]', (el) => { el.value = "15"; el.dispatchEvent(new Event("input", { bubbles: true })); });

    // Volver a técnica
    await page.click('[data-view="technical"]');
    await waitFor(() => document.body.dataset.view === "technical");
    // La operación es asíncrona (el indicador de vista cambia al empezar): esperar a que termine.
    await waitFor(() => window.__viewer.appearance.debug().styles.length === 0 && !window.__viewer.world.scene.three.environment, null, 30_000);
    const tech = await page.evaluate(() => { const v = window.__viewer, sc = v.world.scene.three; return { styles: v.appearance.debug().styles.length, env: !!sc.environment, sun: !!sc.getObjectByName("visor-sun"), shadows: v.world.renderer.three.shadowMap.enabled }; });
    check("Volver a Vista técnica restaura colores IFC y luz", tech.styles === 0 && !tech.env && !tech.sun && !tech.shadows, JSON.stringify(tech));
    await page.click('[data-tab="info"]');
    await page.evaluate(() => window.__viewer.appearance.clearProfile());
    await page.setViewportSize({ width: 1400, height: 850 });
  }


  // 6c. Realidad virtual (WebXR con gafas emuladas) y paso del modelo al navegador
  {
    const waitFor = (fn, arg, timeout = 90_000) => page.waitForFunction(fn, arg, { timeout, polling: 250 });
    await page.setViewportSize({ width: 900, height: 560 });
    await page.evaluate(() => window.__viewer.fitAll());
    // Preparar una vista con apariencia para comprobar que llega igual a la sesión VR del navegador
    const typeKey = await page.evaluate(async () => {
      const a = window.__viewer.appearance;
      const t = [...a.types.values()].sort((x, y) => y.localIds.length - x.localIds.length)[0];
      await a.setTypeConfig(t.key, { preset: "wood", color: "#ffffff", roughness: 0.6, metalness: 0, opacity: 1, scale: 1, texture: "wood" });
      return t.key;
    });
    const VR_CHECK_POINT = async (p) => p.evaluate(async () => { const v = window.__viewer, r = v.canvas.getBoundingClientRect(); const model = [...v.fragmentsManager.list.values()][0]; const V = v.vr.marker.position.constructor; for (const [fx, fy] of [[0.4, 0.6], [0.3, 0.5], [0.6, 0.6], [0.5, 0.7], [0.45, 0.4]]) { const h = await model.raycast({ camera: v.world.camera.three, mouse: new V(r.left + r.width * fx, r.top + r.height * fy, 0), dom: v.canvas }); if (h) return h.point.toArray(); } return null; });
    /** Prueba de sesión VR en una página con gafas emuladas: andar, girar, teletransporte y salir. */
    const vrSession = async (p, label) => {
      const aim = await VR_CHECK_POINT(p);
      await p.waitForFunction(() => document.body.dataset.vr === "available", null, { timeout: 30_000 });
      await (await p.$("[data-enter-vr]") ? p.click("[data-enter-vr]") : p.click("#btn-vr"));
      await p.waitForFunction(() => document.body.dataset.vr === "active", null, { timeout: 60_000 });
      const e0 = await p.evaluate(() => ({ eye: window.__viewer.vr.eyePosition(), yaw: window.__viewer.vr.rigYaw(), dir: window.__viewer.world.camera.three.getWorldDirection(window.__viewer.vr.marker.position.clone()).toArray() }));
      await p.evaluate(() => window.__xrdev.controllers.left.updateAxes("thumbstick", 0, -1));
      await p.waitForFunction((e) => { const q = window.__viewer.vr.eyePosition(); return Math.hypot(q[0] - e[0], q[2] - e[2]) > 0.5; }, e0.eye, { timeout: 30_000 });
      await p.evaluate(() => window.__xrdev.controllers.left.updateAxes("thumbstick", 0, 0));
      const e1 = await p.evaluate(() => window.__viewer.vr.eyePosition());
      const mv = [e1[0] - e0.eye[0], e1[2] - e0.eye[2]], hd = [e0.dir[0], e0.dir[2]];
      const cos = (mv[0] * hd[0] + mv[1] * hd[1]) / (Math.hypot(...mv) * Math.hypot(...hd));
      check(`${label}: joystick izquierdo avanza hacia donde se mira (en horizontal)`, cos > 0.98 && Math.abs(e1[1] - e0.eye[1]) < 1e-6, `${Math.hypot(...mv).toFixed(2)} m`);
      await p.evaluate(() => window.__xrdev.controllers.right.updateAxes("thumbstick", 1, 0));
      await p.waitForFunction((y) => Math.abs(window.__viewer.vr.rigYaw() - y) > 1, e0.yaw, { timeout: 30_000 });
      await p.evaluate(() => window.__xrdev.controllers.right.updateAxes("thumbstick", 0, 0));
      await p.waitForTimeout(400);
      const yaw = await p.evaluate(() => window.__viewer.vr.rigYaw());
      const turned = Math.abs((((yaw - e0.yaw) % 360) + 540) % 360 - 180);
      check(`${label}: joystick derecho gira 30° por paso`, Math.abs(turned - 30) < 1e-6, `${e0.yaw.toFixed(0)}° → ${yaw.toFixed(0)}°`);
      if (aim) {
        await p.evaluate((aim) => {
          const v = window.__viewer, vr = v.vr, c = window.__xrdev.controllers.right;
          const hand = vr.hands.find((h) => h.handedness === "right").controller;
          const pos = hand.getWorldPosition(hand.position.clone());
          const w = pos.clone().set(...aim).sub(pos).normalize();
          const th = (-vr.rigYaw() * Math.PI) / 180;
          const b = { x: w.x * Math.cos(th) + w.z * Math.sin(th), y: w.y, z: -w.x * Math.sin(th) + w.z * Math.cos(th) };
          let q = [b.y, -b.x, 0, 1 - b.z]; const n = Math.hypot(...q); q = q.map((x) => x / n);
          c.quaternion.set(q[0], q[1], q[2], q[3]);
          c.updateButtonValue("trigger", 1);
        }, aim);
        await p.waitForFunction(() => window.__viewer.vr.target !== null, null, { timeout: 30_000 });
        const aimed = await p.evaluate(() => ({ target: window.__viewer.vr.target.toArray(), hit: window.__viewer.vr.lastHit }));
        await p.evaluate(() => window.__xrdev.controllers.right.updateButtonValue("trigger", 0));
        await p.waitForFunction(() => window.__viewer.vr.lastTeleport !== null, null, { timeout: 30_000 });
        const t = await p.evaluate(() => ({ t: window.__viewer.vr.lastTeleport, eye: window.__viewer.vr.eyePosition() }));
        // El punto alcanzado está sobre el rayo del mando (es geometría real del modelo) y el salto va a ese destino.
        const { point: hp, origin: o, dir: dr } = aimed.hit;
        const v = [hp[0] - o[0], hp[1] - o[1], hp[2] - o[2]], along = v[0] * dr[0] + v[1] * dr[1] + v[2] * dr[2];
        const off = Math.hypot(v[0] - along * dr[0], v[1] - along * dr[1], v[2] - along * dr[2]);
        const same = Math.hypot(t.t[0] - aimed.target[0], t.t[1] - aimed.target[1], t.t[2] - aimed.target[2]);
        const toAim = Math.hypot(hp[0] - aim[0], hp[1] - aim[1], hp[2] - aim[2]);
        check(`${label}: gatillo = teletransporte al punto del modelo apuntado`, off < 0.05 && same < 1e-6 && t.eye[1] > t.t[1] + 1, `impacto a ${off.toFixed(3)} m del rayo, ${along.toFixed(1)} m de distancia (${toAim.toFixed(1)} m del punto buscado); ojos a ${(t.eye[1] - t.t[1]).toFixed(2)} m del suelo`);
      }
      await p.screenshot({ path: join(outDir, `09-vr-${label.includes("navegador") ? "navegador" : "directo"}.png`), timeout: 240_000 });
      await p.evaluate(() => window.__viewer.vr.exit());
      await p.waitForFunction(() => document.body.dataset.vr !== "active", null, { timeout: 30_000 });
      const before = await p.evaluate(() => window.__viewer.cameraPose().pos);
      await p.keyboard.down("KeyW");
      await p.waitForTimeout(400);
      await p.keyboard.up("KeyW");
      await p.waitForTimeout(400);
      const after = await p.evaluate(() => window.__viewer.cameraPose().pos);
      check(`${label}: al salir de VR vuelve la navegación normal desde donde estabas`, Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]) > 0.2);
    };

    let vrUrl = null;
    if (ELECTRON) {
      // Electron no tiene WebXR: el botón VR envía el modelo al servidor local y abre Chrome/Edge.
      check("Electron no tiene WebXR: el botón VR ofrece abrir el navegador", (await page.evaluate(() => document.body.dataset.vr)) === "unsupported");
      await page.click("#btn-vr");
      await page.waitForSelector("[data-copy]", { timeout: 60_000 });
      vrUrl = await page.getAttribute("[data-copy]", "data-copy");
      check("App de escritorio: el modelo se publica en un servidor local para el navegador", /^http:\/\/127\.0\.0\.1:\d+\/index\.html\?vr=[a-f0-9]{32}$/.test(vrUrl), vrUrl);
      await page.click("[data-close]");
    } else {
      await vrSession(page, "VR en el navegador");
      // Mismo camino que la app de escritorio, sin Electron: servidor local de electron/vrServer.cjs
      const { createVrServer, MIME } = createRequire(import.meta.url)("../electron/vrServer.cjs");
      const vrServer = createVrServer({ dist: join(root, "dist"), mime: MIME, log: () => {} });
      const payload = await page.evaluate(async () => {
        const buf = new Uint8Array(await window.__viewer.modelBuffer());
        let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { model: btoa(bin), session: await window.__vrUi.sessionData() };
      });
      vrUrl = await vrServer.publish({ model: Buffer.from(payload.model, "base64"), session: payload.session });
      globalThis.__vrServer = vrServer;
    }
    // Abrir la sesión como lo haría Chrome/Edge (aquí Chromium con gafas emuladas)
    if (vrUrl) {
      // Navegador aparte (proceso GPU propio): con SwiftShader, la página principal en vista realista lo acapara.
      await page.evaluate(() => window.__viewer.setRealistic(false));
      const ctx2 = await (globalThis.__vrBrowser = await chromium.launch({ headless: !HEADED, args: GL_ARGS })).newContext({ viewport: { width: 900, height: 560 } });
      const p2 = await ctx2.newPage();
      p2.on("request", (r) => { const u = new URL(r.url()); if (!/^(blob|data):/.test(u.protocol) && !["localhost", "127.0.0.1"].includes(u.hostname)) external.push(r.url()); });
      const p2errors = [];
      p2.on("pageerror", (e) => (consoleErrors.push(e.message), p2errors.push(e.message)));
      p2.on("console", (m) => m.type() === "error" && p2errors.push(m.text()));
      p2.on("requestfailed", (r) => p2errors.push(`petición fallida ${r.url()} ${r.failure()?.errorText}`));
      await p2.addInitScript({ content: IWER_INIT });
      const tOpen = Date.now();
      // Diagnóstico si la navegación falla: ¿responde el servidor local?
      const probe = await fetch(vrUrl, { signal: AbortSignal.timeout(10_000) }).then((r) => `HTTP ${r.status}`).catch((e) => String(e));
      try {
        await p2.goto(vrUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });
      } catch (e) {
        throw new Error(`No se pudo abrir ${vrUrl} en el navegador (servidor: ${probe}): ${e.message.split("\n")[0]}`);
      }
      try {
        await p2.waitForSelector("[data-enter-vr]", { timeout: 240_000 });
      } catch (e) {
        const st = await p2.evaluate(() => `estado=${document.body.dataset.modelState} paso=${document.body.dataset.vrStep} vr=${document.body.dataset.vr} aviso=${document.querySelector("#toast")?.textContent?.slice(0, 200)}`).catch(() => "?");
        throw new Error(`La vista VR no terminó de cargar en el navegador (${st}; errores: ${p2errors.slice(0, 4).join(" | ").slice(0, 600)})`);
      }
      const got = await p2.evaluate((k) => ({ type: window.__viewer.appearance.profile.byType[k]?.preset, realistic: window.__viewer.appearance.realistic, n: window.__viewer.appearance.groups.reduce((n, g) => n + g.localIds.length, 0) }), typeKey);
      check("Vista VR en el navegador: recibe el modelo (sin volver a procesar el IFC) con sus materiales", got.type === "wood" && got.n > 0, `${JSON.stringify(got)} · ${((Date.now() - tOpen) / 1000).toFixed(1)} s`);
      await vrSession(p2, "VR desde la app (navegador)");
      await ctx2.close();
    }
    globalThis.__vrServer?.close();
    await globalThis.__vrBrowser?.close();
    await page.evaluate(() => window.__viewer.appearance.clearProfile());
    await page.setViewportSize({ width: 1400, height: 850 });
  }


  // 6d. Análisis: interferencias, IDS, comparar versiones, 4D y planta 2D
  {
    const wait = (fn, arg, timeout = 180_000) => page.waitForFunction(fn, arg, { timeout, polling: 300 });
    const xlsxOk = (buf) => buf[0] === 0x50 && buf[1] === 0x4b && buf.includes(Buffer.from("xl/worksheets/sheet1.xml"));
    // En Electron la descarga abre el diálogo «Guardar como» del sistema (no automatizable): se comprueba
    // que el informe existe y se omite el archivo.
    const saveDownload = async (selector, name) => {
      if (ELECTRON) return null;
      const [d] = await Promise.all([page.waitForEvent("download", { timeout: 60_000 }), page.click(selector)]);
      const path = join(outDir, name);
      await d.saveAs(path);
      return { path, buf: readFileSync(path), suggested: d.suggestedFilename() };
    };
    await page.setViewportSize({ width: 1400, height: 850 });
    await page.click("#btn-analysis");
    await wait(() => window.__dock?.tabs[0].active);
    await page.waitForSelector('.clash-tab [data-act="run"]', { timeout: 120_000 });

    // Interferencias
    const tc = Date.now();
    await page.click('.clash-tab [data-act="run"]');
    await page.waitForSelector('[data-testid="clash-count"]', { timeout: 300_000 });
    const nClash = Number(await page.textContent('[data-testid="clash-count"]'));
    const sample = await page.evaluate(async () => {
      const t = window.__dock.tabs[0], idx = await t.ctx.index();
      const n = t.clashes.length, pick = [];
      for (let i = 0; i < Math.min(25, n); i++) pick.push(t.clashes[Math.floor((i * n) / Math.min(25, n))]);
      return pick.map((c) => ({ a: idx.elements.get(c.a).guid, b: idx.elements.get(c.b).guid, kind: c.kind, depth: c.depth }));
    });
    const confirmed = [];
    for (const c of sample) confirmed.push(c.kind === "Contenido" || (await webIfcIntersect(c.a, c.b)));
    const unconfirmed = sample.filter((_, i) => !confirmed[i]).map((c) => `${c.a}×${c.b} ${c.kind} ${(c.depth * 1000).toFixed(0)} mm`);
    check("Interferencias: choques encontrados y confirmados con la geometría de web-ifc", nClash > 0 && confirmed.every(Boolean), `${nClash} en ${((Date.now() - tc) / 1000).toFixed(1)} s · muestra ${confirmed.filter(Boolean).length}/${confirmed.length} confirmadas en Node${unconfirmed.length ? ` · sin confirmar: ${unconfirmed.join(", ")}` : ""}`);
    await page.click('[data-testid="clash-table"] tbody tr');
    await wait(() => { const v = window.__viewer; let a = false, g = false; v.world.scene.three.traverse((o) => { if (o.name === "visor-ghost") g = true; if (!o.isMesh || !Array.isArray(o.material)) return; for (const gr of o.geometry.groups) { const m = o.material[gr.materialIndex]; if (m && gr.count > 0 && m.userData?.customId === "an:clash-a") a = true; } }); return a && g; });
    const vis = await page.evaluate(() => window.__viewer.visibilityCounts());
    check("Interferencias: al elegir una se ven A (rojo) y B (azul) con el resto en transparencia", vis.visible === 2, JSON.stringify(vis));
    await page.screenshot({ path: join(outDir, "10-interferencia.png"), timeout: 240_000 });
    const xl1 = await saveDownload('[data-act="xlsx"]', "interferencias.xlsx");
    if (xl1) check("Interferencias: informe Excel (.xlsx)", xlsxOk(xl1.buf), `${xl1.suggested} · ${xl1.buf.length} bytes`);

    // Validación IDS
    await page.click('[data-dock-tab="ids"]');
    await wait(() => window.__dock.tabs[1].active);
    const idsPath = join(root, "test-models", "requisitos-estructura.ids");
    await page.setInputFiles('.ids-tab [data-role="file"]', idsPath);
    await page.waitForSelector(".ids-tab .spec-count", { timeout: 120_000 });
    const idsRes = await page.evaluate(() => window.__dock.tabs[1].results.map((r) => ({ name: r.name, pass: r.pass, fail: r.fail })));
    const truthIds = [
      await webIfcPropCount(WebIFC.IFCBEAM, "Identidad", "Marca"),
      await webIfcPropCount(WebIFC.IFCSLAB, "Dimensiones", "Espesor"),
      await webIfcPropCount(WebIFC.IFCCOLUMN, "Materiales y acabados", "Material"),
    ];
    check("Validación IDS: cumplen / no cumplen igual que el IFC (web-ifc)", idsRes.length === 3 && idsRes.every((r, i) => r.pass === truthIds[i].pass && r.fail === truthIds[i].fail), idsRes.map((r, i) => `${r.name}: ${r.pass}/${r.fail} (IFC ${truthIds[i].pass}/${truthIds[i].fail})`).join(" · "));
    const xl2 = await saveDownload('[data-act="xlsx"]', "ids.xlsx");
    if (xl2) check("Validación IDS: informe Excel con resumen y detalle", xlsxOk(xl2.buf) && xl2.buf.includes(Buffer.from("xl/worksheets/sheet2.xml")), `${xl2.buf.length} bytes`);

    // Comparar versiones (segunda versión generada con web-ifc a partir del IFC real)
    const v2 = join(outDir, "version-2.ifc");
    const truthCmp = await makeVariant(ifcPath, v2);
    await page.click('[data-dock-tab="compare"]');
    await wait(() => window.__dock.tabs[2].active);
    const tcmp = Date.now();
    await page.setInputFiles('.compare-tab [data-role="file"]', v2);
    await page.waitForSelector('[data-testid="cmp-table"]', { timeout: 300_000 });
    const cmp = await page.evaluate(() => { const r = window.__dock.tabs[2].result; return { added: r.added.map((x) => x.guid), removed: r.removed.map((x) => x.guid), modified: r.modified.map((m) => ({ guid: m.after.guid, geometry: m.geometry, changes: m.changes.map((c) => `${c.what}: ${c.before} → ${c.after}`) })), unchanged: r.unchanged }; });
    const modGuids = cmp.modified.map((m) => m.guid).sort();
    const expectMod = [...new Set([...truthCmp.changedGuids, truthCmp.movedGuid])].sort();
    const moved = cmp.modified.find((m) => m.guid === truthCmp.movedGuid);
    const marked = cmp.modified.find((m) => m.guid === truthCmp.beamGuid);
    check(
      "Comparar: nuevos, eliminados y modificados exactamente los cambiados",
      cmp.added.length === 1 && cmp.added[0] === truthCmp.newWallGuid && cmp.removed.length === 1 && cmp.removed[0] === truthCmp.oldWallGuid && JSON.stringify(modGuids) === JSON.stringify(expectMod),
      `+${cmp.added.length} −${cmp.removed.length} ~${cmp.modified.length} · ${cmp.unchanged} sin cambios · ${((Date.now() - tcmp) / 1000).toFixed(1)} s`,
    );
    check("Comparar: detalla el cambio de propiedad y el desplazamiento de 500 mm", !!marked?.changes.some((c) => c.includes(truthCmp.oldMark) && c.includes(truthCmp.newMark)) && !!moved?.geometry && moved.changes.some((c) => c.includes("+0.500 m")), `${marked?.changes[0]} | ${moved?.changes[0]}`);
    await page.click('[data-filter="added"]');
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(outDir, "11-comparar.png"), timeout: 240_000 });
    const xl3 = await saveDownload('[data-act="xlsx"]', "comparacion.xlsx");
    if (xl3) check("Comparar: informe Excel", xlsxOk(xl3.buf), `${xl3.buf.length} bytes`);
    await page.click('[data-act="close-cmp"]');
    await wait(() => window.__viewer.fragmentsManager.list.size === 1, null, 60_000);
    check("Comparar: «Quitar comparación» libera la otra versión", true);

    // 4D
    await page.click('[data-dock-tab="fourd"]');
    await wait(() => window.__dock.tabs[3].active);
    await page.click('.fourd-tab [data-act="gen"]');
    await page.waitForSelector('[data-testid="fourd-table"]', { timeout: 60_000 });
    const s4 = await page.evaluate(async () => {
      const t = window.__dock.tabs[3];
      const [a, b] = t.range;
      const DAY = 86400000;
      const mid = a + Math.floor((b - a) / DAY / 2) * DAY;
      await t.setDate(mid);
      const expectHidden = t.acts.filter((x) => mid < x.start).reduce((n, x) => n + x.ids.length, 0);
      const expectRunning = t.acts.filter((x) => mid >= x.start && mid <= x.end).reduce((n, x) => n + x.ids.length, 0);
      const vis = await window.__viewer.visibilityCounts();
      const state = { ...t.state };
      const linked = new Set(t.acts.flatMap((x) => x.ids)).size;
      await t.setDate(b);
      const end = await window.__viewer.visibilityCounts();
      return { acts: t.acts.length, expectHidden, expectRunning, state, vis, linked, total: (await t.ctx.index()).elements.size, end, csv: t.csv() };
    });
    check("4D: programación por niveles; en una fecha se ocultan las actividades no empezadas", s4.acts > 1 && s4.linked === s4.total && s4.vis.hidden === s4.expectHidden && s4.state.running === s4.expectRunning && s4.end.hidden === 0, `${s4.acts} actividades · a mitad de obra ${s4.vis.hidden} ocultos (esperado ${s4.expectHidden}), ${s4.state.running} en ejecución (esperado ${s4.expectRunning}) · enlazados ${s4.linked}/${s4.total} · al final ${s4.end.hidden} ocultos`);
    await page.screenshot({ path: join(outDir, "12-4d.png"), timeout: 240_000 });
    const imp = await page.evaluate((csv) => window.__dock.tabs[3].importCsv(csv, "prueba.csv"), s4.csv);
    check("4D: el CSV exportado se vuelve a importar igual (editable en Excel)", imp.activities === s4.acts && imp.linked === s4.total, JSON.stringify(imp));
    await page.click('[data-act="close"]');
    await wait(() => document.body.dataset.dock === "closed");
    const visClosed = await page.evaluate(() => window.__viewer.visibilityCounts());
    check("Al cerrar el panel Análisis el modelo vuelve a verse completo", visClosed.hidden === 0, JSON.stringify(visClosed));

    // Planta 2D
    await page.click("#btn-plan");
    await wait(() => /cortados/.test(document.querySelector(".plan-status")?.textContent ?? ""), null, 120_000);
    const planInfo = await page.evaluate(() => { const p = window.__plan; const c = { cut: 0, above: 0, below: 0 }; for (const e of p.plan.elements) c[e.layer]++; return { storey: p.storey.name, ...c, cols: p.plan.elements.filter((e) => e.layer === "cut" && e.ifcClass === "IfcColumn").length, b: p.plan.bounds }; });
    check("Planta 2D: corte del nivel con la geometría real", planInfo.cut > 0 && planInfo.cols > 0, `${planInfo.storey}: ${planInfo.cut} cortados (${planInfo.cols} pilares), ${planInfo.above} por encima, ${planInfo.below} por debajo`);
    await page.evaluate((b) => { window.__plan.addDimPoint(b.minX, b.maxY); window.__plan.addDimPoint(b.maxX, b.maxY); }, planInfo.b);
    const dims = await page.evaluate(() => window.__plan.dimensions);
    check("Planta 2D: cota entre dos puntos", Math.abs(dims[0] - (planInfo.b.maxX - planInfo.b.minX)) < 1e-6, `${dims[0].toFixed(2)} m`);
    await page.screenshot({ path: join(outDir, "13-planta.png"), timeout: 240_000 });
    const pdf = await saveDownload('.plan-view [data-act="pdf"]', "planta.pdf");
    const pdfText = pdf?.buf.toString("latin1");
    if (pdf) check("Planta 2D: PDF A3 vectorial", pdfText.startsWith("%PDF-1.4") && pdfText.trimEnd().endsWith("%%EOF") && /MediaBox \[0 0 1190\.55\d* 841\.89\d*\]/.test(pdfText) && pdf.buf.length > 5000, `${pdf.suggested} · ${(pdf.buf.length / 1024).toFixed(0)} KB`);
    const dxf = await saveDownload('.plan-view [data-act="dxf"]', "planta.dxf");
    const dxfText = dxf?.buf.toString("latin1") ?? "";
    const nLines = (dxfText.match(/\r\nLINE\r\n/g) ?? []).length;
    if (dxf) check("Planta 2D: DXF con capas por clase IFC", dxfText.includes("AC1009") && dxfText.includes("CORTE-IfcColumn") && nLines > 100 && dxfText.trimEnd().endsWith("EOF"), `${nLines} líneas · ${(dxf.buf.length / 1024).toFixed(0)} KB`);
    await page.keyboard.press("Escape");
    await wait(() => document.body.dataset.plan === "closed", null, 10_000);
    check("Planta 2D: Esc cierra la vista", true);
  }

  // 7. Cerrar modelo y liberar memoria
  const memBefore = await page.evaluate(() => window.__viewer.debugInfo());
  await page.click("#btn-close");
  await page.waitForFunction(() => document.body.dataset.modelState === "closed");
  await page.waitForTimeout(500);
  const memAfter = await page.evaluate(() => window.__viewer.debugInfo());
  check(
    "Cerrar modelo libera escena y GPU",
    memAfter.models.length === 0 && memAfter.renderer.geometries < memBefore.renderer.geometries && memAfter.sceneChildren < memBefore.sceneChildren,
    `modelos ${memBefore.models.length}→${memAfter.models.length}, geometrías ${memBefore.renderer.geometries}→${memAfter.renderer.geometries}, hijos de escena ${memBefore.sceneChildren}→${memAfter.sceneChildren}`,
  );
  check("Mensaje de bienvenida visible otra vez", await page.isVisible("#empty"));

  // Recarga tras cerrar (sin fugas: el número de geometrías vuelve al mismo valor)
  await openViaButton(ifcPath);
  await waitState("loaded");
  await page.waitForTimeout(500);
  const memReload = await page.evaluate(() => window.__viewer.debugInfo());
  check("Volver a abrir tras cerrar", memReload.models.length === 1, `geometrías ${memReload.renderer.geometries} (1ª carga: ${memBefore.renderer.geometries})`);
  // Abrir otro sin cerrar: sustituye al anterior (fase 1: un modelo)
  await openViaButton(ifcPath);
  await waitState("loaded");
  const memReplace = await page.evaluate(() => window.__viewer.debugInfo());
  check("Abrir sin cerrar sustituye el modelo (no se acumulan)", memReplace.models.length === 1, JSON.stringify(memReplace.models));

  // 8. Errores comprensibles
  const bad = join(outDir, "no-es-ifc.ifc");
  writeFileSync(bad, "Esto no es un IFC\n");
  await page.evaluate(() => (document.body.dataset.modelState = ""));
  await openViaButton(bad);
  await page.waitForFunction(() => document.body.dataset.modelState === "error");
  const toast = await page.textContent("#toast");
  check("Error comprensible con archivo no IFC", toast.includes("cabecera IFC"), toast.slice(0, 90));
  const stillLoaded = await page.evaluate(() => window.__viewer.debugInfo().models.length);
  check("Un archivo erróneo no rompe el modelo abierto", stillLoaded === 1);
  const rvt = join(outDir, "modelo.rvt");
  writeFileSync(rvt, "x");
  await openViaButton(rvt);
  await page.waitForTimeout(500);
  check("Aviso específico para .rvt", (await page.textContent("#toast")).includes("Exporta el modelo a IFC"));

  // 9. Privacidad
  check("Ninguna petición fuera de localhost", external.length === 0, external.slice(0, 3).join(", "));
  const realErrors = consoleErrors.filter((e) => !e.includes("UserError") && !e.includes("Failed to load resource"));
  check("Sin errores inesperados en consola", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));
} catch (err) {
  check("Ejecución de la prueba", false, String(err?.message ?? err) + " @ " + String(err?.stack ?? "").split("\n").find((l) => l.includes("e2e.mjs"))?.trim());
  await page.screenshot({ path: join(outDir, "error.png") }).catch(() => {});
} finally {
  await browser?.close();
  await electronApp?.close();
  if (server) await (server.close?.() ?? server.httpServer?.close());
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(outDir, "resultado.json"), JSON.stringify({ ifc: ifcPath, mode: ELECTRON ? "electron" : DEV ? "dev" : "build", results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas. Capturas en test-results/`);
  if (process.env.GITHUB_ACTIONS) {
    // Los registros de Actions no siempre son legibles: los fallos se publican como anotaciones.
    for (const r of failed) console.log(`::error title=e2e::${r.name}${r.detail ? ` — ${r.detail}` : ""}`.replace(/\n/g, " "));
    console.log(`::notice title=e2e::${results.length - failed.length}/${results.length} comprobaciones superadas`);
  }
  process.exit(failed.length ? 1 : 0);
}
