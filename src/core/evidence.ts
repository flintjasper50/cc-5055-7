import type { GrayFrame, PointTemplate, PointXY } from './types';
import type { Vec2 } from './vec';

/**
 * Image evidence for contour tracking.
 *
 * Luma is stored as a 1-D `Uint8Array` (row major). All sampling is bilinear.
 * Nothing here mutates frames; callers own them.
 */

const EDGE_EPS = 1e-9;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function makeGrayFrame(width: number, height: number, data?: Uint8Array): GrayFrame {
  return { width, height, data: data ?? new Uint8Array(width * height) };
}

export function bilinear(frame: GrayFrame, x: number, y: number): number {
  const { width, height, data } = frame;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const i00 = data[y0 * width + x0];
  const i10 = data[y0 * width + x1];
  const i01 = data[y1 * width + x0];
  const i11 = data[y1 * width + x1];
  return (
    i00 * (1 - fx) * (1 - fy) +
    i10 * fx * (1 - fy) +
    i01 * (1 - fx) * fy +
    i11 * fx * fy
  );
}

/** Central-difference gradient of the bilinear luminance field. */
export function gradientAt(frame: GrayFrame, x: number, y: number): Vec2 {
  const gx = (bilinear(frame, x + 0.5, y) - bilinear(frame, x - 0.5, y)) * 0.5;
  const gy = (bilinear(frame, x, y + 0.5) - bilinear(frame, x, y - 0.5)) * 0.5;
  return { x: gx, y: gy };
}

export function gradientMagnitudeAt(frame: GrayFrame, x: number, y: number): number {
  const g = gradientAt(frame, x, y);
  return Math.hypot(g.x, g.y);
}

/**
 * Normalised cross-correlation between the template patch (integer lattice of
 * the *previous* frame) and a displaced patch in the current frame.
 */
export function nccAt(
  prev: GrayFrame,
  curr: GrayFrame,
  center: PointXY,
  dx: number,
  dy: number,
  radius: number,
): number {
  const size = radius * 2 + 1;
  const count = size * size;
  const px = Math.round(center.x);
  const py = Math.round(center.y);

  let sumA = 0;
  let sumB = 0;
  for (let v = -radius; v <= radius; v++) {
    for (let u = -radius; u <= radius; u++) {
      const ax = px + u;
      const ay = py + v;
      if (ax < 0 || ay < 0 || ax >= prev.width || ay >= prev.height) continue;
      sumA += prev.data[ay * prev.width + ax];
      const bx = ax + dx;
      const by = ay + dy;
      sumB += bilinear(curr, bx, by);
    }
  }
  const meanA = sumA / count;
  const meanB = sumB / count;

  let num = 0;
  let varA = 0;
  let varB = 0;
  for (let v = -radius; v <= radius; v++) {
    for (let u = -radius; u <= radius; u++) {
      const ax = px + u;
      const ay = py + v;
      if (ax < 0 || ay < 0 || ax >= prev.width || ay >= prev.height) continue;
      const da = prev.data[ay * prev.width + ax] - meanA;
      const bx = ax + dx;
      const by = ay + dy;
      const db = bilinear(curr, bx, by) - meanB;
      num += da * db;
      varA += da * da;
      varB += db * db;
    }
  }
  const denom = Math.sqrt(varA * varB);
  if (denom < 1e-6) return 0;
  return clamp01((num / denom + 1) * 0.5) * 2 - 1;
}

export interface PatchSearchResult {
  dx: number;
  dy: number;
  ncc: number;
  outOfBounds: boolean;
}

/**
 * Integer-lattice patch search plus optional parabolic sub-pixel refinement.
 * Search space is a disc of radius `searchRadius`.
 */
export function searchPatch(
  prev: GrayFrame,
  curr: GrayFrame,
  center: PointXY,
  patchRadius: number,
  searchRadius: number,
  subpixel: boolean,
  preferred?: PointXY,
): PatchSearchResult {
  const px = Math.round(center.x);
  const py = Math.round(center.y);
  const margin = patchRadius + 1;
  const outOfBounds =
    px < margin || py < margin || px >= prev.width - margin || py >= prev.height - margin;

  let best = -Infinity;
  let bestDx = preferred?.x ?? 0;
  let bestDy = preferred?.y ?? 0;
  let any = false;

  const scores = new Map<string, number>();
  const r = Math.max(0, Math.round(searchRadius));
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > searchRadius * searchRadius + 1e-6) continue;
      any = true;
      // A small preference toward the motion prior breaks ties smoothly.
      let score = nccAt(prev, curr, center, dx, dy, patchRadius);
      if (preferred) {
        const bias = Math.hypot(dx - preferred.x, dy - preferred.y);
        score -= bias * 0.004;
      }
      scores.set(`${dx},${dy}`, score);
      if (score > best) {
        best = score;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  let fx = bestDx;
  let fy = bestDy;
  let peak = best;
  if (subpixel && any) {
    const at = (dx: number, dy: number): number | null => scores.get(`${dx},${dy}`) ?? null;
    const parabolic = (a: number | null, b: number, c: number | null): number => {
      if (a == null || c == null) return 0;
      const denom2 = a - 2 * b + c;
      if (Math.abs(denom2) < EDGE_EPS) return 0;
      return (0.5 * (a - c)) / denom2;
    };
    const ox = parabolic(at(bestDx - 1, bestDy), best, at(bestDx + 1, bestDy));
    const oy = parabolic(at(bestDx, bestDy - 1), best, at(bestDx, bestDy + 1));
    fx = bestDx + Math.max(-0.5, Math.min(0.5, ox));
    fy = bestDy + Math.max(-0.5, Math.min(0.5, oy));
    peak = Math.max(-1, Math.min(1, best));
  }

  return { dx: fx, dy: fy, ncc: peak, outOfBounds };
}

/**
 * Scan along the contour normal for the strongest gradient maximum.
 * Returns the offset (in px) from the predicted point and the normalised
 * magnitude of that peak. Search is a step lattice within ±edgeSearch.
 */
export function scanNormalEdge(
  frame: GrayFrame,
  point: PointXY,
  normal: Vec2,
  edgeSearch: number,
  step = 0.5,
): { edgeOffset: number; edge: number; peak: number } {
  const steps = Math.ceil(edgeSearch / step);
  let best = -Infinity;
  let bestOffset = 0;
  const values: { offset: number; g: number }[] = [];
  for (let k = -steps; k <= steps; k++) {
    const offset = k * step;
    const x = point.x + normal.x * offset;
    const y = point.y + normal.y * offset;
    const g = gradientMagnitudeAt(frame, x, y);
    values.push({ offset, g });
    if (g > best) {
      best = g;
      bestOffset = offset;
    }
  }
  if (best === -Infinity) best = 0;
  // Normalise by a robust local contrast: use the 75th percentile gradient.
  const sorted = values.map((val) => val.g).sort((a, b) => a - b);
  const q75 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))] || 0;
  const normalised = q75 > 1e-6 ? Math.max(0, Math.min(1, best / (q75 * 1.5))) : 0;

  // Parabolic sub-step refinement around the peak.
  let refined = bestOffset;
  const idx = values.findIndex((val) => val.offset === bestOffset);
  if (idx > 0 && idx < values.length - 1) {
    const a = values[idx - 1].g;
    const b = values[idx].g;
    const c = values[idx + 1].g;
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > EDGE_EPS) {
      refined = bestOffset + (0.5 * (a - c) * step) / denom;
    }
  }
  return { edgeOffset: refined, edge: normalised, peak: best };
}

/**
 * Weighted fusion of appearance (NCC) and edge evidence into an observability
 * score. NCC dominates; edge only confirms or mildly rescues.
 */
export function fuseConfidence(ncc: number, edge: number, edgeMin: number): number {
  const nccScore = clamp01((ncc - 0.2) / 0.7);
  const edgeScore = clamp01((edge - edgeMin) / (1 - edgeMin));
  return clamp01(0.8 * nccScore + 0.2 * edgeScore);
}

/** Dilate an 8-bit mask by `radius` pixels (Chebyshev), returning a new mask. */
export function dilateMask(width: number, height: number, mask: Uint8Array, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = 0;
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          if (mask[yy * width + xx]) {
            hit = 1;
            break;
          }
        }
      }
      out[y * width + x] = hit;
    }
  }
  return out;
}

/** Downsample by an integer factor with box averaging; used to speed up search. */
export function downsampleGray(frame: GrayFrame, factor: number): GrayFrame {
  if (factor <= 1) return { ...frame, data: frame.data.slice() };
  const width = Math.max(1, Math.floor(frame.width / factor));
  const height = Math.max(1, Math.floor(frame.height / factor));
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        const yy = y * factor + dy;
        if (yy >= frame.height) break;
        for (let dx = 0; dx < factor; dx++) {
          const xx = x * factor + dx;
          if (xx >= frame.width) break;
          sum += frame.data[yy * frame.width + xx];
          n++;
        }
      }
      data[y * width + x] = n ? Math.round(sum / n) : 0;
    }
  }
  return { width, height, data };
}

/**
 * Build a soft edge-strength map (0..255) from gradient magnitudes.
 * Useful for drawing "sampled evidence" in the UI.
 */
export function edgeMap(frame: GrayFrame): Uint8Array {
  const { width, height } = frame;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const g = gradientMagnitudeAt(frame, x, y);
      out[y * width + x] = Math.max(0, Math.min(255, Math.round(g * 4)));
    }
  }
  return out;
}

/**
 * Rough occlusion / visibility mask from local appearance: pixels whose
 * patch NCC against the previous frame falls below the threshold are flagged.
 * This is a *contour guidance* signal, not an alpha matte.
 */
export function visibilityMask(
  prev: GrayFrame,
  curr: GrayFrame,
  radius: number,
  nccThreshold: number,
): Uint8Array {
  const { width, height } = curr;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const n = nccAt(prev, curr, { x, y }, 0, 0, radius);
      mask[y * width + x] = n >= nccThreshold ? 255 : 0;
    }
  }
  return mask;
}

/** Exposed for tests. */
export const __internals = { clamp01 };

export interface PointObservability {
  /** Local luma standard deviation, normalised 0..1. Low texture cannot be tracked. */
  texture: number;
  /** Best normal-direction edge strength, normalised 0..1. */
  edge: number;
  /** Temporal NCC against a neighbouring frame, or 0 when unavailable. */
  ncc: number;
  visible: boolean;
  reason?: 'low-texture' | 'low-edge' | 'low-ncc' | 'patch-out-of-bounds';
}

/**
 * Assess whether a single control point has *actual sampled evidence* at this
 * frame. This is what the UI shows and what gates manual corrections: a point
 * with no texture, no edge and no temporal match is reported as not
 * observable, and edits there must not seed propagation.
 *
 * `neighbor` is normally the adjacent frame; it is optional so the function can
 * still report texture/edge when only one frame exists.
 */
export function assessPoint(
  frame: GrayFrame,
  point: PointXY,
  normal: Vec2,
  patchRadius: number,
  edgeSearch: number,
  neighbor?: GrayFrame | null,
): PointObservability {
  const px = Math.round(point.x);
  const py = Math.round(point.y);
  const margin = patchRadius + 1;
  const outOfBounds =
    px < margin || py < margin || px >= frame.width - margin || py >= frame.height - margin;

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let v = -patchRadius; v <= patchRadius; v++) {
    for (let u = -patchRadius; u <= patchRadius; u++) {
      const x = px + u;
      const y = py + v;
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
      const l = frame.data[y * frame.width + x];
      sum += l;
      sumSq += l * l;
      count++;
    }
  }
  const mean = count ? sum / count : 0;
  const variance = count ? Math.max(0, sumSq / count - mean * mean) : 0;
  const std = Math.sqrt(variance);
  const texture = clamp01(std / 28);

  const edge = scanNormalEdge(frame, point, normal, edgeSearch, 0.5).edge;
  const ncc = neighbor ? nccAt(neighbor, frame, point, 0, 0, patchRadius) : 0;

  let visible = true;
  let reason: PointObservability['reason'];
  if (outOfBounds) {
    visible = false;
    reason = 'patch-out-of-bounds';
  } else if (texture < 0.08 && edge < 0.2) {
    visible = false;
    reason = 'low-texture';
  } else if (neighbor && ncc < 0.3 && edge < 0.15) {
    visible = false;
    reason = 'low-ncc';
  }

  return { texture, edge, ncc, visible, reason };
}

/**
 * Reject matches whose displacement is a gross outlier against the robust
 * local displacement field. An occluder can carry the patch match away from
 * the object; its displacement will disagree with well-matched neighbours.
 * `scores` are per-point confidence, used to build the reference field.
 */
export function flagMotionOutliers(
  displacements: PointXY[],
  scores: number[],
  radius: number,
  maxDeviation: number,
): boolean[] {
  const n = displacements.length;
  const flags = new Array<boolean>(n).fill(false);
  if (n < 4) return flags;
  for (let i = 0; i < n; i++) {
    const refs: { x: number; y: number }[] = [];
    for (let k = 1; k <= radius; k++) {
      for (const dir of [-1, 1]) {
        const j = (i + dir * k + n) % n;
        if (scores[j] >= 0.45) refs.push(displacements[j]);
      }
    }
    if (refs.length < 2) continue;
    let mx = 0;
    let my = 0;
    let wsum = 0;
    for (const r of refs) {
      const w = 1;
      mx += r.x * w;
      my += r.y * w;
      wsum += w;
    }
    mx /= wsum;
    my /= wsum;
    const dev = Math.hypot(displacements[i].x - mx, displacements[i].y - my);
    if (scores[i] < 0.45 && dev > maxDeviation) flags[i] = true;
  }
  return flags;
}


/**
 * Sample a square appearance template centred at `point` from `frame`.
 * The template is stored mean-subtracted and unit-normalised so that matching
 * is a plain dot product, and so that sensor noise cannot shift the score.
 */
export function sampleTemplate(
  frame: GrayFrame,
  id: string,
  point: PointXY,
  radius: number,
  inward?: Vec2,
): PointTemplate {
  const size = radius * 2 + 1;
  const data = new Float32Array(size * size);
  // Sample from just inside the boundary when an inward direction is given.
  // A template centred *on* the edge mostly records the edge gradient, which an
  // occluder's own edge can mimic; sampling interior texture makes the
  // "is this still the object?" test far more discriminative.
  const ox = inward ? inward.x * 0.5 * radius : 0;
  const oy = inward ? inward.y * 0.5 * radius : 0;
  for (let v = -radius; v <= radius; v++) {
    for (let u = -radius; u <= radius; u++) {
      const x = point.x + ox + u;
      const y = point.y + oy + v;
      data[(v + radius) * size + (u + radius)] = bilinear(frame, x, y);
    }
  }
  return {
    id,
    radius,
    data,
    normalised: normalisePatch(data),
    x: point.x,
    y: point.y,
    offsetX: ox,
    offsetY: oy,
  };
}

function normalisePatch(data: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < data.length; i++) mean += data[i];
  mean /= data.length || 1;
  let norm = 0;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] - mean;
    norm += out[i] * out[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 1e-6) {
    for (let i = 0; i < out.length; i++) out[i] /= norm;
  }
  return out;
}

/**
 * NCC of a stored template against the current frame, sampled about `point`
 * with an optional rotation. Rotation matters because the template was taken
 * at a different object orientation.
 */
export function matchTemplateAt(
  frame: GrayFrame,
  template: PointTemplate,
  point: PointXY,
  angle = 0,
): number {
  const r = template.radius;
  const size = r * 2 + 1;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let sum = 0;
  let sumSq = 0;
  const values = new Float32Array(size * size);
  for (let v = -r; v <= r; v++) {
    for (let u = -r; u <= r; u++) {
      // Rotate the template sample offset into the current frame.
      const ru = u * c - v * s;
      const rv = u * s + v * c;
      const value = bilinear(
        frame,
        point.x + template.offsetX + ru,
        point.y + template.offsetY + rv,
      );
      values[(v + r) * size + (u + r)] = value;
      sum += value;
      sumSq += value * value;
    }
  }
  const mean = sum / values.length;
  const variance = Math.max(0, sumSq / values.length - mean * mean);
  const std = Math.sqrt(variance);
  if (std < 1e-6) return 0;
  let num = 0;
  for (let i = 0; i < values.length; i++) {
    num += (values[i] - mean) * template.normalised[i];
  }
  // template.normalised has unit L2 norm; divide by the current patch's L2 norm.
  return clamp01((num / (std * Math.sqrt(values.length)) + 1) * 0.5) * 2 - 1;
}

/**
 * Template agreement is the *honest* visibility test: frame-to-frame matching
 * can follow an occluder that happens to be static, while a template match
 * fails as soon as the object's own texture is no longer under the point.
 */
export function templateVisibility(
  frame: GrayFrame,
  template: PointTemplate,
  point: PointXY,
  angle: number,
  threshold: number,
): { score: number; visible: boolean } {
  const score = matchTemplateAt(frame, template, point, angle);
  return { score, visible: score >= threshold };
}
