// Configuración del instalador de Windows (electron-builder + NSIS).
// El destino de las actualizaciones se lee de release.json:
//   { "githubOwner": "tu-usuario", "githubRepo": "visor-ifc" }
// Si githubOwner está vacío, el instalador funciona pero sin actualizaciones automáticas.
const release = require("./release.json");
const owner = process.env.VISOR_GH_OWNER || release.githubOwner;
const repo = process.env.VISOR_GH_REPO || release.githubRepo || "visor-ifc";

if (!owner) {
  console.warn(
    "\n[aviso] release.json no tiene githubOwner: el instalador NO incluirá actualizaciones automáticas.\n",
  );
}

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.visorifc.app",
  productName: "Visor IFC",
  copyright: "© 2026 Juan",
  directories: { output: "release", buildResources: "build" },
  // Vite ya empaqueta toda la app web en dist/; solo hacen falta estos archivos.
  files: ["dist/**/*", "electron/**/*", "package.json"],
  asar: true,
  electronLanguages: ["es", "es-419", "en-US"],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "build/icon.png",
    artifactName: "Visor-IFC-Setup-${version}.${ext}",
  },
  nsis: {
    oneClick: false, // asistente clásico: Siguiente, elegir carpeta, Instalar
    perMachine: false, // instalación por usuario: no pide administrador y permite actualizar sin permisos
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Visor IFC",
    uninstallDisplayName: "Visor IFC",
    installerLanguages: ["es_ES"],
    language: "3082",
    deleteAppDataOnUninstall: false,
  },
  publish: owner ? [{ provider: "github", owner, repo, releaseType: "release" }] : null,
};
