import {
  Vec2,
  add,
  clamp,
  closestOnSegment,
  dist,
  lerp,
  mul,
  polygonSignedArea,
  sub,
} from './vec';

/**
 * Centripetal Catmull–Rom evaluation through a fixed list of control points.
 *
 * The parameterisation is defined solely by control-point order and identity:
 * segment i always spans control point i → i+1 and is sampled at a fixed
 * number of steps. Propagation never inserts, removes or reorders points, so a
 * point marked by the user on frame A keeps addressing the same curve location
 * on frame B.
 */

export const SAMPLES_PER_SEGMENT = 10;
const ALPHA = 0.5;
const EPS = 1e-9;

export interface DenseContour {
  points: Vec2[];
  /** Segment index each dense sample belongs to. */
  segmentIndex: Int32Array;
  /** Local parameter [0,1) inside that segment. */
  segmentT: Float32Array;
  closed: boolean;
}

function crPoint(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, u: number): Vec2 {
  const t0 = 0;
  let t1 = t0 + Math.pow(Math.max(dist(p0, p1), EPS), ALPHA);
  let t2 = t1 + Math.pow(Math.max(dist(p1, p2), EPS), ALPHA);
  let t3 = t2 + Math.pow(Math.max(dist(p2, p3), EPS), ALPHA);
  // Coincident control points would collapse the knots; nudge them apart.
  if (t1 <= t0 + EPS) t1 = t0 + EPS;
  if (t2 <= t1 + EPS) t2 = t1 + EPS;
  if (t3 <= t2 + EPS) t3 = t2 + EPS;
  const t = t1 + (t2 - t1) * u;

  const a1 = add(mul(p0, (t1 - t) / (t1 - t0)), mul(p1, (t - t0) / (t1 - t0)));
  const a2 = add(mul(p1, (t2 - t) / (t2 - t1)), mul(p2, (t - t1) / (t2 - t1)));
  const a3 = add(mul(p2, (t3 - t) / (t3 - t2)), mul(p3, (t - t2) / (t3 - t2)));

  const b1 = add(mul(a1, (t2 - t) / (t2 - t0)), mul(a2, (t - t0) / (t2 - t0)));
  const b2 = add(mul(a2, (t3 - t) / (t3 - t1)), mul(a3, (t - t1) / (t3 - t1)));

  return add(mul(b1, (t2 - t) / (t2 - t1)), mul(b2, (t - t1) / (t2 - t1)));
}

function neighbours(points: Vec2[], i: number, closed: boolean): [Vec2, Vec2, Vec2, Vec2] {
  const n = points.length;
  const at = (k: number): Vec2 => {
    if (closed) return points[((k % n) + n) % n];
    return points[clamp(k, 0, n - 1)];
  };
  return [at(i - 1), at(i), at(i + 1), at(i + 2)];
}

export function sampleContour(
  points: Vec2[],
  closed: boolean,
  samplesPerSegment = SAMPLES_PER_SEGMENT,
): DenseContour {
  const n = points.length;
  if (n === 0) {
    return { points: [], segmentIndex: new Int32Array(0), segmentT: new Float32Array(0), closed };
  }
  if (n === 1) {
    return {
      points: [{ ...points[0] }],
      segmentIndex: new Int32Array([0]),
      segmentT: new Float32Array([0]),
      closed,
    };
  }

  const segmentCount = closed ? n : n - 1;
  const total = segmentCount * samplesPerSegment + (closed ? 0 : 1);
  const out: Vec2[] = [];
  const segIndex = new Int32Array(total);
  const segT = new Float32Array(total);

  for (let seg = 0; seg < segmentCount; seg++) {
    const [p0, p1, p2, p3] = neighbours(points, seg, closed);
    for (let s = 0; s < samplesPerSegment; s++) {
      const u = s / samplesPerSegment;
      out.push(crPoint(p0, p1, p2, p3, u));
      segIndex[out.length - 1] = seg;
      segT[out.length - 1] = u;
    }
  }
  if (!closed) {
    out.push({ ...points[n - 1] });
    segIndex[out.length - 1] = segmentCount - 1;
    segT[out.length - 1] = 1;
  }
  return { points: out, segmentIndex: segIndex, segmentT: segT, closed };
}

/** Unit tangents at control points, derived from the spline neighbourhood. */
export function controlTangents(points: Vec2[], closed: boolean): Vec2[] {
  const n = points.length;
  return points.map((_, i) => {
    const prev = closed ? points[(i - 1 + n) % n] : points[Math.max(0, i - 1)];
    const next = closed ? points[(i + 1) % n] : points[Math.min(n - 1, i + 1)];
    const d = sub(next, prev);
    const l = Math.hypot(d.x, d.y);
    return l > EPS ? { x: d.x / l, y: d.y / l } : { x: 1, y: 0 };
  });
}

/**
 * Outward unit normals at control points. Orientation follows the signed area
 * of the control polygon so the normal points away from the enclosed region.
 */
export function controlNormals(points: Vec2[], closed: boolean): Vec2[] {
  const tangents = controlTangents(points, closed);
  const orientation = closed ? Math.sign(polygonSignedArea(points)) || 1 : 1;
  return tangents.map((t) => ({ x: orientation * t.y, y: -orientation * t.x }));
}

export function polylineLength(points: Vec2[], closed: boolean): number {
  let total = 0;
  const n = points.length;
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) total += dist(points[i], points[(i + 1) % n]);
  return total;
}

export function closestDistanceToPolyline(p: Vec2, poly: Vec2[], closed: boolean): number {
  if (poly.length === 0) return Infinity;
  if (poly.length === 1) return dist(p, poly[0]);
  let best = Infinity;
  const count = closed ? poly.length : poly.length - 1;
  for (let i = 0; i < count; i++) {
    const r = closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    if (r.d2 < best) best = r.d2;
  }
  return Math.sqrt(best);
}

/** Closest dense sample index and its distance. */
export function closestDenseSample(
  p: Vec2,
  dense: DenseContour,
): { index: number; distance: number; segmentIndex: number; segmentT: number } {
  let best = Infinity;
  let bestIndex = 0;
  for (let i = 0; i < dense.points.length; i++) {
    const d = dist(p, dense.points[i]);
    if (d < best) {
      best = d;
      bestIndex = i;
    }
  }
  return {
    index: bestIndex,
    distance: best,
    segmentIndex: dense.segmentIndex[bestIndex] ?? 0,
    segmentT: dense.segmentT[bestIndex] ?? 0,
  };
}

/**
 * Explicit arc-length redistribution. Only exposed as a deliberate user
 * action; automatic propagation never calls this because it would invalidate
 * control-point identity.
 */
export function resampleClosedByArcLength(points: Vec2[], count: number): Vec2[] {
  const n = points.length;
  if (n < 3 || count < 3) return points.map((p) => ({ ...p }));
  const dense = sampleContour(points, true, 24).points;
  const m = dense.length;
  const cumulative = new Float32Array(m + 1);
  for (let i = 0; i < m; i++) {
    cumulative[i + 1] = cumulative[i] + dist(dense[i], dense[(i + 1) % m]);
  }
  const total = cumulative[m];
  const out: Vec2[] = [];
  let cursor = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / count) * total;
    while (cursor < m - 1 && cumulative[cursor + 1] < target) cursor++;
    const segLen = cumulative[cursor + 1] - cumulative[cursor];
    const u = segLen > EPS ? (target - cumulative[cursor]) / segLen : 0;
    out.push(lerp(dense[cursor], dense[(cursor + 1) % m], u));
  }
  return out;
}
