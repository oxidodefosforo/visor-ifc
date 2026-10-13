import * as THREE from "three";

/**
 * Texturas procedurales generadas en el propio programa (canvas 2D): sin descargas,
 * sin licencias, deterministas (misma semilla → misma imagen). Cada generador
 * devuelve la imagen y el tamaño real en metros que representa (para la escala).
 */
export type TextureKey =
  | "concrete" | "formwork" | "brick" | "block" | "plaster" | "wood" | "parquet"
  | "tiles" | "stone" | "brushed" | "asphalt" | "grass" | "gravel";

type Gen = { size: number; draw: (ctx: CanvasRenderingContext2D, n: number, rnd: () => number) => void };

const N = 512;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ruido de valor periódico (la textura se repite sin costuras). */
function valueNoise(n: number, cells: number, rnd: () => number) {
  const grid = Array.from({ length: cells * cells }, rnd);
  const at = (x: number, y: number) => grid[((y % cells) + cells) % cells * cells + (((x % cells) + cells) % cells)];
  const out = new Float32Array(n * n);
  const s = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const fx = (x / n) * cells, fy = (y / n) * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = s(fx - x0), ty = s(fy - y0);
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      out[y * n + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  return out;
}

function fbm(n: number, rnd: () => number, octaves: [number, number][]) {
  const out = new Float32Array(n * n);
  let total = 0;
  for (const [cells, w] of octaves) {
    const layer = valueNoise(n, cells, rnd);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * w;
    total += w;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Pinta un campo de ruido modulando un color base (±amp). */
function paintNoise(ctx: CanvasRenderingContext2D, n: number, field: Float32Array, rgb: [number, number, number], amp: number) {
  const img = ctx.getImageData(0, 0, n, n);
  for (let i = 0; i < n * n; i++) {
    const k = 1 + (field[i] - 0.5) * 2 * amp;
    const j = i * 4;
    img.data[j] = Math.min(255, img.data[j] * k * (rgb[0] / 255) * 2) ;
    img.data[j + 1] = Math.min(255, img.data[j + 1] * k * (rgb[1] / 255) * 2);
    img.data[j + 2] = Math.min(255, img.data[j + 2] * k * (rgb[2] / 255) * 2);
  }
  ctx.putImageData(img, 0, 0);
}

function fillNoise(ctx: CanvasRenderingContext2D, n: number, rnd: () => number, rgb: [number, number, number], amp: number, octaves: [number, number][]) {
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, n, n);
  paintNoise(ctx, n, fbm(n, rnd, octaves), rgb, amp);
}

function speckles(ctx: CanvasRenderingContext2D, n: number, rnd: () => number, count: number, color: () => string, rMax: number) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = color();
    ctx.beginPath();
    ctx.arc(rnd() * n, rnd() * n, 0.4 + rnd() * rMax, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Mampostería en hiladas (ladrillo, bloque). */
function masonry(ctx: CanvasRenderingContext2D, n: number, rnd: () => number, rows: number, cols: number, mortar: number, base: [number, number, number], vary: number, mortarColor: string) {
  ctx.fillStyle = mortarColor;
  ctx.fillRect(0, 0, n, n);
  const h = n / rows, w = n / cols;
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? w / 2 : 0;
    for (let c = -1; c <= cols; c++) {
      const v = 1 + (rnd() - 0.5) * vary;
      ctx.fillStyle = `rgb(${base.map((x) => Math.round(Math.min(255, x * v))).join(",")})`;
      ctx.fillRect(c * w + off + mortar / 2, r * h + mortar / 2, w - mortar, h - mortar);
    }
  }
  // grano fino encima
  const img = ctx.getImageData(0, 0, n, n);
  const field = fbm(n, rnd, [[64, 1], [128, 0.6]]);
  for (let i = 0; i < n * n; i++) {
    const k = 0.88 + field[i] * 0.24;
    img.data[i * 4] *= k; img.data[i * 4 + 1] *= k; img.data[i * 4 + 2] *= k;
  }
  ctx.putImageData(img, 0, 0);
}

const GENERATORS: Record<TextureKey, Gen> = {
  concrete: {
    size: 2,
    draw: (ctx, n, rnd) => {
      fillNoise(ctx, n, rnd, [128, 126, 122], 0.18, [[4, 1], [16, 0.6], [64, 0.35], [256, 0.25]]);
      speckles(ctx, n, rnd, 900, () => `rgba(${rnd() < 0.5 ? "60,60,60" : "220,220,215"},${0.15 + rnd() * 0.25})`, 1.4);
    },
  },
  formwork: {
    size: 2.4,
    draw: (ctx, n, rnd) => {
      fillNoise(ctx, n, rnd, [126, 124, 120], 0.14, [[8, 1], [32, 0.5], [128, 0.3]]);
      const planks = 8;
      for (let i = 0; i < planks; i++) {
        ctx.fillStyle = `rgba(${rnd() < 0.5 ? "0,0,0" : "255,255,255"},${0.03 + rnd() * 0.05})`;
        ctx.fillRect(0, (i * n) / planks, n, n / planks);
        ctx.fillStyle = "rgba(40,40,40,0.35)";
        ctx.fillRect(0, (i * n) / planks, n, 1.5);
      }
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
        ctx.fillStyle = "rgba(50,50,50,0.6)";
        ctx.beginPath(); ctx.arc(n * (0.25 + x * 0.5), n * (0.25 + y * 0.5), 5, 0, Math.PI * 2); ctx.fill();
      }
    },
  },
  brick: {
    size: 0.9, // 12 hiladas de 75 mm × 4 ladrillos de 225 mm
    draw: (ctx, n, rnd) => masonry(ctx, n, rnd, 12, 4, 6, [150, 72, 50], 0.28, "#b7aea2"),
  },
  block: {
    size: 0.8, // bloques de 400 × 200 mm
    draw: (ctx, n, rnd) => masonry(ctx, n, rnd, 4, 2, 7, [165, 162, 155], 0.12, "#8d8a84"),
  },
  plaster: {
    size: 1.5,
    draw: (ctx, n, rnd) => fillNoise(ctx, n, rnd, [128, 127, 125], 0.05, [[8, 1], [64, 0.6], [256, 0.4]]),
  },
  wood: {
    size: 1,
    draw: (ctx, n, rnd) => {
      const warp = fbm(n, rnd, [[4, 1], [16, 0.4]]);
      const fine = fbm(n, rnd, [[128, 1], [256, 0.5]]);
      const img = ctx.createImageData(n, n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = y * n + x;
        const g = 0.5 + 0.5 * Math.sin((y / n) * 70 + warp[i] * 9);
        const k = 0.72 + g * 0.22 + (fine[i] - 0.5) * 0.12;
        img.data[i * 4] = 168 * k; img.data[i * 4 + 1] = 112 * k; img.data[i * 4 + 2] = 68 * k; img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    },
  },
  parquet: {
    size: 1.2,
    draw: (ctx, n, rnd) => {
      GENERATORS.wood.draw(ctx, n, rnd);
      const rows = 8, h = n / rows;
      for (let r = 0; r < rows; r++) {
        const tone = 0.85 + rnd() * 0.3;
        ctx.fillStyle = `rgba(${tone > 1 ? "255,240,220" : "40,20,10"},${Math.abs(tone - 1) * 0.6})`;
        ctx.fillRect(0, r * h, n, h);
        ctx.fillStyle = "rgba(30,18,10,0.55)";
        ctx.fillRect(0, r * h, n, 1.5);
        const cut = (r % 2 ? 0.33 : 0.8) * n;
        ctx.fillRect(cut, r * h, 1.5, h);
      }
    },
  },
  tiles: {
    size: 1.2, // 4 × 4 baldosas de 300 mm
    draw: (ctx, n, rnd) => {
      fillNoise(ctx, n, rnd, [132, 131, 128], 0.06, [[16, 1], [128, 0.5]]);
      const cells = 4, s = n / cells;
      for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
        ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.06})`;
        ctx.fillRect(x * s, y * s, s, s);
      }
      ctx.fillStyle = "#9b978f";
      for (let i = 0; i <= cells; i++) {
        ctx.fillRect(i * s - 2, 0, 4, n);
        ctx.fillRect(0, i * s - 2, n, 4);
      }
    },
  },
  stone: {
    size: 1,
    draw: (ctx, n, rnd) => {
      fillNoise(ctx, n, rnd, [130, 124, 116], 0.22, [[6, 1], [24, 0.7], [96, 0.4], [256, 0.2]]);
      speckles(ctx, n, rnd, 2500, () => `rgba(${rnd() < 0.6 ? "30,30,30" : "240,235,225"},${0.2 + rnd() * 0.4})`, 1.2);
    },
  },
  brushed: {
    size: 0.5,
    draw: (ctx, n, rnd) => {
      ctx.fillStyle = "#8a8c90";
      ctx.fillRect(0, 0, n, n);
      for (let i = 0; i < 2200; i++) {
        const y = rnd() * n, len = n * (0.2 + rnd() * 0.8), x = rnd() * n;
        ctx.strokeStyle = `rgba(${rnd() < 0.5 ? "255,255,255" : "0,0,0"},${0.03 + rnd() * 0.06})`;
        ctx.lineWidth = 0.6 + rnd();
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - n, y); ctx.lineTo(x - n + len, y); ctx.stroke();
      }
    },
  },
  asphalt: {
    size: 2,
    draw: (ctx, n, rnd) => {
      fillNoise(ctx, n, rnd, [70, 70, 72], 0.12, [[16, 1], [64, 0.6], [256, 0.5]]);
      speckles(ctx, n, rnd, 4000, () => `rgba(${rnd() < 0.5 ? "20,20,20" : "170,168,160"},${0.25 + rnd() * 0.35})`, 1.1);
    },
  },
  grass: {
    size: 2,
    draw: (ctx, n, rnd) => {
      fillNoise(ctx, n, rnd, [78, 108, 52], 0.25, [[4, 1], [16, 0.7], [64, 0.5], [256, 0.4]]);
      for (let i = 0; i < 6000; i++) {
        const x = rnd() * n, y = rnd() * n, l = 2 + rnd() * 5, a = rnd() * Math.PI;
        ctx.strokeStyle = `rgba(${rnd() < 0.5 ? "40,70,25" : "140,170,90"},${0.25 + rnd() * 0.3})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y - Math.sin(a) * l); ctx.stroke();
      }
    },
  },
  gravel: {
    size: 1,
    draw: (ctx, n, rnd) => {
      fillNoise(ctx, n, rnd, [120, 114, 104], 0.15, [[32, 1], [128, 0.5]]);
      for (let i = 0; i < 1600; i++) {
        const v = 90 + rnd() * 120;
        ctx.fillStyle = `rgb(${v},${v * 0.96},${v * 0.9})`;
        ctx.beginPath();
        ctx.ellipse(rnd() * n, rnd() * n, 2 + rnd() * 5, 2 + rnd() * 4, rnd() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
};

export const TEXTURE_KEYS = Object.keys(GENERATORS) as TextureKey[];

const cache = new Map<string, THREE.Texture>();

function prepare(tex: THREE.Texture) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Textura procedural (cacheada) y su tamaño real en metros. */
export function proceduralTexture(key: TextureKey): { texture: THREE.Texture; size: number } {
  const gen = GENERATORS[key];
  let tex = cache.get(key);
  if (!tex) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = N;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    let seed = 0;
    for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
    gen.draw(ctx, N, mulberry32(seed));
    tex = prepare(new THREE.CanvasTexture(canvas));
    tex.name = key;
    cache.set(key, tex);
  }
  return { texture: tex, size: gen.size };
}

/** Miniatura (dataURL) para la interfaz. */
export function textureThumb(key: TextureKey, px = 64) {
  const src = proceduralTexture(key).texture.image as HTMLCanvasElement;
  const c = document.createElement("canvas");
  c.width = c.height = px;
  c.getContext("2d")!.drawImage(src, 0, 0, px, px);
  return c.toDataURL("image/png");
}

/** Textura desde una imagen del usuario (dataURL guardado localmente). */
export function imageTexture(id: string, dataUrl: string): THREE.Texture {
  const key = `custom:${id}`;
  let tex = cache.get(key);
  if (!tex) {
    const img = new Image();
    tex = new THREE.Texture(img);
    img.onload = () => prepare(tex!);
    img.src = dataUrl;
    tex.name = key;
    cache.set(key, tex);
  }
  return tex;
}

/** Reduce una imagen elegida por el usuario a ≤1024 px y la devuelve como JPEG (para guardarla). */
export async function imageFileToDataUrl(file: File, max = 1024): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.85);
}
