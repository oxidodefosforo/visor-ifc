import type { Viewer } from "../../viewer/Viewer";
import type { ModelIndex } from "../../analysis/modelIndex";
import type { Sheet } from "../../analysis/xlsx";

/** Contexto compartido por las pestañas del panel «Análisis». */
export type AnalysisContext = {
  viewer: Viewer;
  notify: (msg: string, kind?: "info" | "error") => void;
  /** Índice del modelo abierto (clase, nombre, GlobalId, nivel, caja). Se calcula una vez. */
  index: () => Promise<ModelIndex>;
  modelName: () => string;
};

export interface AnalysisTab {
  readonly id: string;
  readonly title: string;
  readonly el: HTMLElement;
  /** La pestaña pasa a primer plano: aplica sus colores/visibilidad. */
  activate(): Promise<void>;
  /** Deja el modelo como estaba (colores, visibilidad). */
  deactivate(): Promise<void>;
  /** Se cerró o cambió el modelo: olvidar resultados. */
  reset(): void;
  /** Hojas para el informe Excel (null si no hay nada que exportar). */
  report(): Sheet[] | null;
}

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const fmtM = (m: number) => `${(m * 1000).toFixed(0)} mm`;
