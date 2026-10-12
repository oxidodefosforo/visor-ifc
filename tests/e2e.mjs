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
  const cls = api.GetNameFromTypeCode(api.GetLineType(model, id));
  api.CloseModel(model);
  return { expressId: id, ifcClass: cls, name: val(line.Name), psets };
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
    const out = { identity: {}, psets: {} };
    document.querySelectorAll('[data-testid="identity"] tr').forEach((tr) => {
      out.identity[tr.querySelector("th").textContent] = tr.querySelector("td").textContent;
    });
    document.querySelectorAll('[data-testid="psets"] details').forEach((d) => {
      const name = d.querySelector("summary").childNodes[0].textContent.trim();
      const props = {};
      d.querySelectorAll("tr").forEach((tr) => (props[tr.querySelector("th").textContent] = tr.querySelector("td").textContent));
      out.psets[name] = props;
    });
    return out;
  });

const fmt = (v) => {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  if (v === true || v === ".T.") return "Sí";
  if (v === false || v === ".F.") return "No";
  return v == null ? "—" : String(v);
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
  page = await browser.newPage({ viewport: { width: 1400, height: 850 } });
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

  // Navegación: orbitar con el ratón y zoom con la rueda (cambio de cámara)
  const camPos = () => page.evaluate(() => window.__viewer.world.camera.three.position.toArray().map((n) => +n.toFixed(3)));
  const before = await camPos();
  const box = await page.locator("#viewport canvas").boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.45, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const afterOrbit = await camPos();
  check("Órbita con el ratón mueve la cámara", JSON.stringify(before) !== JSON.stringify(afterOrbit));
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(600);
  const afterZoom = await camPos();
  check("Zoom con la rueda mueve la cámara", JSON.stringify(afterOrbit) !== JSON.stringify(afterZoom));
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
      if (panel.psets[ps]?.[k] !== fmt(v)) mismatches.push(`${ps}.${k}: IFC=${fmt(v)} panel=${panel.psets[ps]?.[k]}`);
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
    await page.waitForFunction((g) => document.querySelector('[data-testid="identity"] td')?.textContent === g, g, { timeout: 10_000 });
    const pnl = await propsPanel(page);
    const t = await groundTruth(g);
    const bad = [];
    if (pnl.identity["Clase IFC"] !== t.ifcClass) bad.push("clase");
    if (pnl.identity["Nombre"] !== (t.name ?? "—")) bad.push("nombre");
    for (const [ps, props] of Object.entries(t.psets))
      for (const [k, v] of Object.entries(props)) if (pnl.psets[ps]?.[k] !== fmt(v)) bad.push(`${ps}.${k}`);
    perClass.push(`${t.ifcClass}${bad.length ? ` ✗(${bad.join(",")})` : " ✓"}`);
  }
  check("Datos correctos en un elemento de cada clase", perClass.every((s) => s.endsWith("✓")), perClass.join(" · "));
  await page.evaluate((g) => window.__viewer.selectByGuid(g), guid);
  await page.waitForFunction((g) => document.querySelector('[data-testid="identity"] td')?.textContent === g, guid);

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
  check("Esc deselecciona", (await page.textContent("#props")).includes("Selecciona un elemento"));

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
  check("Ejecución de la prueba", false, String(err?.message ?? err));
  await page.screenshot({ path: join(outDir, "error.png") }).catch(() => {});
} finally {
  await browser?.close();
  await electronApp?.close();
  if (server) await (server.close?.() ?? server.httpServer?.close());
  const failed = results.filter((r) => !r.ok);
  writeFileSync(join(outDir, "resultado.json"), JSON.stringify({ ifc: ifcPath, mode: ELECTRON ? "electron" : DEV ? "dev" : "build", results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones superadas. Capturas en test-results/`);
  process.exit(failed.length ? 1 : 0);
}
