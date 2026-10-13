// Servidor local para la vista en gafas VR.
//
// Electron no incluye WebXR (comprobado en Electron 44: `navigator.xr` no existe), así que para ver
// el modelo en unas Meta Quest con Link se abre la MISMA interfaz en Chrome o Edge, que sí hablan
// con las gafas a través de OpenXR. Este servidor:
//   - escucha solo en 127.0.0.1 (no es accesible desde otros equipos);
//   - sirve los archivos de la app (dist/) y la sesión VR actual (modelo en Fragments + apariencia + cámara)
//     bajo una ruta con un token aleatorio;
//   - «localhost» es un contexto seguro, requisito de WebXR.
// No se envía nada a internet.
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PREFERRED_PORT = 47821;

/** Tipos MIME de los archivos de dist/ (también los usa el protocolo app:// de main.cjs). */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};


function createVrServer({ dist, mime, log }) {
  let server = null;
  let port = 0;
  /** Solo se guarda la última sesión (libera la memoria de la anterior). */
  let current = null; // { token, json: Buffer, model: Buffer }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
      const m = /^\/vr\/([a-f0-9]{32})\/(session\.json|model\.frag)$/.exec(url.pathname);
      if (m) {
        if (!current || current.token !== m[1]) return send(res, 404, "Sesión VR caducada. Vuelve a pulsar «VR» en el Visor IFC.");
        const body = m[2] === "session.json" ? current.json : current.model;
        res.writeHead(200, { "content-type": m[2] === "session.json" ? "application/json" : "application/octet-stream", "cache-control": "no-store", "content-length": body.length });
        return res.end(req.method === "HEAD" ? undefined : body);
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/" || rel === "") rel = "/index.html";
      const file = path.normalize(path.join(dist, rel));
      if (!file.startsWith(dist + path.sep)) return send(res, 403, "Forbidden");
      const data = await fs.promises.readFile(file);
      res.writeHead(200, { "content-type": mime[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      send(res, 404, "Not found");
    }
  }

  function send(res, code, text) {
    res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
    res.end(text);
  }

  function listen(p) {
    return new Promise((resolve, reject) => {
      const s = http.createServer(handle);
      s.once("error", reject);
      s.listen(p, "127.0.0.1", () => resolve(s));
    });
  }

  async function ensure() {
    if (server) return port;
    try {
      server = await listen(PREFERRED_PORT); // puerto fijo: el navegador recuerda permisos y ajustes
    } catch {
      server = await listen(0); // ocupado: uno libre cualquiera
    }
    port = server.address().port;
    log(`Servidor VR en http://localhost:${port}`);
    return port;
  }

  /** Publica una sesión y devuelve su URL. */
  async function publish({ model, session }) {
    const p = await ensure();
    const token = crypto.randomBytes(16).toString("hex");
    current = { token, json: Buffer.from(JSON.stringify(session)), model: Buffer.from(model) };
    return `http://localhost:${p}/index.html?vr=${token}`;
  }

  function close() {
    server?.close();
    server = null;
    current = null;
  }

  return { publish, close };
}

/**
 * Abre la URL en un navegador con WebXR: Chrome, si no Edge (incluido en Windows), si no el
 * navegador predeterminado. Devuelve el nombre del navegador usado.
 */
function openInXrBrowser(url, shell, log) {
  if (process.env.VISOR_VR_NO_BROWSER) return "prueba (sin abrir navegador)"; // pruebas automáticas
  if (process.platform === "win32") {
    const env = process.env;
    const candidates = [
      ["Google Chrome", path.join(env["PROGRAMFILES"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe")],
      ["Google Chrome", path.join(env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe")],
      ["Google Chrome", path.join(env["LOCALAPPDATA"] ?? "", "Google\\Chrome\\Application\\chrome.exe")],
      ["Microsoft Edge", path.join(env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft\\Edge\\Application\\msedge.exe")],
      ["Microsoft Edge", path.join(env["PROGRAMFILES"] ?? "C:\\Program Files", "Microsoft\\Edge\\Application\\msedge.exe")],
    ];
    for (const [name, exe] of candidates) {
      if (exe && fs.existsSync(exe)) {
        try {
          spawn(exe, ["--new-window", url], { detached: true, stdio: "ignore" }).unref();
          log(`VR: abierto en ${name}`);
          return name;
        } catch (e) {
          log(`VR: no se pudo abrir ${exe}`, e);
        }
      }
    }
  }
  void shell.openExternal(url);
  return "navegador predeterminado";
}

module.exports = { createVrServer, openInXrBrowser, MIME };
