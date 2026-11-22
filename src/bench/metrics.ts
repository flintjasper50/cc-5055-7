import type { Contour } from '../core/types';
import { sampleContour } from '../core/spline';
import { closestOnSegment, dist, type Vec2 } from '../core/vec';

/**
 * Evaluation metrics for contour tracking against known ground truth.
 *
 * We deliberately measure boundary distance and propagation drift, not pixel
 * accuracy of an alpha matte: this tool produces contour control data, so the
 * claim under test is "the curve follows the boundary", not "the matte is
 * perfect".
 */

export interface BoundaryError {
  mean: number;
  rms: number;
  p95: number;
  max: number;
  /** Undirected Hausdorff distance between the two dense polygons. */
  hausdorff: number;
}

function distancesToPolyline(points: Vec2[], poly: Vec2[], closed: boolean): number[] {
  const count = closed ? poly.length : poly.length - 1;
  return points.map((p) => {
    let best = Infinity;
    for (let i = 0; i < count; i++) {
      const r = closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
      if (r.d2 < best) best = r.d2;
    }
    return Math.sqrt(best);
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[idx];
}

/** Symmetric boundary error between a predicted contour and a dense truth polygon. */
export function boundaryError(
  predicted: Contour,
  truthPolygon: Vec2[],
  samplesPerSegment = 8,
): BoundaryError {
  const predDense = sampleContour(predicted.points, predicted.closed, samplesPerSegment).points;
  const truthDense = truthPolygon;
  if (predDense.length === 0 || truthDense.length === 0) {
    return { mean: Infinity, rms: Infinity, p95: Infinity, max: Infinity, hausdorff: Infinity };
  }
  const dPred = distancesToPolyline(predDense, truthDense, true);
  const dTruth = distancesToPolyline(truthDense, predDense, predicted.closed);
  const all = [...dPred, ...dTruth].sort((a, b) => a - b);
  const mean = all.reduce((s, x) => s + x, 0) / all.length;
  const rms = Math.sqrt(all.reduce((s, x) => s + x * x, 0) / all.length);
  return {
    mean,
    rms,
    p95: percentile(all, 0.95),
    max: all[all.length - 1],
    hausdorff: Math.max(...dPred, ...dTruth),
  };
}

/** Per-control-point distance to the nearest truth boundary sample. */
export function controlPointErrors(
  points: Vec2[],
  truthPolygon: Vec2[],
): { mean: number; max: number; perPoint: number[] } {
  const count = truthPolygon.length;
  const perPoint = points.map((p) => {
    let best = Infinity;
    for (let i = 0; i < count; i++) {
      const r = closestOnSegment(p, truthPolygon[i], truthPolygon[(i + 1) % count]);
      if (r.d2 < best) best = r.d2;
    }
    return Math.sqrt(best);
  });
  if (perPoint.length === 0) return { mean: 0, max: 0, perPoint };
  return {
    mean: perPoint.reduce((s, x) => s + x, 0) / perPoint.length,
    max: Math.max(...perPoint),
    perPoint,
  };
}

/**
 * Propagation drift: how far each frame's contour has slid relative to the
 * ground-truth motion at the same control-point index. This measures error
 * accumulation along the clip, independent of per-frame boundary error.
 */
export interface DriftReport {
  /** Mean per-point |predicted - truth| over all tracked frames. */
  meanDrift: number;
  /** Largest such error. */
  maxDrift: number;
  /** Per-frame mean index error, for a drift-over-time plot. */
  perFrame: { frame: number; mean: number; max: number }[];
  /** Linear growth rate of mean drift (px per frame). */
  growthPerFrame: number;
}

export function propagationDrift(
  frames: { frame: number; points: Vec2[] }[],
  truthByFrame: Map<number, Vec2[]>,
): DriftReport {
  const perFrame = frames.map(({ frame, points }) => {
    const truth = truthByFrame.get(frame) ?? [];
    const n = Math.min(points.length, truth.length);
    if (n === 0) return { frame, mean: 0, max: 0 };
    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i++) {
      const d = dist(points[i], truth[i]);
      sum += d;
      if (d > max) max = d;
    }
    return { frame, mean: sum / n, max };
  });
  if (perFrame.length === 0) return { meanDrift: 0, maxDrift: 0, perFrame, growthPerFrame: 0 };
  const meanDrift = perFrame.reduce((s, f) => s + f.mean, 0) / perFrame.length;
  const maxDrift = Math.max(...perFrame.map((f) => f.max));

  // Least-squares slope of mean drift vs frame index.
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  const n = perFrame.length;
  for (const f of perFrame) {
    sx += f.frame;
    sy += f.mean;
    sxx += f.frame * f.frame;
    sxy += f.frame * f.mean;
  }
  const denom = n * sxx - sx * sx;
  const growthPerFrame = Math.abs(denom) > 1e-9 ? (n * sxy - sx * sy) / denom : 0;
  return { meanDrift, maxDrift, perFrame, growthPerFrame };
}

/** 1.0 when every id appears exactly once and in the same cyclic order. */
export function identityStability(expectedIds: string[], observedIds: string[]): {
  stable: boolean;
  unique: boolean;
  sameOrder: boolean;
  count: boolean;
} {
  const unique = new Set(observedIds).size === observedIds.length;
  const count = observedIds.length === expectedIds.length;
  const sameOrder = count && observedIds.every((id, i) => id === expectedIds[i]);
  return { stable: unique && sameOrder && count, unique, sameOrder, count };
}
