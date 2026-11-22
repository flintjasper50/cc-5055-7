import { polylineLength, sampleContour } from './spline';
import type { Contour, ResolvedPoint } from './types';
import type { Vec2 } from './vec';

/**
 * Editing-burden metrics.
 *
 * When a shot is reopened, the editor only has to redraw the parts of the
 * propagated contour that are not already within a working tolerance of the
 * truth. We express that burden two ways, both recomputed from stored contour
 * data rather than estimated:
 *
 * - `changedPoints`: control points farther than `pointTolerance` px from the
 *   truth boundary (the points that must actually be moved);
 * - `redrawLength` / `redrawFraction`: arc length, measured on the evaluated
 *   spline, of the runs whose samples exceed `sampleTolerance`, i.e. how much
 *   curve has to be redrawn rather than how many control points exist.
 */

export interface RedrawReport {
  /** Control points needing a manual move. */
  changedPoints: number;
  /** Total control points considered. */
  totalPoints: number;
  /** Arc length (px) of the spline samples outside the sample tolerance. */
  redrawLength: number;
  /** Full evaluated contour length (px). */
  contourLength: number;
  /** redrawLength / contourLength. */
  redrawFraction: number;
  /** Per-control-point distance to the truth boundary (same order as input). */
  perPointDistance: number[];
}

function distanceToPolyline(p: Vec2, poly: Vec2[]): number {
  let best = Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 1e-12 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = a.x + dx * t;
    const qy = a.y + dy * t;
    const d = (p.x - qx) ** 2 + (p.y - qy) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

export function redrawBurden(
  contour: Contour,
  truthPolygon: Vec2[],
  pointTolerance = 2,
  sampleTolerance = 1.5,
  samplesPerSegment = 12,
): RedrawReport {
  const perPointDistance = contour.points.map((p) => distanceToPolyline(p, truthPolygon));
  const changedPoints = perPointDistance.filter((d) => d > pointTolerance).length;

  const dense = sampleContour(contour.points, contour.closed, samplesPerSegment);
  const contourLength = polylineLength(dense.points, contour.closed);

  // Walk the dense samples; a sample is "redrawn" when it sits beyond the
  // sample tolerance. Its share of the arc length is the segment to the next
  // sample, so redraw length is measured on the real evaluated curve.
  let redrawLength = 0;
  for (let i = 0; i < dense.points.length; i++) {
    const a = dense.points[i];
    const b = dense.points[(i + 1) % dense.points.length];
    const mid = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
    if (distanceToPolyline(mid, truthPolygon) > sampleTolerance) {
      redrawLength += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }

  return {
    changedPoints,
    totalPoints: contour.points.length,
    redrawLength,
    contourLength,
    redrawFraction: contourLength > 1e-9 ? redrawLength / contourLength : 0,
    perPointDistance,
  };
}

/** Convenience wrapper for a stored automatic frame's resolved points. */
export function redrawBurdenFromResolved(
  resolved: ResolvedPoint[],
  closed: boolean,
  truthPolygon: Vec2[],
  pointTolerance = 2,
  sampleTolerance = 1.5,
): RedrawReport {
  const contour: Contour = {
    closed,
    points: resolved.map((p) => ({ id: p.id, x: p.x, y: p.y })),
  };
  return redrawBurden(contour, truthPolygon, pointTolerance, sampleTolerance);
}
