import { defineConfig } from "vite";

export default defineConfig({
  // web-ifc carga su propio .wasm desde /wasm/ (ver scripts/copy-wasm.mjs);
  // se excluye del pre-empaquetado para que Vite no lo reescriba.
  optimizeDeps: {
    exclude: ["web-ifc"],
  },
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 6000,
  },
  server: {
    port: 5173,
    strictPort: false,
    open: true,
  },
});
