import type { GrayFrame, PointXY } from '../core/types';
import type { Vec2 } from '../core/vec';

/**
 * Deterministic synthetic video generator with known ground-truth contours.
 *
 * Scenes are rendered from an analytic radial blob. The interior texture is
 * sampled in *object-local* coordinates, so it rotates and deforms with the
 * object and patch matching has real appearance to lock onto. The world
 * background is a different noise field. Optional occluders are opaque bars
 * that erase both the object edge and its texture in the covered region.
 *
 * Used by the benchmark and by the unit tests for known-answer checks.
 */

export interface BlobShape {
  radius: number;
  /** First harmonic: amplitude and phase of a 3-lobe wobble. */
  lobe3: number;
  phase3: number;
  /** Second harmonic: amplitude of a 5-lobe wobble. */
  lobe5: number;
}

export interface FrameMotion {
  cx: number;
  cy: number;
  angle: number;
  scale: number;
  shape: BlobShape;
}

export interface Occluder {
  /** Axis-aligned rectangle in world pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneConfig {
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  /** Number of ground-truth control points around the boundary. */
  controlPoints: number;
  /** Dense analytic samples used as the ground-truth polygon. */
  truthSamples: number;
  motion: (frame: number) => FrameMotion;
  occluder?: (frame: number) => Occluder | null;
  seed?: number;
  /** Peak sensor noise added to every pixel (0..40). */
  noise?: number;
  background?: { base: number; amplitude: number };
  object?: { base: number; amplitude: number };
}

export interface TruthFrame {
  frame: number;
  /** Motion parameters used to render this frame. */
  motion: FrameMotion;
  /** Dense boundary polygon in world pixels. */
  polygon: Vec2[];
  /** Ground-truth positions of the tracked control points, same order/ids. */
  controlPoints: Vec2[];
  /** Per-control-point occlusion flag from the occluder rectangle. */
  occluded: boolean[];
}

export interface SyntheticClip {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  controlPointCount: number;
  gray: GrayFrame[];
  /** RGB frames for preview/export (same dimensions). */
  rgb: Uint8ClampedArray[];
  truth: TruthFrame[];
}

// ---------------------------------------------------------------- noise ----

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

function fbm(x: number, y: number, seed: number): number {
  return (
    valueNoise(x, y, seed) * 0.55 +
    valueNoise(x * 2.03, y * 2.03, seed + 17) * 0.3 +
    valueNoise(x * 4.11, y * 4.11, seed + 31) * 0.15
  );
}

// ---------------------------------------------------------------- shape ----

export function blobRadius(theta: number, shape: BlobShape): number {
  const r =
    shape.radius *
    (1 + shape.lobe3 * Math.cos(3 * theta + shape.phase3) + shape.lobe5 * Math.cos(5 * theta + 0.7));
  return Math.max(1, r);
}

export function localBoundary(shape: BlobShape, count: number, offset = 0): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const theta = offset + (i / count) * Math.PI * 2;
    const r = blobRadius(theta, shape);
    out.push({ x: r * Math.cos(theta), y: r * Math.sin(theta) });
  }
  return out;
}

export function transformPoints(points: Vec2[], m: FrameMotion): Vec2[] {
  const c = Math.cos(m.angle);
  const s = Math.sin(m.angle);
  return points.map((p) => ({
    x: m.cx + (p.x * c - p.y * s) * m.scale,
    y: m.cy + (p.x * s + p.y * c) * m.scale,
  }));
}

// ---------------------------------------------------------------- render ----

function clampByte(x: number): number {
  return x < 0 ? 0 : x > 255 ? 255 : x;
}

function renderFrame(
  cfg: SceneConfig,
  frame: number,
  shape: BlobShape,
  motion: FrameMotion,
  occ: Occluder | null,
): { gray: GrayFrame; rgb: Uint8ClampedArray } {
  const { width, height } = cfg;
  const seed = cfg.seed ?? 7;
  const noise = cfg.noise ?? 4;
  const bg = cfg.background ?? { base: 96, amplitude: 34 };
  const obj = cfg.object ?? { base: 186, amplitude: 46 };

  const gray = new Uint8Array(width * height);
  const rgb = new Uint8ClampedArray(width * height * 4);

  const cosA = Math.cos(-motion.angle);
  const sinA = Math.sin(-motion.angle);
  const invScale = 1 / motion.scale;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      // World background.
      const bgv = bg.base + (fbm(px * 0.035, py * 0.035, seed) - 0.5) * 2 * bg.amplitude;

      // Inverse rigid transform to object-local coordinates.
      const dx = (px - motion.cx) * invScale;
      const dy = (py - motion.cy) * invScale;
      const u = dx * cosA - dy * sinA;
      const v = dx * sinA + dy * cosA;

      const theta = Math.atan2(v, u);
      const r = Math.hypot(u, v);
      const edge = blobRadius(theta, shape);
      // Signed distance to the boundary in local units, then to world pixels.
      const signed = (edge - r) * motion.scale;

      // Object interior texture: coarse mottling plus a fine speckle field so
      // that patches straddling the boundary are not tangentially ambiguous.
      const coarse = fbm(u * 0.16 + 40, v * 0.16 + 40, seed + 101);
      const fine = fbm(u * 0.6 + 9, v * 0.6 + 9, seed + 211);
      const texCombined = coarse * 0.6 + fine * 0.4;
      const objValue = obj.base + (texCombined - 0.5) * 2 * obj.amplitude;

      let value: number;
      if (signed <= -0.8) {
        value = bgv;
      } else if (signed >= 0.8) {
        value = objValue;
      } else {
        // Soft anti-aliased boundary with a slight darker rim.
        const t = (signed + 0.8) / 1.6;
        const rim = -18 * Math.exp(-((signed / 0.45) ** 2));
        value = bgv * (1 - t) + (objValue + rim) * t;
      }

      if (occ && px >= occ.x && px <= occ.x + occ.w && py >= occ.y && py <= occ.y + occ.h) {
        const ov = 104 + (fbm(px * 0.22, py * 0.22, seed + 401) - 0.5) * 22;
        value = ov;
      }

      const n = (hash2(x, y, seed + frame * 131) - 0.5) * 2 * noise;
      const final = clampByte(Math.round(value + n));
      gray[y * width + x] = final;
      const o = (y * width + x) * 4;
      // Slight colour tint so the demo does not look like a pure luma render.
      const tintR = clampByte(final + (value > bg.base ? 12 : -6));
      const tintB = clampByte(final - (value > bg.base ? 10 : -2));
      rgb[o] = tintR;
      rgb[o + 1] = final;
      rgb[o + 2] = tintB;
      rgb[o + 3] = 255;
    }
  }

  return { gray: { width, height, data: gray }, rgb };
}

function pointInRect(p: PointXY, r: Occluder): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function generateScene(cfg: SceneConfig): SyntheticClip {
  const gray: GrayFrame[] = [];
  const rgb: Uint8ClampedArray[] = [];
  const truth: TruthFrame[] = [];

  for (let f = 0; f < cfg.frameCount; f++) {
    const motion = cfg.motion(f);
    const occ = cfg.occluder ? cfg.occluder(f) : null;
    const rendered = renderFrame(cfg, f, motion.shape, motion, occ);
    gray.push(rendered.gray);
    rgb.push(rendered.rgb);

    // Ground truth is the analytic boundary transformed by the exact same
    // matrix the renderer used, so it is not inferred from the image.
    const truthLocal = localBoundary(motion.shape, cfg.truthSamples);
    const controlLocal = localBoundary(motion.shape, cfg.controlPoints);
    const polygon = transformPoints(truthLocal, motion);
    const controlPoints = transformPoints(controlLocal, motion);
    const occluded = controlPoints.map((p) => (occ ? pointInRect(p, occ) : false));
    truth.push({ frame: f, motion, polygon, controlPoints, occluded });
  }

  return {
    width: cfg.width,
    height: cfg.height,
    fps: cfg.fps,
    frameCount: cfg.frameCount,
    controlPointCount: cfg.controlPoints,
    gray,
    rgb,
    truth,
  };
}

// ------------------------------------------------------------- scenarios ----

export type ScenarioName = 'rotation' | 'deformation' | 'occlusion' | 'combined';

export function scenarioConfig(name: ScenarioName, options: { width?: number; height?: number; frames?: number } = {}): SceneConfig {
  const width = options.width ?? 320;
  const height = options.height ?? 240;
  const baseShape: BlobShape = { radius: 56, lobe3: 0.16, phase3: 0.4, lobe5: 0.07 };

  if (name === 'rotation') {
    const frames = options.frames ?? 60;
    return {
      width,
      height,
      frameCount: frames,
      fps: 30,
      controlPoints: 24,
      truthSamples: 240,
      seed: 11,
      noise: 3,
      motion: (f) => {
        const t = frames > 1 ? f / (frames - 1) : 0;
        return {
          cx: width * 0.5 + Math.sin(t * Math.PI * 1.5) * 18,
          cy: height * 0.5 + Math.cos(t * Math.PI) * 8,
          angle: t * (Math.PI / 4.5),
          scale: 1 + 0.08 * t,
          shape: baseShape,
        };
      },
    };
  }

  if (name === 'deformation') {
    const frames = options.frames ?? 60;
    return {
      width,
      height,
      frameCount: frames,
      fps: 30,
      controlPoints: 28,
      truthSamples: 280,
      seed: 23,
      noise: 3,
      motion: (f) => {
        const t = frames > 1 ? f / (frames - 1) : 0;
        return {
          cx: width * 0.52,
          cy: height * 0.5,
          angle: Math.sin(t * Math.PI * 2) * 0.22,
          scale: 1 + 0.16 * Math.sin(t * Math.PI),
          shape: {
            radius: 54,
            lobe3: 0.12 + 0.18 * Math.sin(t * Math.PI * 2.2),
            phase3: 0.4 + t * 1.7,
            lobe5: 0.05 + 0.12 * t,
          },
        };
      },
    };
  }

  if (name === 'occlusion') {
    const frames = options.frames ?? 80;
    return {
      width,
      height,
      frameCount: frames,
      fps: 30,
      controlPoints: 26,
      truthSamples: 260,
      seed: 37,
      noise: 4,
      motion: (f) => {
        const t = frames > 1 ? f / (frames - 1) : 0;
        return {
          cx: width * 0.5 + Math.sin(t * Math.PI) * 26,
          cy: height * 0.5 + t * 6,
          angle: t * 0.5,
          scale: 1 + 0.05 * Math.sin(t * Math.PI * 2),
          shape: baseShape,
        };
      },
      occluder: (f) => {
        // A vertical bar sweeps left→right, fully covering a span of the contour.
        const t = frames > 1 ? f / (frames - 1) : 0;
        const x = -30 + t * (width + 20);
        return { x, y: 24, w: 56, h: height - 48 };
      },
    };
  }

  // combined: rotation + deformation + a mid-clip occluder sweep
  const frames = options.frames ?? 90;
  return {
    width,
    height,
    frameCount: frames,
    fps: 30,
    controlPoints: 28,
    truthSamples: 280,
    seed: 53,
    noise: 4,
    motion: (f) => {
      const t = frames > 1 ? f / (frames - 1) : 0;
      return {
        cx: width * 0.5 + Math.sin(t * Math.PI * 1.2) * 22,
        cy: height * 0.5 + Math.cos(t * Math.PI * 0.9) * 12,
        angle: t * 0.9,
        scale: 1 + 0.12 * Math.sin(t * Math.PI),
        shape: {
          radius: 54,
          lobe3: 0.13 + 0.1 * Math.sin(t * Math.PI * 2),
          phase3: 0.4 + t * 1.2,
          lobe5: 0.06 + 0.06 * t,
        },
      };
    },
    occluder: (f) => {
      // Only occludes during the middle third, then clears.
      const t = frames > 1 ? f / (frames - 1) : 0;
      if (t < 0.28 || t > 0.62) return null;
      const k = (t - 0.28) / 0.34;
      return { x: width * (0.18 + k * 0.45), y: 40, w: 44, h: height - 80 };
    },
  };
}
