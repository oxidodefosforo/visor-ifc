import { zlibSync } from "fflate";

/**
 * Dibujo 2D vectorial (planta) y su exportación a PDF (vectorial, sin librerías) y DXF (R12 ASCII,
 * se abre en AutoCAD, BricsCAD, Revit…). Unidades del dibujo: metros.
 */
export type Style = { width: number; color: [number, number, number]; dash?: number[] };
export type Prim =
  | { t: "line"; layer: string; style: string; x1: number; y1: number; x2: number; y2: number }
  | { t: "fill"; layer: string; color: [number, number, number]; loops: number[][] }
  | { t: "text"; layer: string; x: number; y: number; h: number; s: string; align?: "left" | "center" | "right"; bold?: boolean; color?: [number, number, number] };

export type Drawing = {
  prims: Prim[];
  styles: Record<string, Style>; // anchos en mm de papel
  layers: { name: string; aci: number }[]; // color AutoCAD por capa
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
};

// ---------------------------------------------------------------- PDF
const latin1 = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 256 ? c : c === 0x2014 ? 0x97 : c === 0x2013 ? 0x96 : c === 0x2022 ? 0x95 : c === 0x2192 ? 0x3e : 0x3f;
  }
  return out;
};
const pdfStr = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
const f = (n: number) => (Math.abs(n) < 1e-6 ? "0" : n.toFixed(3).replace(/\.?0+$/, ""));

/**
 * Página PDF con el dibujo a escala 1:scale. `paper` en mm; el dibujo se coloca en `area`
 * (mm desde la esquina inferior izquierda) centrado. Devuelve el archivo .pdf.
 */
export function drawingToPdf(d: Drawing, opts: { paper: [number, number]; area: [number, number, number, number]; scale: number; extra?: Prim[] }) {
  const MM = 72 / 25.4;
  const [pw, ph] = opts.paper;
  const [ax, ay, aw, ah] = opts.area;
  const cx = (d.bounds.minX + d.bounds.maxX) / 2, cy = (d.bounds.minY + d.bounds.maxY) / 2;
  // metros → mm de papel: (m * 1000 / scale)
  const k = 1000 / opts.scale;
  const tx = (x: number) => (ax + aw / 2 + (x - cx) * k) * MM;
  const ty = (y: number) => (ay + ah / 2 + (y - cy) * k) * MM;
  const ops: string[] = ["1 J 1 j"];
  // Recorte al área de dibujo
  ops.push(`q ${f(ax * MM)} ${f(ay * MM)} ${f(aw * MM)} ${f(ah * MM)} re W n`);
  for (const p of d.prims) {
    if (p.t === "fill") {
      ops.push(`${p.color.map((c) => f(c / 255)).join(" ")} rg`);
      for (const loop of p.loops) {
        for (let i = 0; i < loop.length; i += 2) ops.push(`${f(tx(loop[i]))} ${f(ty(loop[i + 1]))} ${i ? "l" : "m"}`);
        ops.push("h");
      }
      ops.push("f*");
    }
  }
  let cur = "";
  for (const p of d.prims) {
    if (p.t !== "line") continue;
    if (p.style !== cur) {
      if (cur) ops.push("S");
      const s = d.styles[p.style];
      ops.push(`${f(s.width * MM)} w ${s.color.map((c) => f(c / 255)).join(" ")} RG [${(s.dash ?? []).map((x) => f(x * MM)).join(" ")}] 0 d`);
      cur = p.style;
    }
    ops.push(`${f(tx(p.x1))} ${f(ty(p.y1))} m ${f(tx(p.x2))} ${f(ty(p.y2))} l`);
  }
  if (cur) ops.push("S");
  ops.push("Q");
  const text = (p: Extract<Prim, { t: "text" }>, paperUnits: boolean) => {
    const x = paperUnits ? p.x * MM : tx(p.x), y = paperUnits ? p.y * MM : ty(p.y);
    const size = (paperUnits ? p.h : p.h * k) * MM;
    const w = p.s.length * size * 0.5; // ancho aproximado (Helvetica)
    const dx = p.align === "center" ? -w / 2 : p.align === "right" ? -w : 0;
    ops.push(`BT /${p.bold ? "F2" : "F1"} ${f(size)} Tf ${(p.color ?? [20, 20, 20]).map((c) => f(c / 255)).join(" ")} rg ${f(x + dx)} ${f(y)} Td ${pdfStr(p.s)} Tj ET`);
  };
  for (const p of d.prims) if (p.t === "text") text(p, false);
  // Elementos de la hoja (marco, cajetín) en mm de papel
  for (const p of opts.extra ?? []) {
    if (p.t === "line") {
      const s = d.styles[p.style] ?? { width: 0.25, color: [0, 0, 0] };
      ops.push(`${f(s.width * MM)} w ${s.color.map((c) => f(c / 255)).join(" ")} RG [] 0 d ${f(p.x1 * MM)} ${f(p.y1 * MM)} m ${f(p.x2 * MM)} ${f(p.y2 * MM)} l S`);
    } else if (p.t === "text") text(p, true);
  }
  const content = zlibSync(latin1(ops.join("\n")), { level: 6 });
  const W = pw * MM, H = ph * MM;
  const objs: (string | Uint8Array)[][] = [
    ["<< /Type /Catalog /Pages 2 0 R >>"],
    ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(W)} ${f(H)}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`],
    [`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, content, "\nendstream"],
    ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"],
    ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"],
    [`<< /Producer (Visor IFC) /Creator (Visor IFC - Planta 2D) >>`],
  ];
  const parts: Uint8Array[] = [];
  let len = 0;
  const push = (x: string | Uint8Array) => {
    const b = typeof x === "string" ? latin1(x) : x;
    parts.push(b);
    len += b.length;
  };
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(len);
    push(`${i + 1} 0 obj\n`);
    o.forEach(push);
    push("\nendobj\n");
  });
  const xref = len;
  push(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${objs.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

// ---------------------------------------------------------------- DXF
const dxfText = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7e -ÿ]/g, "-");

/** DXF R12 (AC1009), unidades en metros. Capas con color; líneas discontinuas con tipo DASHED. */
export function drawingToDxf(d: Drawing) {
  const L: string[] = [];
  const g = (code: number, v: string | number) => L.push(String(code), typeof v === "number" ? f(v) : v);
  g(0, "SECTION"); g(2, "HEADER");
  g(9, "$ACADVER"); g(1, "AC1009");
  g(9, "$INSUNITS"); g(70, "6");
  g(9, "$EXTMIN"); g(10, d.bounds.minX); g(20, d.bounds.minY); g(30, 0);
  g(9, "$EXTMAX"); g(10, d.bounds.maxX); g(20, d.bounds.maxY); g(30, 0);
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LTYPE"); g(70, "2");
  g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, "0"); g(3, "Solid line"); g(72, "65"); g(73, "0"); g(40, 0);
  g(0, "LTYPE"); g(2, "DASHED"); g(70, "0"); g(3, "__ __ __"); g(72, "65"); g(73, "2"); g(40, 0.3); g(49, 0.2); g(49, -0.1);
  g(0, "ENDTAB");
  g(0, "TABLE"); g(2, "LAYER"); g(70, String(d.layers.length + 1));
  g(0, "LAYER"); g(2, "0"); g(70, "0"); g(62, "7"); g(6, "CONTINUOUS");
  for (const l of d.layers) {
    g(0, "LAYER"); g(2, dxfText(l.name)); g(70, "0"); g(62, String(l.aci)); g(6, "CONTINUOUS");
  }
  g(0, "ENDTAB");
  g(0, "TABLE"); g(2, "STYLE"); g(70, "1");
  g(0, "STYLE"); g(2, "STANDARD"); g(70, "0"); g(40, 0); g(41, 1); g(50, 0); g(71, "0"); g(42, 0.2); g(3, "txt"); g(4, "");
  g(0, "ENDTAB");
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  for (const p of d.prims) {
    if (p.t === "line") {
      g(0, "LINE"); g(8, dxfText(p.layer));
      if (d.styles[p.style]?.dash) g(6, "DASHED");
      g(10, p.x1); g(20, p.y1); g(30, 0); g(11, p.x2); g(21, p.y2); g(31, 0);
    } else if (p.t === "text") {
      g(0, "TEXT"); g(8, dxfText(p.layer)); g(10, p.x); g(20, p.y); g(30, 0); g(40, p.h); g(1, dxfText(p.s));
      if (p.align && p.align !== "left") {
        g(72, p.align === "center" ? "1" : "2"); g(11, p.x); g(21, p.y); g(31, 0);
      }
    } else if (p.t === "fill") {
      // Contornos del corte como polilíneas cerradas (el relleno sólido se deja al CAD).
      for (const loop of p.loops) {
        g(0, "POLYLINE"); g(8, dxfText(p.layer)); g(66, "1"); g(70, "1");
        for (let i = 0; i < loop.length; i += 2) {
          g(0, "VERTEX"); g(8, dxfText(p.layer)); g(10, loop[i]); g(20, loop[i + 1]); g(30, 0);
        }
        g(0, "SEQEND"); g(8, dxfText(p.layer));
      }
    }
  }
  g(0, "ENDSEC");
  g(0, "EOF");
  return L.join("\r\n") + "\r\n";
}
