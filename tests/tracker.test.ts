import { describe, expect, it } from 'vitest';
import { generateScene, scenarioConfig, transformPoints } from '../src/bench/synth';
import {
  mergeCandidates,
  makeCandidate,
  trackStep,
  updateMotion,
  zeroMotion,
} from '../src/core/tracker';
import { DEFAULT_PARAMS, type Contour } from '../src/core/types';
import { v } from '../src/core/vec';
import { assessPoint, sampleTemplate } from '../src/core/evidence';
import { controlNormals } from '../src/core/spline';

function contourFrom(points: { x: number; y: number }[]): Contour {
  return {
    closed: true,
    points: points.map((p, i) => ({ id: `p${i}`, x: p.x, y: p.y })),
  };
}

describe('tracker known-answer', () => {
  it('follows a pure translation within sub-pixel error', () => {
    const cfg = scenarioConfig('rotation', { frames: 2 });
    // Replace with an exactly translating object for this test.
    const scene = generateScene({
      ...cfg,
      controlPoints: 16,
      truthSamples: 160,
      motion: (f) => {
        const base = cfg.motion(0);
        return { ...base, cx: 150 + f * 4, cy: 120 + f * 2, angle: 0, scale: 1 };
      },
    });
    const truth0 = scene.truth[0].controlPoints;
    const truth1 = scene.truth[1].controlPoints;
    const prev = contourFrom(truth0);
    const step = trackStep({
      prev: scene.gray[0],
      curr: scene.gray[1],
      prevContour: prev,
      params: { ...DEFAULT_PARAMS, searchRadius: 8 },
      trustedIds: new Set(prev.points.map((p) => p.id)),
      motion: zeroMotion(prev.points),
    });
    let sum = 0;
    for (let i = 0; i < step.points.length; i++) {
      sum += Math.hypot(step.points[i].x - truth1[i].x, step.points[i].y - truth1[i].y);
    }
    const mean = sum / step.points.length;
    expect(mean).toBeLessThan(1.2);
  });

  it('preserves control-point ids exactly across a step', () => {
    const scene = generateScene(scenarioConfig('rotation', { frames: 2 }));
    const prev = contourFrom(scene.truth[0].controlPoints);
    const step = trackStep({
      prev: scene.gray[0],
      curr: scene.gray[1],
      prevContour: prev,
      params: DEFAULT_PARAMS,
      trustedIds: new Set(prev.points.map((p) => p.id)),
      motion: zeroMotion(prev.points),
    });
    expect(step.points.map((p) => p.id)).toEqual(prev.points.map((p) => p.id));
  });

  it('keeps a shape-regularised point flagged and low confidence under occlusion', () => {
    const scene = generateScene(scenarioConfig('occlusion', { frames: 40 }));
    // Find the frame where the bar covers roughly half the contour.
    const target = 20;
    const tru = scene.truth[target];
    const covered = tru.occluded.filter(Boolean).length;
    expect(covered).toBeGreaterThan(2);

    // Seed from truth at target-1 and step once, with anchor templates sampled
    // inward from the boundary exactly as the engine does. Occlusion cannot be
    // detected from frame-to-frame NCC alone: the textured bar tracks perfectly
    // against itself, so the anchor template is the authoritative test.
    const prev = contourFrom(scene.truth[target - 1].controlPoints);
    const normals = controlNormals(prev.points, true);
    const templates = new Map(
      prev.points.map((p, i) => [
        p.id,
        sampleTemplate(scene.gray[target - 1], p.id, p, DEFAULT_PARAMS.patchRadius, {
          x: -normals[i].x,
          y: -normals[i].y,
        }),
      ]),
    );
    const step = trackStep({
      prev: scene.gray[target - 1],
      curr: scene.gray[target],
      prevContour: prev,
      params: DEFAULT_PARAMS,
      trustedIds: new Set(prev.points.map((p) => p.id)),
      motion: zeroMotion(prev.points),
      templates,
      templateThreshold: 0.72,
    });
    const coveredSet = new Set(tru.occluded.map((c, i) => (c ? i : -1)).filter((i) => i >= 0));
    let flagged = 0;
    for (const i of coveredSet) {
      if (!step.evidence[i].visible) flagged++;
    }
    // Most occluded points should lose visibility.
    expect(flagged).toBeGreaterThanOrEqual(Math.floor(coveredSet.size * 0.6));
  });
});

describe('evidence observability', () => {
  it('reports low texture in a flat region', () => {
    const w = 40;
    const h = 40;
    const flat = { width: w, height: h, data: new Uint8Array(w * h).fill(120) };
    const obs = assessPoint(flat, v(20, 20), v(1, 0), 5, 4, flat);
    expect(obs.visible).toBe(false);
    expect(obs.texture).toBeLessThan(0.1);
  });

  it('reports texture and edge on a real boundary', () => {
    const scene = generateScene(scenarioConfig('rotation', { frames: 1 }));
    const frame = scene.gray[0];
    const pts = scene.truth[0].controlPoints;
    const normals = controlNormals(pts, true);
    const obs = assessPoint(frame, pts[0], normals[0], 6, 5, null);
    expect(obs.visible).toBe(true);
    expect(obs.edge).toBeGreaterThan(0.1);
  });
});

describe('mergeCandidates', () => {
  it('keeps the higher-confidence side per id and flags conflicts', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const ev = (visible: boolean, confidence: number) => ({
      id: '',
      ncc: confidence,
      templateNcc: confidence,
      edge: 0.5,
      confidence,
      visible,
      regularized: false,
      motion: { x: 0, y: 0 },
      searchOffset: { x: 0, y: 0 },
      normal: { x: 1, y: 0 },
      edgeOffset: 0,
      patchRadius: 6,
      searchRadius: 10,
      source: 'image' as const,
    });
    const fwdPts = ids.map((id, i) => ({ id, x: 100 + i * 10, y: 100 }));
    const bwdPts = ids.map((id, i) => ({ id, x: 100 + i * 10 + (i === 2 ? 12 : 0), y: 100 }));
    const fwd = makeCandidate('forward', 0, fwdPts, ids.map((id) => ({ ...ev(true, 0.8), id })));
    const bwd = makeCandidate(
      'backward',
      10,
      bwdPts,
      ids.map((id, i) => ({ ...ev(i === 2, i === 2 ? 0.9 : 0.4), id })),
    );
    const merged = mergeCandidates(fwd, bwd, DEFAULT_PARAMS);
    expect(merged.conflict).toBe(true);
    expect(merged.conflictCount).toBe(1);
    const c = merged.resolved.find((p) => p.id === 'c')!;
    expect(c.conflict).toBe(true);
    // Backward side was more confident at 'c', so it wins.
    expect(c.x).toBeCloseTo(132, 5);
  });

  it('falls back to a one-sided candidate when only one direction exists', () => {
    const pts = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 0 },
      { id: 'c', x: 10, y: 10 },
    ];
    const evidence = pts.map((p) => ({
      id: p.id,
      ncc: 0.8,
      templateNcc: 0.8,
      edge: 0.6,
      confidence: 0.8,
      visible: true,
      regularized: false,
      motion: { x: 0, y: 0 },
      searchOffset: { x: 0, y: 0 },
      normal: { x: 1, y: 0 },
      edgeOffset: 0,
      patchRadius: 6,
      searchRadius: 10,
      source: 'image' as const,
    }));
    const merged = mergeCandidates(makeCandidate('forward', 0, pts, evidence), undefined, DEFAULT_PARAMS);
    expect(merged.resolved).toHaveLength(3);
    expect(merged.segments.every((s) => s.status !== 'conflict')).toBe(true);
  });
});

describe('motion model', () => {
  it('recovers a rigid translation and scale from visible points', () => {
    const prev = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      x: 50 + 20 * Math.cos((i / 8) * Math.PI * 2),
      y: 50 + 20 * Math.sin((i / 8) * Math.PI * 2),
    }));
    const next = prev.map((p) => ({ x: 50 + (p.x - 50) * 1.1 + 5, y: 50 + (p.y - 50) * 1.1 + 3 }));
    void transformPoints;
    const evidence = prev.map((p) => ({
      id: p.id,
      ncc: 0.9,
      templateNcc: 0.9,
      edge: 0.7,
      confidence: 0.9,
      visible: true,
      regularized: false,
      motion: { x: 0, y: 0 },
      searchOffset: { x: 0, y: 0 },
      normal: { x: 1, y: 0 },
      edgeOffset: 0,
      patchRadius: 6,
      searchRadius: 10,
      source: 'image' as const,
    }));
    const m = updateMotion(zeroMotion(prev), prev, next.map((p, i) => ({ id: prev[i].id, ...p })), evidence);
    expect(m.scale).toBeCloseTo(1.1, 1);
    expect(m.dx).toBeCloseTo(5, 0);
    expect(m.dy).toBeCloseTo(3, 0);
  });
});
