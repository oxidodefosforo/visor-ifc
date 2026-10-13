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

// ---------- Servidor / aplicación ----------
let server, url, browser, page, electronApp;
const GL_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
if (ELECTRON) {
  if (!existsSync(join(root, "dist", "index.html"))) await build({ root, logLevel: "warn" });
  electronApp = await _electron.launch({
    args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), ...GL_ARGS, root],
    cwd: root,
    env: { ...process.env },
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
      await page.waitForSelector(".ctx-menu:not([hidden])", { timeout: 30_000 });
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
