import { matchTemplateAt, scanNormalEdge, searchPatch } from './evidence';
import { controlNormals } from './spline';
import type {
  Candidate,
  Contour,
  ControlPoint,
  GrayFrame,
  PointEvidence,
  PointTemplate,
  ResolvedPoint,
  SegmentDiagnostic,
  SegmentStatus,
  TrackingParams,
} from './types';
import { Vec2, dist, norm, sub, v } from './vec';

/**
 * Tracking core.
 *
 * One frame-to-frame step takes a contour (with stable control-point ids) and
 * returns the same ids, moved by image evidence. Shape regularisation only
 * engages for points whose appearance evidence is inadequate; the evidence
 * record says so explicitly. Points are never re-sampled, inserted or removed,
 * so identity is preserved across the whole clip.
 */

export interface MotionModel {
  /** Mean translation of trustworthy points in the previous step. */
  dx: number;
  dy: number;
  /** Mean scale about the contour centroid, clamped to [0.5, 2]. */
  scale: number;
  /** Mean rotation, used as an initial normal direction only. */
  angle: number;
  centroid: Vec2;
  trustedCount: number;
}

export const zeroMotion = (points: Vec2[]): MotionModel => {
  const centroid = centroidOf(points);
  return { dx: 0, dy: 0, scale: 1, angle: 0, centroid, trustedCount: 0 };
};

export function centroidOf(points: Vec2[]): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / points.length, y: sy / points.length };
}

export interface StepOptions {
  prev: GrayFrame;
  curr: GrayFrame;
  prevContour: Contour;
  params: TrackingParams;
  /** Ids whose positions in `prevContour` are trusted seeds for this step. */
  trustedIds: Set<string>;
  motion?: MotionModel;
  /** When seeded from a manual correction, hidden-side ids are inherited. */
  untrustedIds?: Set<string>;
  /**
   * Anchor appearance templates keyed by stable id. When provided, frame-to-
   * frame matches are verified against these templates so a static occluder
   * cannot masquerade as the object.
   */
  templates?: Map<string, PointTemplate>;
  /** NCC below this against the anchor template is reported as occluded. */
  templateThreshold?: number;
  /**
   * Ids that were reported occluded on the previous frame. With hysteresis a
   * point must clear `templateRecover` to become visible again — otherwise a
   * briefly-checkered occluder can flip a point between visible and hidden on
   * successive frames and feed drift back into the model.
   */
  occludedIds?: Set<string>;
  /** Score a previously-occluded point must reach to re-enter refinement. */
  templateRecover?: number;
  /**
   * Cumulative object rotation (radians) between the anchor frame and this
   * frame. Templates were sampled at the anchor and are rotated back by this
   * amount so rotation does not masquerade as occlusion.
   */
  templateRotation?: number;
}

export interface StepResult {
  points: ControlPoint[];
  evidence: PointEvidence[];
  motion: MotionModel;
  trustedCount: number;
}

/**
 * Fit a robust global similarity (translation + rotation + scale) between the
 * previous and current frame using patch matches at well-textured control
 * points. This is *not* the tracking result — it is the shape prior that keeps
 * control points from sliding tangentially along the contour.
 *
 * Anchor templates, when supplied, gate which points may vote. That is what
 * stops an occluder (which can match perfectly frame-to-frame) from dragging
 * the whole model: a patch whose anchor template no longer matches is treated
 * as not observing the object at all.
 */
export function estimateGlobalMotion(
  prev: GrayFrame,
  curr: GrayFrame,
  contour: Contour,
  params: TrackingParams,
  trustedIds: Set<string>,
  untrusted: Set<string>,
  previous?: MotionModel,
  templates?: Map<string, PointTemplate>,
  templateRotation = 0,
): {
  model: MotionModel;
  matches: Map<string, { dx: number; dy: number; ncc: number; templateNcc: number }>;
} {
  const usable = contour.points.filter((p) => trustedIds.has(p.id) && !untrusted.has(p.id));
  const matches = new Map<string, { dx: number; dy: number; ncc: number; templateNcc: number }>();
  if (usable.length < 3) {
    return { model: previous ?? zeroMotion(contour.points), matches };
  }

  const preferred = previous && previous.trustedCount > 0 ? v(previous.dx, previous.dy) : undefined;
  const offsets: { p: Vec2; dx: number; dy: number; ncc: number; templateNcc: number; id: string }[] = [];
  for (const p of usable) {
    const s = searchPatch(prev, curr, p, params.patchRadius, params.searchRadius, params.subpixel, preferred);
    const template = templates?.get(p.id);
    const templateNcc = template
      ? matchTemplateAt(curr, template, { x: p.x + s.dx, y: p.y + s.dy }, templateRotation)
      : 1;
    matches.set(p.id, { dx: s.dx, dy: s.dy, ncc: s.ncc, templateNcc });
    if (s.outOfBounds || s.ncc < params.nccThreshold) continue;
    if (template && templateNcc < 0.72) continue;
    offsets.push({ p, dx: s.dx, dy: s.dy, ncc: s.ncc, templateNcc, id: p.id });
  }
  if (offsets.length < 3) {
    return { model: previous ?? zeroMotion(contour.points), matches };
  }

  // Robust inlier selection around the median displacement. Template-gated
  // votes are already clean, but this still rejects the odd bad patch.
  const medX = medianBy(offsets.map((m) => m.dx));
  const medY = medianBy(offsets.map((m) => m.dy));
  const spread = Math.max(2, params.searchRadius * 0.7);
  let inliers = offsets.filter((m) => Math.hypot(m.dx - medX, m.dy - medY) <= spread);
  if (inliers.length < 3) inliers = offsets;

  let { a, b, tx, ty } = fitSimilarity(inliers);

  // Trimmed re-fit. A moving occluder can ride along a few control points and
  // pass both the NCC gate and the frame-to-frame template gate (its texture
  // correlates statistically with the object). Those votes bias the similarity
  // by several px/frame, which corrupts *every* point because most points only
  // refine along their normal. Points genuinely on the object fit the model to
  // sub-pixel accuracy, so we iterate the fit keeping only low-residual votes.
  for (let pass = 0; pass < 3; pass++) {
    const residuals = inliers.map((m) => {
      const q = applySimilarity(m.p, a, b, tx, ty);
      return { m, r: Math.hypot(q.x - (m.p.x + m.dx), q.y - (m.p.y + m.dy)) };
    });
    const sorted = residuals.map((x) => x.r).sort((x, y) => x - y);
    const mid = sorted.length >> 1;
    const mad = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
    const cutoff = Math.min(2.5, Math.max(1.0, mad * 2 + 0.5));
    const kept = residuals.filter((x) => x.r <= cutoff).map((x) => x.m);
    if (kept.length < 3 || kept.length === inliers.length) break;
    inliers = kept;
    ({ a, b, tx, ty } = fitSimilarity(inliers));
  }

  const cx = contour.points.reduce((s, p) => s + p.x, 0) / contour.points.length;
  const cy = contour.points.reduce((s, p) => s + p.y, 0) / contour.points.length;
  const refined = refineSimilarityOnNcc(prev, curr, inliers, params, { a, b, tx, ty }, { x: cx, y: cy });
  if (refined) ({ a, b, tx, ty } = refined);

  const scale = Math.max(0.5, Math.min(2, Math.hypot(a, b)));
  const angle = Math.max(-0.4, Math.min(0.4, Math.atan2(b, a)));
  const ca = scale * Math.cos(angle);
  const cb = scale * Math.sin(angle);

  const anchor = { x: cx, y: cy };
  const mapped = applySimilarity(anchor, ca, cb, tx, ty);
  return {
    model: {
      dx: mapped.x - anchor.x,
      dy: mapped.y - anchor.y,
      scale,
      angle,
      centroid: anchor,
      trustedCount: inliers.length,
    },
    matches,
  };
}

function fitSimilarity(inliers: { p: Vec2; dx: number; dy: number; ncc: number }[]): {
  a: number;
  b: number;
  tx: number;
  ty: number;
} {
  let cpx = 0;
  let cpy = 0;
  let cqx = 0;
  let cqy = 0;
  let wsum = 0;
  for (const m of inliers) {
    const w = Math.max(0.05, m.ncc);
    cpx += m.p.x * w;
    cpy += m.p.y * w;
    cqx += (m.p.x + m.dx) * w;
    cqy += (m.p.y + m.dy) * w;
    wsum += w;
  }
  cpx /= wsum;
  cpy /= wsum;
  cqx /= wsum;
  cqy /= wsum;
  let numA = 0;
  let numB = 0;
  let den = 0;
  for (const m of inliers) {
    const w = Math.max(0.05, m.ncc);
    const px = m.p.x - cpx;
    const py = m.p.y - cpy;
    const qx = m.p.x + m.dx - cqx;
    const qy = m.p.y + m.dy - cqy;
    numA += w * (px * qx + py * qy);
    numB += w * (px * qy - py * qx);
    den += w * (px * px + py * py);
  }
  let a = den > 1e-6 ? numA / den : 1;
  let b = den > 1e-6 ? numB / den : 0;
  const scale = Math.max(0.5, Math.min(2, Math.hypot(a, b)));
  const angle = Math.max(-0.4, Math.min(0.4, Math.atan2(b, a)));
  a = scale * Math.cos(angle);
  b = scale * Math.sin(angle);
  return { a, b, tx: cqx - (a * cpx - b * cpy), ty: cqy - (b * cpx + a * cpy) };
}

/**
 * Joint Gauss–Newton refinement of the similarity over summed patch NCC.
 * The NCC is treated as a smooth score; finite-difference derivatives are cheap
 * because the candidate set is small. Returns null when the solve is degenerate.
 */
function refineSimilarityOnNcc(
  prev: GrayFrame,
  curr: GrayFrame,
  inliers: { p: Vec2; dx: number; dy: number; ncc: number }[],
  params: TrackingParams,
  init: { a: number; b: number; tx: number; ty: number },
  centroid: Vec2,
): { a: number; b: number; tx: number; ty: number } | null {
  let theta = Math.atan2(init.b, init.a);
  let logScale = Math.log(Math.max(0.5, Math.min(2, Math.hypot(init.a, init.b))));
  const initCentroidQ = applySimilarity(centroid, init.a, init.b, init.tx, init.ty);
  let txc = initCentroidQ.x - centroid.x;
  let tyc = initCentroidQ.y - centroid.y;

  const score = (th: number, ls: number, tx: number, ty: number): number => {
    const sc = Math.exp(ls);
    const c = Math.cos(th);
    const s = Math.sin(th);
    let total = 0;
    for (const m of inliers) {
      const rx = m.p.x - centroid.x;
      const ry = m.p.y - centroid.y;
      const qx = centroid.x + tx + sc * (c * rx - s * ry);
      const qy = centroid.y + ty + sc * (s * rx + c * ry);
      total += Math.max(0.05, m.ncc) * smoothNcc(prev, curr, m.p, qx, qy, params.patchRadius);
    }
    return total;
  };

  const h = 1e-3;
  const MAX_ITER = 20;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const f0 = score(theta, logScale, txc, tyc);
    const gt = (score(theta + h, logScale, txc, tyc) - score(theta - h, logScale, txc, tyc)) / (2 * h);
    const gs = (score(theta, logScale + h, txc, tyc) - score(theta, logScale - h, txc, tyc)) / (2 * h);
    const gx = (score(theta, logScale, txc + h, tyc) - score(theta, logScale, txc - h, tyc)) / (2 * h);
    const gy = (score(theta, logScale, txc, tyc + h) - score(theta, logScale, txc, tyc - h)) / (2 * h);
    const ht = (score(theta + h, logScale, txc, tyc) - 2 * f0 + score(theta - h, logScale, txc, tyc)) / (h * h);
    const hs = (score(theta, logScale + h, txc, tyc) - 2 * f0 + score(theta, logScale - h, txc, tyc)) / (h * h);
    const hx = (score(theta, logScale, txc + h, tyc) - 2 * f0 + score(theta, logScale, txc - h, tyc)) / (h * h);
    const hy = (score(theta, logScale, txc, tyc + h) - 2 * f0 + score(theta, logScale, txc, tyc - h)) / (h * h);
    const step = (grad: number, curv: number, cap: number): number => {
      if (curv < -1e-4) return clampValue(-grad / curv, -cap, cap);
      return clampValue(Math.sign(grad) * cap * 0.25, -cap, cap);
    };
    const dTheta = step(gt, ht, 0.01);
    const dScale = step(gs, hs, 0.01);
    const dxc = step(gx, hx, 0.5);
    const dyc = step(gy, hy, 0.5);
    theta += dTheta;
    logScale += dScale;
    txc += dxc;
    tyc += dyc;
    if (Math.abs(dTheta) < 1e-5 && Math.abs(dScale) < 1e-5 && Math.abs(dxc) < 1e-3 && Math.abs(dyc) < 1e-3) {
      break;
    }
  }

  if (!Number.isFinite(theta) || !Number.isFinite(logScale) || !Number.isFinite(txc) || !Number.isFinite(tyc)) {
    return null;
  }
  const sc = Math.exp(logScale);
  const a = sc * Math.cos(theta);
  const b = sc * Math.sin(theta);
  const mappedC = applySimilarity(centroid, a, b, 0, 0);
  return {
    a,
    b,
    tx: centroid.x + txc - mappedC.x,
    ty: centroid.y + tyc - mappedC.y,
  };
}

/** NCC of the previous patch centred at `p` against a patch centred at q in curr. */
function smoothNcc(
  prev: GrayFrame,
  curr: GrayFrame,
  p: Vec2,
  qx: number,
  qy: number,
  radius: number,
): number {
  const size = radius * 2 + 1;
  const count = size * size;
  const px = Math.round(p.x);
  const py = Math.round(p.y);
  let sumA = 0;
  let sumB = 0;
  for (let vv = -radius; vv <= radius; vv++) {
    for (let uu = -radius; uu <= radius; uu++) {
      const ax = px + uu;
      const ay = py + vv;
      if (ax < 0 || ay < 0 || ax >= prev.width || ay >= prev.height) continue;
      sumA += prev.data[ay * prev.width + ax];
      const bx = qx + uu;
      const by = qy + vv;
      sumB += bilinearSample(curr, bx, by);
    }
  }
  const meanA = sumA / count;
  const meanB = sumB / count;
  let num = 0;
  let va = 0;
  let vb = 0;
  for (let vv = -radius; vv <= radius; vv++) {
    for (let uu = -radius; uu <= radius; uu++) {
      const ax = px + uu;
      const ay = py + vv;
      if (ax < 0 || ay < 0 || ax >= prev.width || ay >= prev.height) continue;
      const da = prev.data[ay * prev.width + ax] - meanA;
      const db = bilinearSample(curr, qx + uu, qy + vv) - meanB;
      num += da * db;
      va += da * da;
      vb += db * db;
    }
  }
  const den = Math.sqrt(va * vb);
  return den < 1e-6 ? 0 : num / den;
}

function bilinearSample(frame: GrayFrame, x: number, y: number): number {
  const { width, height, data } = frame;
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  return (
    data[y0 * width + x0] * (1 - fx) * (1 - fy) +
    data[y0 * width + x1] * fx * (1 - fy) +
    data[y1 * width + x0] * (1 - fx) * fy +
    data[y1 * width + x1] * fx * fy
  );
}

function medianBy(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) * 0.5;
}

function applySimilarity(p: Vec2, a: number, b: number, tx: number, ty: number): Vec2 {
  return { x: a * p.x - b * p.y + tx, y: b * p.x + a * p.y + ty };
}

/** Offsets that convert previous-frame coordinates to current-frame predictions. */
function predict(point: Vec2, motion: MotionModel): Vec2 {
  const rel = sub(point, motion.centroid);
  const c = Math.cos(motion.angle);
  const s = Math.sin(motion.angle);
  return v(
    motion.centroid.x + motion.dx + (rel.x * c - rel.y * s) * motion.scale,
    motion.centroid.y + motion.dy + (rel.x * s + rel.y * c) * motion.scale,
  );
}

/**
 * Update the motion model from the previous step's trusted point displacements.
 * Robust (median) so a handful of bad matches cannot drive the whole rigid prior.
 */
export function updateMotion(
  motion: MotionModel,
  prevPoints: ControlPoint[],
  newPoints: ControlPoint[],
  evidence: PointEvidence[],
): MotionModel {
  const displacements: { dx: number; dy: number; weight: number }[] = [];
  const prevById = new Map(prevPoints.map((p) => [p.id, p]));
  for (let i = 0; i < newPoints.length; i++) {
    const e = evidence[i];
    if (!e || !e.visible) continue;
    const before = prevById.get(newPoints[i].id);
    if (!before) continue;
    displacements.push({
      dx: newPoints[i].x - before.x,
      dy: newPoints[i].y - before.y,
      weight: e.confidence,
    });
  }
  if (displacements.length === 0) return { ...motion, trustedCount: 0 };

  const dx = medianBy(displacements.map((d) => d.dx));
  const dy = medianBy(displacements.map((d) => d.dy));

  const prevCentroid = centroidOf(prevPoints);
  const newCentroid = centroidOf(newPoints);
  let num = 0;
  let den = 0;
  let angleNum = 0;
  let totalW = 0;
  for (let i = 0; i < newPoints.length; i++) {
    const e = evidence[i];
    if (!e || !e.visible) continue;
    const before = prevById.get(newPoints[i].id);
    if (!before) continue;
    const pa = sub(before, prevCentroid);
    const pb = sub(newPoints[i], newCentroid);
    const la = Math.hypot(pa.x, pa.y);
    const lb = Math.hypot(pb.x, pb.y);
    if (la < 2 || lb < 1) continue;
    const w = e.confidence;
    num += la * lb * w;
    den += la * la * w;
    angleNum += Math.atan2(pa.x * pb.y - pa.y * pb.x, pa.x * pb.x + pa.y * pb.y) * w;
    totalW += w;
  }
  const scale = den > 1e-6 ? Math.max(0.5, Math.min(2, num / den)) : 1;
  const angle = totalW > 0 ? Math.max(-0.35, Math.min(0.35, angleNum / totalW)) : 0;

  return { dx, dy, scale, angle, centroid: newCentroid, trustedCount: displacements.length };
}

/**
 * One propagation step.
 *
 * Pipeline, in order:
 *   1. Estimate a robust global similarity from template-gated patch matches.
 *   2. Predict every control point with that similarity. This is the shape
 *      constraint: points move as a rigid-ish shape, so no control point can
 *      slide tangentially along the contour.
 *   3. Verify each prediction against the anchor template *at the predicted
 *      position*. A point failing this is genuinely unobserved this frame
 *      (occluder in the way, no texture) — it stays on the prediction and is
 *      reported invisible, not snapped onto a tempting edge.
 *   4. For points that pass, refine along the contour normal only, combining
 *      the normal component of the motion match with an edge scan. The
 *      tangential component is discarded by construction.
 */
export function trackStep(opts: StepOptions): StepResult {
  const { prev, curr, prevContour, params, trustedIds } = opts;
  const untrusted = opts.untrustedIds ?? new Set<string>();
  const normals = controlNormals(prevContour.points, prevContour.closed);
  const templateThreshold = opts.templateThreshold ?? 0.5;

  // The accumulated object rotation since the anchor is supplied by the caller
  // through the motion model angle; templates are sampled at the anchor and
  // must be rotated back by that amount to compare fairly.
  const global = estimateGlobalMotion(
    prev,
    curr,
    prevContour,
    params,
    trustedIds,
    untrusted,
    opts.motion,
    opts.templates,
    opts.templateRotation ?? 0,
  );
  const motion = global.model;

  const points: ControlPoint[] = new Array(prevContour.points.length);
  const evidence: PointEvidence[] = new Array(prevContour.points.length);
  const predictedPositions: Vec2[] = new Array(prevContour.points.length);

  for (let i = 0; i < prevContour.points.length; i++) {
    const point = prevContour.points[i];
    const normal = normals[i] ?? v(1, 0);
    const seeded = trustedIds.has(point.id) && !untrusted.has(point.id);

    if (!seeded) {
      predictedPositions[i] = point;
      points[i] = { ...point };
      evidence[i] = deadEvidence(point.id, normal, params, 'untrusted-seed');
      continue;
    }

    const predicted = predict(point, motion);
    predictedPositions[i] = predicted;
    const match = global.matches.get(point.id);
    const template = opts.templates?.get(point.id);

    // Verify the object's own texture is present at the prediction.
    const templateNcc = template
      ? matchTemplateAt(curr, template, predicted, opts.templateRotation ?? 0)
      : 1;
    const wasOccluded = opts.occludedIds?.has(point.id) ?? false;
    const effectiveThreshold = wasOccluded
      ? Math.max(templateThreshold, opts.templateRecover ?? 0.72)
      : templateThreshold;
    const templateOk = templateNcc >= effectiveThreshold;

    const frameToFrameNcc = match?.ncc ?? 0;

    if (!templateOk) {
      // Genuinely unobserved. Hold the predicted position: smooth, honest, and
      // never snapped onto the occluder's edge.
      points[i] = { id: point.id, x: predicted.x, y: predicted.y };
      evidence[i] = {
        id: point.id,
        ncc: frameToFrameNcc,
        templateNcc,
        edge: 0,
        confidence: Math.min(0.25, fuseConfidenceMath(frameToFrameNcc, 0, params.edgeMin) * 0.4),
        visible: false,
        regularized: true,
        motion: v(predicted.x - point.x, predicted.y - point.y),
        searchOffset: match ? v(match.dx, match.dy) : v(0, 0),
        normal,
        edgeOffset: 0,
        patchRadius: params.patchRadius,
        searchRadius: params.searchRadius,
        source: 'regularized',
        hiddenReason: 'template-mismatch',
      };
      continue;
    }

    // Normal-direction refinement. Prefer the normal component of the patch
    // match; fall back to the strongest edge when appearance is weak.
    const relNormal = match
      ? (point.x + match.dx - predicted.x) * normal.x + (point.y + match.dy - predicted.y) * normal.y
      : NaN;
    const edgeScan = scanNormalEdge(curr, predicted, normal, params.edgeSearch, 0.5);

    let normalShift = 0;
    let source: PointEvidence['source'] = 'image';
    if (match && frameToFrameNcc >= params.nccThreshold && Number.isFinite(relNormal)) {
      normalShift = clampValue(relNormal, -params.edgeSearch, params.edgeSearch);
      // Edge confirmation: nudge toward the edge peak when it agrees with the
      // appearance estimate, so we do not fight the two cues.
      if (edgeScan.edge >= params.edgeMin && Math.sign(edgeScan.edgeOffset) === Math.sign(normalShift)) {
        normalShift = normalShift * (1 - params.edgeSnap) + edgeScan.edgeOffset * params.edgeSnap;
      }
    } else if (edgeScan.edge >= params.edgeMin) {
      normalShift = edgeScan.edgeOffset * params.edgeSnap;
      source = 'image';
    } else {
      source = 'similarity';
    }

    const refined = v(predicted.x + normal.x * normalShift, predicted.y + normal.y * normalShift);
    // When an anchor template is available it is the authoritative appearance
    // test: frame-to-frame NCC alone can be satisfied by an occluder. Scale the
    // fused confidence by the template agreement so a "visible" point that is
    // really the occluder cannot out-vote the opposite propagation direction.
    const fused = fuseConfidenceMath(frameToFrameNcc, edgeScan.edge, params.edgeMin);
    const confidence = template ? fused * (0.35 + 0.65 * Math.max(0, templateNcc)) : fused;
    const visible =
      source === 'image' &&
      frameToFrameNcc >= params.nccThreshold * 0.6 &&
      (!template || templateNcc >= templateThreshold);

    points[i] = { id: point.id, x: refined.x, y: refined.y };
    evidence[i] = {
      id: point.id,
      ncc: frameToFrameNcc,
      templateNcc,
      edge: edgeScan.edge,
      confidence: Math.min(1, confidence),
      visible,
      regularized: !visible,
      motion: v(refined.x - point.x, refined.y - point.y),
      searchOffset: match ? v(match.dx, match.dy) : v(0, 0),
      normal,
      edgeOffset: normalShift,
      patchRadius: params.patchRadius,
      searchRadius: params.searchRadius,
      source: visible ? source : 'similarity',
      hiddenReason: visible ? undefined : 'low-ncc',
    };
  }

  // Span consistency. A textured occluder can produce a locally plausible
  // template score for a single control point, but the object is a *contour*:
  // if a stretch of control points is enclosed by confidently-visible points
  // yet scores materially lower, that stretch is occluded. This topological
  // check is what keeps a whole occluded segment from drifting with the bar.
  resetOccludedToPrediction(evidence, points, predictedPositions, opts.occludedIds, templateThreshold);

  const updatedMotion = updateMotion(motion, prevContour.points, points, evidence);
  return { points, evidence, motion: updatedMotion, trustedCount: motion.trustedCount };
}

/**
 * Detect occluded runs and snap them back to the global prediction.
 *
 * A textured occluder can produce a locally plausible template score for an
 * individual control point, so a purely per-point threshold is not enough:
 * the object is a contour, and a *run* of points that is bounded by
 * confidently-visible neighbours but scores materially lower is occluded as a
 * span. Points detected this way (or flagged by the local template test) are
 * reset to the similarity prediction, so the whole span coasts rigidly instead
 * of following the occluder's rim. This is what keeps an occluded segment both
 * visually honest (drawn as inferred) and stable.
 */
function resetOccludedToPrediction(
  evidence: PointEvidence[],
  points: ControlPoint[],
  predictions: Vec2[],
  previousOccluded: Set<string> | undefined,
  templateThreshold: number,
): void {
  const n = evidence.length;
  if (n < 4) return;
  const confident = (e: PointEvidence): boolean => e.templateNcc >= templateThreshold && e.ncc >= 0.55;
  const suspect = (e: PointEvidence): boolean =>
    e.templateNcc < templateThreshold ||
    e.ncc < 0.5 ||
    (previousOccluded?.has(e.id) ?? false);

  const occluded = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) if (!confident(evidence[i]) && suspect(evidence[i])) occluded[i] = true;

  // Expand a suspected run only when it is bounded by confident points on both
  // sides, so isolated weak points inside an otherwise solid contour cannot
  // carve out a hole.
  const maxRun = Math.floor(n * 0.5);
  for (let i = 0; i < n; i++) {
    if (confident(evidence[i])) continue;
    let j = i;
    while (j < n && !confident(evidence[j])) j++;
    const runLen = j - i;
    let before = -1;
    for (let k = 1; k <= n; k++) {
      const idx = ((i - k) % n + n) % n;
      if (confident(evidence[idx])) {
        before = idx;
        break;
      }
    }
    const after = j < n ? j : -1;
    if (before >= 0 && after >= 0 && runLen <= maxRun) {
      for (let k = i; k < j; k++) occluded[k] = true;
    }
    i = j;
  }

  for (let i = 0; i < n; i++) {
    if (!occluded[i]) continue;
    const e = evidence[i];
    if (e.visible && e.templateNcc >= templateThreshold && !(previousOccluded?.has(e.id) ?? false)) {
      // Leave it: it is genuinely observed.
      continue;
    }
    e.visible = false;
    e.regularized = true;
    e.source = 'regularized';
    e.confidence = Math.min(e.confidence, 0.3);
    if (!e.hiddenReason) e.hiddenReason = 'template-mismatch';
    const pred = predictions[i];
    if (pred) {
      const before = points[i];
      points[i] = { id: before.id, x: pred.x, y: pred.y };
      e.motion = { x: pred.x - before.x, y: pred.y - before.y };
      e.edgeOffset = 0;
    }
  }
}

function clampValue(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function deadEvidence(
  id: string,
  normal: Vec2,
  params: TrackingParams,
  reason: PointEvidence['hiddenReason'],
): PointEvidence {
  return {
    id,
    ncc: 0,
    templateNcc: 0,
    edge: 0,
    confidence: 0,
    visible: false,
    regularized: false,
    motion: v(0, 0),
    searchOffset: v(0, 0),
    normal,
    edgeOffset: 0,
    patchRadius: params.patchRadius,
    searchRadius: params.searchRadius,
    source: 'regularized',
    hiddenReason: reason,
  };
}

export function fuseConfidenceMath(ncc: number, edge: number, edgeMin: number): number {
  const nccScore = Math.max(0, Math.min(1, (ncc - 0.2) / 0.7));
  const edgeScore = Math.max(0, Math.min(1, (edge - edgeMin) / Math.max(1e-6, 1 - edgeMin)));
  return Math.max(0, Math.min(1, 0.8 * nccScore + 0.2 * edgeScore));
}

/**
 * Merge two independently-propelled candidates for the same frame.
 *
 * - By-id matching uses stable ids, so a point observed only from the forward
 *   side stays on the forward candidate while its occluded counterpart comes
 *   from the backward side.
 * - If the two candidates disagree beyond `conflictDistance` we keep *both*
 *   rather than averaging: `resolved` keeps the per-point winner and
 *   `segments` marks the contested span. The full candidates are returned so
 *   the UI can draw both and the user can step in.
 */
export function mergeCandidates(
  forward: Candidate | undefined,
  backward: Candidate | undefined,
  params: TrackingParams,
): {
  resolved: ResolvedPoint[];
  segments: SegmentDiagnostic[];
  conflict: boolean;
  conflictCount: number;
  occludedCount: number;
  regularizedCount: number;
  blend: 'none' | 'by-id';
  identityMismatch: boolean;
} {
  const fwd = forward?.points ?? [];
  const bwd = backward?.points ?? [];
  const fwdEv = forward?.evidence ?? [];
  const bwdEv = backward?.evidence ?? [];
  const identityMismatch = Boolean(
    forward &&
      backward &&
      (forward.ids.length !== backward.ids.length ||
        forward.ids.some((id, i) => id !== backward.ids[i])),
  );

  const resolved: ResolvedPoint[] = [];
  let conflictCount = 0;
  let occludedCount = 0;
  let regularizedCount = 0;

  if (fwd.length === 0 && bwd.length === 0) {
    return {
      resolved,
      segments: [],
      conflict: false,
      conflictCount: 0,
      occludedCount: 0,
      regularizedCount: 0,
      blend: 'none',
      identityMismatch: false,
    };
  }

  const bwdById = new Map<string, { point: ControlPoint; ev: PointEvidence; i: number }>();
  bwd.forEach((p, i) => bwdById.set(p.id, { point: p, ev: bwdEv[i], i }));

  const fwdById = new Map<string, { point: ControlPoint; ev: PointEvidence; i: number }>();
  fwd.forEach((p, i) => fwdById.set(p.id, { point: p, ev: fwdEv[i], i }));

  // Walk forward order; add backward-only ids at their original slot.
  const order: string[] = [];
  const seen = new Set<string>();
  for (const p of fwd) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      order.push(p.id);
    }
  }
  for (const p of bwd) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      order.push(p.id);
    }
  }

  let conflictFlag = false;
  for (const id of order) {
    const f = fwdById.get(id);
    const b = bwdById.get(id);
    let chosen: { point: ControlPoint; ev: PointEvidence; conflict: boolean; source: ResolvedPoint['source'] };
    if (f && b) {
      const d = dist(f.point, b.point);
      const conflict = d > params.conflictDistance;
      // Pick the more confident side; on a tie prefer the forward pass.
      const fScore = f.ev?.confidence ?? 0;
      const bScore = b.ev?.confidence ?? 0;
      const useForward = fScore >= bScore;
      const point = useForward ? f.point : b.point;
      const ev = useForward ? f.ev : b.ev;
      chosen = {
        point,
        ev,
        conflict,
        source: conflict ? 'blend' : ev?.source ?? 'image',
      };
      if (conflict) {
        conflictFlag = true;
        conflictCount++;
      }
    } else if (f) {
      chosen = { point: f.point, ev: f.ev, conflict: false, source: f.ev?.source ?? 'image' };
    } else {
      chosen = { point: b!.point, ev: b!.ev, conflict: false, source: b!.ev?.source ?? 'image' };
    }

    const ev = chosen.ev;
    const visible = ev?.visible ?? false;
    if (!visible) occludedCount++;
    if (ev?.regularized) regularizedCount++;

    // When both sides see the point and they agree, the confidence should
    // reflect the weaker side — agreement is evidence, but only as good as the
    // more doubtful observation.
    let confidence = ev?.confidence ?? 0;
    if (f && b) {
      const d = dist(f.point, b.point);
      const agreement = Math.max(0, 1 - d / Math.max(1, params.searchRadius));
      confidence = confidence * (0.5 + 0.5 * agreement);
    }

    resolved.push({
      id,
      x: chosen.point.x,
      y: chosen.point.y,
      visible,
      regularized: ev?.regularized ?? false,
      confidence,
      ncc: ev?.ncc ?? 0,
      edge: ev?.edge ?? 0,
      conflict: chosen.conflict,
      source: chosen.source,
      propagationMode: ev?.propagationMode ?? 'joint',
      locallySelected: ev?.locallySelected ?? false,
    });
  }

  const segments = classifySegments(resolved, fwdById, bwdById, params);
  return {
    resolved,
    segments,
    conflict: conflictFlag,
    conflictCount,
    occludedCount,
    regularizedCount,
    blend: fwd.length > 0 && bwd.length > 0 ? 'by-id' : 'none',
    identityMismatch,
  };
}

function classifySegments(
  resolved: ResolvedPoint[],
  fwdById: Map<string, { point: ControlPoint; ev: PointEvidence; i: number }>,
  bwdById: Map<string, { point: ControlPoint; ev: PointEvidence; i: number }>,
  params: TrackingParams,
): SegmentDiagnostic[] {
  const n = resolved.length;
  const out: SegmentDiagnostic[] = [];
  for (let i = 0; i < n; i++) {
    const a = resolved[i];
    const b = resolved[(i + 1) % n];
    const reasons: string[] = [];
    let status: SegmentStatus = 'ok';

    const aF = fwdById.get(a.id);
    const bF = fwdById.get(b.id);
    const aB = bwdById.get(a.id);
    const bB = bwdById.get(b.id);

    const conflict =
      (aF && aB && dist(aF.point, aB.point) > params.conflictDistance) ||
      (bF && bB && dist(bF.point, bB.point) > params.conflictDistance);
    if (conflict) {
      status = 'conflict';
      reasons.push('forward/backward disagreement');
    }

    const anyInvisible = !a.visible || !b.visible;
    const anyRegularized = a.regularized || b.regularized;
    const lowConfidence = a.confidence < 0.3 || b.confidence < 0.3;

    if (status === 'ok') {
      if (anyInvisible) {
        status = 'occluded';
        reasons.push('invisible control point');
      } else if (anyRegularized) {
        status = 'regularized';
        reasons.push('shape regularisation used');
      } else if (lowConfidence) {
        status = 'weak';
        reasons.push('low confidence');
      }
    } else {
      if (anyInvisible) reasons.push('invisible control point');
      if (anyRegularized) reasons.push('shape regularisation used');
    }

    if (fwdById.size === 0 || bwdById.size === 0) {
      if (status === 'ok' && n > 0) {
        status = 'unmerged';
        reasons.push('one-directional propagation only');
      }
    }

    out.push({ index: i, fromId: a.id, toId: b.id, status, reasons });
  }
  return out;
}

/** Bundle a tracked frame as a candidate for the merge step. */
export function makeCandidate(
  direction: 'forward' | 'backward',
  fromFrame: number,
  points: ControlPoint[],
  evidence: PointEvidence[],
): Candidate {
  const meanConfidence =
    evidence.length > 0 ? evidence.reduce((s, e) => s + e.confidence, 0) / evidence.length : 0;
  return {
    direction,
    fromFrame,
    points,
    evidence,
    ids: points.map((p) => p.id),
    meanConfidence,
  };
}

/** Apply an affine offset to a contour while preserving stable ids. */
export function translateContour(contour: Contour, dx: number, dy: number): Contour {
  return {
    closed: contour.closed,
    points: contour.points.map((p) => ({ id: p.id, x: p.x + dx, y: p.y + dy })),
  };
}

/** Scale a contour about its centroid while preserving stable ids. */
export function scaleContour(contour: Contour, s: number): Contour {
  const c = centroidOf(contour.points);
  return {
    closed: contour.closed,
    points: contour.points.map((p) => ({ id: p.id, x: c.x + (p.x - c.x) * s, y: c.y + (p.y - c.y) * s })),
  };
}

export function pointMotionDirection(from: Vec2, to: Vec2): Vec2 {
  return norm(sub(to, from));
}
