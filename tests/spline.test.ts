import { describe, expect, it } from 'vitest';
import {
  sampleContour,
  controlNormals,
  polylineLength,
  resampleClosedByArcLength,
} from '../src/core/spline';
import { pointInPolygon, polygonSignedArea, v } from '../src/core/vec';

const square = [v(0, 0), v(10, 0), v(10, 10), v(0, 10)];
const circle = (n: number, r = 20, cx = 0, cy = 0) =>
  Array.from({ length: n }, (_, i) => v(cx + r * Math.cos((i / n) * Math.PI * 2), cy + r * Math.sin((i / n) * Math.PI * 2)));

describe('spline evaluation', () => {
  it('passes through control points at segment boundaries', () => {
    const dense = sampleContour(square, true, 1);
    for (const p of square) {
      const hit = dense.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-6);
      expect(hit).toBe(true);
    }
  });

  it('keeps stable parameterisation when a control point moves slightly', () => {
    const perturbed = square.map((p, i) => (i === 2 ? v(p.x + 0.01, p.y) : p));
    const a = sampleContour(square, true, 8);
    const b = sampleContour(perturbed, true, 8);
    expect(a.points.length).toBe(b.points.length);
    // Segment assignment is purely structural, so sample k always refers to the
    // same segment/parameter regardless of geometry.
    expect([...a.segmentIndex]).toEqual([...b.segmentIndex]);
    expect([...a.segmentT]).toEqual([...b.segmentT]);
  });

  it('produces outward normals for a CCW control polygon', () => {
    const pts = circle(12);
    const normals = controlNormals(pts, true);
    for (let i = 0; i < pts.length; i++) {
      const outward = Math.hypot(pts[i].x, pts[i].y) > 1e-6 ? v(pts[i].x - 0, pts[i].y - 0) : v(1, 0);
      const dot = normals[i].x * outward.x + normals[i].y * outward.y;
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('resampling is only explicit and yields the requested count', () => {
    const pts = circle(9);
    const out = resampleClosedByArcLength(pts, 32);
    expect(out.length).toBe(32);
    // Area is approximately preserved by arc-length resampling.
    const areaBefore = Math.abs(polygonSignedArea(pts));
    const areaAfter = Math.abs(polygonSignedArea(out));
    expect(areaAfter / areaBefore).toBeGreaterThan(0.9);
    expect(areaAfter / areaBefore).toBeLessThan(1.1);
  });

  it('point-in-polygon works for a concave shape', () => {
    const concave = [v(0, 0), v(10, 0), v(10, 10), v(5, 3), v(0, 10)];
    expect(pointInPolygon(v(5, 1), concave)).toBe(true);
    expect(pointInPolygon(v(5, 8), concave)).toBe(false);
  });

  it('polyline length matches the polygon perimeter', () => {
    expect(polylineLength(square, true)).toBeCloseTo(40, 6);
  });
});
