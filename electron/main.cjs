// Proceso principal de la aplicación de escritorio (Electron).
// Sirve la app web compilada (dist/) desde un protocolo propio app://visor/
// para que el WASM de web-ifc y el worker de Fragments funcionen igual que en
// el navegador, sin servidor y sin conexión a Internet.
// Las actualizaciones se gestionan con electron-updater (ver README, «Publicar una versión»).
const { app, BrowserWindow, protocol, dialog, Menu, shell, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { autoUpdater } = require("electron-updater");
const { createVrServer, openInXrBrowser, MIME } = require("./vrServer.cjs");

const SCHEME = "app";
const HOST = "visor";
const DIST = path.join(__dirname, "..", "dist");

// ---------- Registro sencillo en %APPDATA%\Visor IFC\logs\main.log ----------
let logFile = null;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  try {
    if (!logFile) {
      const dir = path.join(app.getPath("userData"), "logs");
      fs.mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, "main.log");
    }
    fs.appendFileSync(logFile, line);
  } catch {}
  if (!app.isPackaged) process.stdout.write(line);
}

// El esquema debe registrarse antes de que la app esté lista.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Una sola ventana/instancia de la aplicación.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start);
}

function serveDist() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response("Not found", { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST + path.sep)) return new Response("Forbidden", { status: 403 }); // evita ../
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, {
        status: 200,
        headers: {
          "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "no-cache",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    title: `Visor IFC ${app.getVersion()}`,
    backgroundColor: "#14171b",
    show: false,
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win.show());
  // La app no navega a ningún sitio externo; los enlaces se abren en el navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`${SCHEME}://${HOST}/`)) e.preventDefault();
  });
  win.webContents.on("render-process-gone", (_e, details) => log("render-process-gone", details));
  win.loadURL(`${SCHEME}://${HOST}/index.html`);
  return win;
}

// ---------- Actualizaciones ----------
let manualCheck = false;

/** El instalador solo incluye app-update.yml si se compiló con release.json configurado. */
function updatesConfigured() {
  if (process.env.VISOR_IFC_UPDATE_URL) return true;
  return app.isPackaged && fs.existsSync(path.join(process.resourcesPath, "app-update.yml"));
}

function setupUpdates(win) {
  autoUpdater.logger = { info: (m) => log("[updater]", m), warn: (m) => log("[updater] WARN", m), error: (m) => log("[updater] ERROR", m), debug: () => {} };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // si no se reinicia ahora, se instala al cerrar
  // Solo para pruebas: servidor de actualizaciones alternativo.
  if (process.env.VISOR_IFC_UPDATE_URL) {
    autoUpdater.setFeedURL({ provider: "generic", url: process.env.VISOR_IFC_UPDATE_URL });
    autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  }

  const send = (status, extra = {}) => !win.isDestroyed() && win.webContents.send("update-status", { status, ...extra });

  autoUpdater.on("checking-for-update", () => send("checking"));
  autoUpdater.on("update-not-available", () => {
    send("none");
    if (manualCheck) dialog.showMessageBox(win, { type: "info", title: "Visor IFC", message: `Tienes la última versión (${app.getVersion()}).` });
    manualCheck = false;
  });
  autoUpdater.on("update-available", (info) => send("downloading", { version: info.version, percent: 0 }));
  autoUpdater.on("download-progress", (p) => send("downloading", { percent: Math.round(p.percent) }));
  autoUpdater.on("update-downloaded", async (info) => {
    send("ready", { version: info.version });
    manualCheck = false;
    const { response } = await dialog.showMessageBox(win, {
      type: "info",
      title: "Actualización lista",
      message: `La versión ${info.version} de Visor IFC está lista.`,
      detail: "Reinicia ahora para instalarla, o se instalará automáticamente cuando cierres la aplicación.",
      buttons: ["Reiniciar ahora", "Más tarde"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });
  autoUpdater.on("error", (err) => {
    log("[updater] error", err);
    send("error", { message: String(err?.message ?? err) });
    if (manualCheck) {
      dialog.showMessageBox(win, {
        type: "warning",
        title: "Visor IFC",
        message: "No se pudo comprobar si hay actualizaciones.",
        detail: "Comprueba tu conexión a Internet. El visor sigue funcionando con normalidad.",
      });
    }
    manualCheck = false;
  });

  if (updatesConfigured()) {
    setTimeout(() => autoUpdater.checkForUpdates().catch((e) => log("[updater] check failed", e)), 3000);
  }
}

function checkForUpdatesManually() {
  if (!updatesConfigured()) {
    dialog.showMessageBox({
      type: "info",
      title: "Visor IFC",
      message: "Esta versión no tiene configuradas las actualizaciones automáticas.",
      detail: app.isPackaged
        ? "Instala una versión publicada en GitHub para recibir actualizaciones."
        : "Las actualizaciones solo funcionan en la versión instalada.",
    });
    return;
  }
  manualCheck = true;
  autoUpdater.checkForUpdates().catch((e) => log("[updater] manual check failed", e));
}

function buildMenu(win) {
  const template = [
    {
      label: "Archivo",
      submenu: [
        { label: "Abrir IFC…", accelerator: "CmdOrCtrl+O", click: () => win.webContents.send("menu", "open") },
        { label: "Cerrar modelo", accelerator: "CmdOrCtrl+W", click: () => win.webContents.send("menu", "close") },
        { type: "separator" },
        { role: "quit", label: "Salir" },
      ],
    },
    {
      label: "Ver",
      submenu: [
        { role: "reload", label: "Recargar" },
        { role: "togglefullscreen", label: "Pantalla completa" },
        { role: "resetZoom", label: "Tamaño normal de la interfaz" },
        { role: "zoomIn", label: "Ampliar interfaz" },
        { role: "zoomOut", label: "Reducir interfaz" },
        { type: "separator" },
        { role: "toggleDevTools", label: "Herramientas de desarrollo" },
      ],
    },
    {
      label: "Ayuda",
      submenu: [
        { label: "Buscar actualizaciones…", click: checkForUpdatesManually },
        { label: "Abrir carpeta de registros", click: () => shell.openPath(path.join(app.getPath("userData"), "logs")) },
        { type: "separator" },
        {
          label: "Acerca de Visor IFC",
          click: () =>
            dialog.showMessageBox(win, {
              type: "info",
              title: "Acerca de Visor IFC",
              message: `Visor IFC ${app.getVersion()}`,
              detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\nLos modelos se procesan solo en este ordenador.`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function start() {
  log(`Inicio Visor IFC ${app.getVersion()} (packaged=${app.isPackaged}, updates=${updatesConfigured()})`);
  serveDist();
  ipcMain.handle("app-info", () => ({ version: app.getVersion(), packaged: app.isPackaged }));
  // Vista VR: Electron no tiene WebXR → se abre la misma interfaz en Chrome/Edge (servidor solo local).
  const vr = createVrServer({ dist: DIST, mime: MIME, log });
  ipcMain.handle("vr-open", async (_e, payload) => {
    const url = await vr.publish(payload);
    const browser = openInXrBrowser(url, shell, log);
    return { url, browser };
  });
  ipcMain.handle("open-url", (_e, url) => {
    if (/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(url)) return openInXrBrowser(url, shell, log);
  });
  app.on("before-quit", () => vr.close());
  const win = createWindow();
  buildMenu(win);
  setupUpdates(win);
  app.on("window-all-closed", () => app.quit());
}

process.on("uncaughtException", (e) => log("uncaughtException", e));
