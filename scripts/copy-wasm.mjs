// Copia los binarios WASM de web-ifc desde node_modules a public/wasm/.
// Se ejecuta automáticamente antes de `npm run dev` y `npm run build`
// (scripts "predev" y "prebuild"), así la versión del WASM siempre coincide
// con la versión de web-ifc instalada y nunca se descarga de Internet.
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "web-ifc");
const dest = join(root, "public", "wasm");

mkdirSync(dest, { recursive: true });
for (const file of ["web-ifc.wasm", "web-ifc-mt.wasm"]) {
  const from = join(src, file);
  if (!existsSync(from)) {
    console.error(`[copy-wasm] No se encontró ${from}. ¿Ejecutaste "npm install"?`);
    process.exit(1);
  }
  copyFileSync(from, join(dest, file));
}
console.log("[copy-wasm] WASM de web-ifc copiado a public/wasm/");
