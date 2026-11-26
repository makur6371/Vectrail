import { ColorGrade, WheelPoint } from './types';

export type RGB = [number, number, number];

export const GRADE_CUBE_DIM = 32;

export function defaultColorGrade(): ColorGrade {
  return {
    look: undefined,
    lookIntensity: 1,
    exposure: 0,
    contrast: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
    shadows: { x: 0, y: 0 },
    midtones: { x: 0, y: 0 },
    highlights: { x: 0, y: 0 },
  };
}

export function isGradeNeutral(grade?: ColorGrade): boolean {
  if (!grade) return true;
  const noLook = !grade.look;
  return (
    noLook &&
    (grade.exposure ?? 0) === 0 &&
    (grade.contrast ?? 0) === 0 &&
    (grade.saturation ?? 0) === 0 &&
    (grade.temperature ?? 0) === 0 &&
    (grade.tint ?? 0) === 0 &&
    (grade.shadows?.x ?? 0) === 0 &&
    (grade.shadows?.y ?? 0) === 0 &&
    (grade.midtones?.x ?? 0) === 0 &&
    (grade.midtones?.y ?? 0) === 0 &&
    (grade.highlights?.x ?? 0) === 0 &&
    (grade.highlights?.y ?? 0) === 0
  );
}

export function wheelOffset(wp?: WheelPoint): RGB {
  if (!wp) return [0, 0, 0];
  const m = Math.min(1, Math.hypot(wp.x, wp.y)) * 0.22;
  if (m <= 0) return [0, 0, 0];
  const a = Math.atan2(wp.y, wp.x);
  const third = (2 * Math.PI) / 3;
  return [Math.cos(a) * m, Math.cos(a - third) * m, Math.cos(a + third) * m];
}

export interface GradeRecipe {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  shadows?: RGB;
  midtones?: RGB;
  highlights?: RGB;
  lift?: RGB;
  fade?: number;
  custom?: (rgb: RGB) => RGB;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const luma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function applyGradeRecipe(recipe: GradeRecipe, rgb: RGB): RGB {
  if (recipe.custom) return recipe.custom(rgb);
  let [r, g, b] = rgb;
  const exposure = recipe.exposure ?? 0;
  const contrast = recipe.contrast ?? 0;
  const saturation = recipe.saturation ?? 0;
  const temperature = recipe.temperature ?? 0;
  const tint = recipe.tint ?? 0;
  const shadows = recipe.shadows ?? [0, 0, 0];
  const midtones = recipe.midtones ?? [0, 0, 0];
  const highlights = recipe.highlights ?? [0, 0, 0];
  const lift = recipe.lift ?? [0, 0, 0];
  const fade = recipe.fade ?? 0;

  const gain = Math.pow(2, exposure);
  r *= gain;
  g *= gain;
  b *= gain;

  const t = (temperature / 50) * 0.12;
  const ti = (tint / 50) * 0.1;
  r += t;
  b -= t;
  g -= ti;

  const l = clamp01(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const sh = 1 - l;
  const mid = 4 * l * (1 - l);
  r += shadows[0] * sh + midtones[0] * mid + highlights[0] * l + lift[0];
  g += shadows[1] * sh + midtones[1] * mid + highlights[1] * l + lift[1];
  b += shadows[2] * sh + midtones[2] * mid + highlights[2] * l + lift[2];

  const k = 1 + (contrast / 50) * 0.6;
  r = (r - 0.5) * k + 0.5;
  g = (g - 0.5) * k + 0.5;
  b = (b - 0.5) * k + 0.5;

  if (fade !== 0) {
    r = r * (1 - fade) + fade;
    g = g * (1 - fade) + fade;
    b = b * (1 - fade) + fade;
  }

  const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const s = 1 + saturation / 100;
  return [l2 + (r - l2) * s, l2 + (g - l2) * s, l2 + (b - l2) * s];
}

function eachRGB(c: RGB, fn: (x: number) => number): RGB {
  return [fn(c[0]), fn(c[1]), fn(c[2])];
}

function softContrast(c: RGB, k: number): RGB {
  return eachRGB(c, (x) => {
    const cx = clamp01(x);
    const s = cx * cx * (3 - 2 * cx);
    return clamp01(cx + k * (s - cx) * 2);
  });
}

function softFade(c: RGB, f: number): RGB {
  return eachRGB(c, (x) => f + (1 - f) * x);
}

function softSaturate(c: RGB, s: number): RGB {
  const l = luma(c);
  return eachRGB(c, (x) => clamp01(l + s * (x - l)));
}

function addRGB(c: RGB, t: RGB, w = 1): RGB {
  return [clamp01(c[0] + t[0] * w), clamp01(c[1] + t[1] * w), clamp01(c[2] + t[2] * w)];
}

function splitTone(c: RGB, shadows: RGB, highlights: RGB): RGB {
  const l = clamp01(luma(c));
  return addRGB(addRGB(c, shadows, (1 - l) * (1 - l)), highlights, l * l);
}

function toHSV(c: RGB): [number, number, number] {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  const d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === c[0]) h = 60 * (((c[1] - c[2]) / d) % 6);
    else if (mx === c[1]) h = 60 * ((c[2] - c[0]) / d + 2);
    else h = 60 * ((c[0] - c[1]) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, mx > 0 ? d / mx : 0, mx];
}

function fromHSV(h: number, s: number, v: number): RGB {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  if (h < 60) return [c + m, x + m, m];
  if (h < 120) return [x + m, c + m, m];
  if (h < 180) return [m, c + m, x + m];
  if (h < 240) return [m, x + m, c + m];
  if (h < 300) return [x + m, m, c + m];
  return [c + m, m, x + m];
}

function hueBand(c: RGB, center: number, width: number, shift: number, sat: number, value = 1): RGB {
  let [h, s, v] = toHSV(c);
  let d = Math.abs(h - center);
  if (d > 180) d = 360 - d;
  if (d >= width) return c;
  const w = (0.5 + 0.5 * Math.cos((d / width) * Math.PI)) * Math.min(1, s * 2.5);
  h = (((h + shift * w) % 360) + 360) % 360;
  s = clamp01(s * (1 + (sat - 1) * w));
  v = clamp01(v * (1 + (value - 1) * w));
  return fromHSV(h, s, v);
}

const FILM_PRINT_SETTINGS = [
  0.1260, 0.0872, 0.1130, 0.9273, 4.3723, 1.1754, -6.7912, 0.8993, -3.0058, 1.0943,
  -0.2338, -0.1982, -0.2908, -0.1016, -0.0275, -0.0710, 0.1846, 0.8248, 1.0324, 1.0304,
];

export const LookMath = {
  filmPrint(rgb: RGB): RGB {
    const p = FILM_PRINT_SETTINGS;
    let c = addRGB(eachRGB(rgb, clamp01), [p[0], p[1], p[2]]);
    c = eachRGB(c, (x) => Math.pow(clamp01(x), p[3]));
    c = hueBand(c, 28, 22, p[4], p[5]);
    c = hueBand(c, 110, 60, p[6], p[7]);
    c = hueBand(c, 210, 45, p[8], p[9]);
    c = splitTone(c, [p[10], p[11], p[12]], [p[13], p[14], p[15]]);
    c = softContrast(c, p[16]);
    c = softSaturate(c, p[17]);
    c = hueBand(c, 356, 20, 0, p[18], p[19]);
    return softFade(c, 0.035);
  },
  goldenHour(rgb: RGB): RGB {
    let c = splitTone(rgb, [-0.012, 0, 0.03], [0.085, 0.04, -0.06]);
    c = softContrast(c, 0.08);
    return softSaturate(c, 1.08);
  },
  bleachBypass(rgb: RGB): RGB {
    let c = softSaturate(eachRGB(rgb, clamp01), 0.42);
    c = softContrast(c, 0.42);
    return addRGB(c, [-0.01, 0, 0.008]);
  },
  pastel(rgb: RGB): RGB {
    let c = eachRGB(rgb, (x) => Math.pow(clamp01(x), 0.8));
    c = softContrast(c, -0.36);
    c = softFade(c, 0.14);
    c = splitTone(c, [0.03, 0, 0.05], [0.01, 0, 0.012]);
    return softSaturate(c, 0.8);
  },
};

export const BUILT_IN_LOOKS: Array<{ name: string; recipe: GradeRecipe }> = [
  { name: 'Warm film', recipe: { contrast: 8, saturation: -8, temperature: 18, lift: [0.02, 0, -0.02], fade: 0.03 } },
  { name: 'Golden hour', recipe: { custom: LookMath.goldenHour } },
  { name: 'Film print', recipe: { custom: LookMath.filmPrint } },
  { name: 'Teal and orange', recipe: { contrast: 12, saturation: 10, shadows: [-0.05, 0.01, 0.05], highlights: [0.06, 0.01, -0.05] } },
  { name: 'Pastel', recipe: { custom: LookMath.pastel } },
  { name: 'Bleach bypass', recipe: { custom: LookMath.bleachBypass } },
  { name: 'Mono', recipe: { contrast: 14, saturation: -100 } },
  { name: 'Cool night', recipe: { exposure: -0.25, contrast: 6, saturation: -15, temperature: -22 } },
];

const RETIRED_LOOKS: Array<{ name: string; recipe: GradeRecipe }> = [
  { name: 'Faded', recipe: { contrast: -18, saturation: -20, fade: 0.07 } },
];

export function findBuiltInLook(name?: string): GradeRecipe | undefined {
  if (!name) return undefined;
  const found = [...BUILT_IN_LOOKS, ...RETIRED_LOOKS].find((item) => item.name === name);
  return found?.recipe;
}

export interface ParsedCubeLUT {
  size: number;
  values: Float32Array;
}

export function parseCubeText(text: string): ParsedCubeLUT | undefined {
  let size = 0;
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE' && parts.length > 1) {
      size = Number.parseInt(parts[1], 10) || 0;
    } else if (parts.length === 3) {
      const r = Number.parseFloat(parts[0]);
      const g = Number.parseFloat(parts[1]);
      const b = Number.parseFloat(parts[2]);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
        values.push(r, g, b);
      }
    }
  }
  if (size < 2 || size > 256 || values.length !== size * size * size * 3) return undefined;
  return { size, values: Float32Array.from(values) };
}

export function sampleCubeLUT(lut: ParsedCubeLUT, rgb: RGB): RGB {
  const n = lut.size - 1;
  const split = (v: number): [number, number, number] => {
    const p = clamp01(v) * n;
    const i = Math.min(lut.size - 2, Math.floor(p));
    return [i, i + 1, p - i];
  };
  const [r0, r1, fr] = split(rgb[0]);
  const [g0, g1, fg] = split(rgb[1]);
  const [b0, b1, fb] = split(rgb[2]);
  const at = (r: number, g: number, b: number, c: number) =>
    lut.values[((b * lut.size + g) * lut.size + r) * 3 + c];
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(r0, g0, b0, c) * (1 - fr) + at(r1, g0, b0, c) * fr;
    const c10 = at(r0, g1, b0, c) * (1 - fr) + at(r1, g1, b0, c) * fr;
    const c01 = at(r0, g0, b1, c) * (1 - fr) + at(r1, g0, b1, c) * fr;
    const c11 = at(r0, g1, b1, c) * (1 - fr) + at(r1, g1, b1, c) * fr;
    out[c] = (c00 * (1 - fg) + c10 * fg) * (1 - fb) + (c01 * (1 - fg) + c11 * fg) * fb;
  }
  return out;
}

export function bakeGradeLUT(grade?: ColorGrade, externalCube?: ParsedCubeLUT): Float32Array | undefined {
  if (!grade || isGradeNeutral(grade)) return undefined;
  const lookRecipe = findBuiltInLook(grade.look);
  const lookFile = !lookRecipe ? externalCube : undefined;
  const user: GradeRecipe = {
    exposure: grade.exposure ?? 0,
    contrast: grade.contrast ?? 0,
    saturation: grade.saturation ?? 0,
    temperature: grade.temperature ?? 0,
    tint: grade.tint ?? 0,
    shadows: wheelOffset(grade.shadows),
    midtones: wheelOffset(grade.midtones),
    highlights: wheelOffset(grade.highlights),
  };
  const mix = clamp01(grade.lookIntensity ?? 1);
  const n = GRADE_CUBE_DIM;
  const out = new Float32Array(n * n * n * 4);
  let i = 0;
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        let c: RGB = [r / (n - 1), g / (n - 1), b / (n - 1)];
        if (mix > 0 && (lookRecipe || lookFile)) {
          const looked = lookRecipe ? applyGradeRecipe(lookRecipe, c) : sampleCubeLUT(lookFile!, c);
          c = [
            c[0] + (looked[0] - c[0]) * mix,
            c[1] + (looked[1] - c[1]) * mix,
            c[2] + (looked[2] - c[2]) * mix,
          ];
        }
        c = applyGradeRecipe(user, c);
        out[i] = clamp01(c[0]);
        out[i + 1] = clamp01(c[1]);
        out[i + 2] = clamp01(c[2]);
        out[i + 3] = 1;
        i += 4;
      }
    }
  }
  return out;
}

export function serializeGradeAsCubeText(grade: ColorGrade, externalCube?: ParsedCubeLUT): string | undefined {
  const lut = bakeGradeLUT(grade, externalCube);
  if (!lut) return undefined;
  const lines: string[] = [`TITLE "Editroom Grade"`, `LUT_3D_SIZE ${GRADE_CUBE_DIM}`];
  for (let i = 0; i < lut.length; i += 4) {
    lines.push(`${lut[i].toFixed(6)} ${lut[i + 1].toFixed(6)} ${lut[i + 2].toFixed(6)}`);
  }
  return lines.join('\n');
}
