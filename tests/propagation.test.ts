import { describe, expect, it } from 'vitest';
import { generateScene, scenarioConfig } from '../src/bench/synth';
import { trackStepIndependent } from '../src/core/independentTracker';
import { hybridStep, modeForPoint } from '../src/core/hybridTracker';
import { sampleTemplate } from '../src/core/evidence';
import { controlNormals } from '../src/core/spline';
import { zeroMotion } from '../src/core/tracker';
import { DEFAULT_PARAMS, type Contour, type PropagationConstraint } from '../src/core/types';

function contourFrom(points: { x: number; y: number }[]): Contour {
  return { closed: true, points: points.map((p, i) => ({ id: `p${i}`, x: p.x, y: p.y })) };
}

describe('independent tracker', () => {
  it('follows a pure translation and keeps every id', () => {
    const cfg = scenarioConfig('rotation', { frames: 2 });
    const scene = generateScene({
      ...cfg,
      controlPoints: 16,
      truthSamples: 160,
      motion: (f) => {
        const base = cfg.motion(0);
        return { ...base, cx: 150 + f * 4, cy: 120 + f * 2, angle: 0, scale: 1 };
      },
    });
    const prev = contourFrom(scene.truth[0].controlPoints);
    const step = trackStepIndependent({
      prev: scene.gray[0],
      curr: scene.gray[1],
      prevContour: prev,
      params: { ...DEFAULT_PARAMS, searchRadius: 8 },
      trustedIds: new Set(prev.points.map((p) => p.id)),
    });
    expect(step.points.map((p) => p.id)).toEqual(prev.points.map((p) => p.id));
    const truth1 = scene.truth[1].controlPoints;
    let sum = 0;
    for (let i = 0; i < step.points.length; i++) {
      sum += Math.hypot(step.points[i].x - truth1[i].x, step.points[i].y - truth1[i].y);
    }
    expect(sum / step.points.length).toBeLessThan(1.5);
    expect(step.evidence.every((e) => e.propagationMode === 'independent')).toBe(true);
  });

  it('holds and flags an occluded point instead of following the occluder', () => {
    const scene = generateScene(scenarioConfig('local-occlusion', { frames: 30 }));
    // Locate a frame with at least one occluded control point.
    let target = -1;
    for (let f = 1; f < scene.frameCount; f++) {
      if (scene.truth[f].occluded.some(Boolean)) {
        target = f;
        break;
      }
    }
    expect(target).toBeGreaterThan(0);
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
    const step = trackStepIndependent({
      prev: scene.gray[target - 1],
      curr: scene.gray[target],
      prevContour: prev,
      params: DEFAULT_PARAMS,
      trustedIds: new Set(prev.points.map((p) => p.id)),
      templates,
      templateThreshold: 0.72,
    });
    const occludedIdx = scene.truth[target].occluded
      .map((hidden, i) => (hidden ? i : -1))
      .filter((i) => i >= 0);
    expect(occludedIdx.length).toBeGreaterThan(0);
    const held = occludedIdx.filter((i) => !step.evidence[i].visible && step.evidence[i].regularized);
    // A majority of the genuinely covered points must not be snapped onto the bar.
    expect(held.length).toBeGreaterThanOrEqual(Math.floor(occludedIdx.length * 0.5));
  });
});

describe('hybrid step model selection', () => {
  const scene = generateScene(scenarioConfig('rotation', { frames: 2 }));
  const prev = contourFrom(scene.truth[0].controlPoints);

  function run(constraint?: PropagationConstraint) {
    return hybridStep({
      prev: scene.gray[0],
      curr: scene.gray[1],
      prevContour: prev,
      params: DEFAULT_PARAMS,
      trustedIds: new Set(prev.points.map((p) => p.id)),
      motion: zeroMotion(prev.points),
      constraint,
    });
  }

  it('defaults to joint for every point without a constraint', () => {
    const step = run();
    expect(step.evidence.every((e) => e.propagationMode === 'joint')).toBe(true);
    expect(modeForPoint(undefined, 'p0')).toEqual({ mode: 'joint', locallySelected: false });
  });

  it('applies one uniform independent model across the interval', () => {
    const constraint: PropagationConstraint = {
      left: 0,
      right: 10,
      scope: 'interval',
      mode: 'independent',
      segmentModes: {},
      segmentReasons: {},
    };
    const step = run(constraint);
    expect(step.evidence.every((e) => e.propagationMode === 'independent')).toBe(true);
    expect(step.evidence.every((e) => !e.locallySelected)).toBe(true);
  });

  it('selects the model per segment under segment scope', () => {
    const firstId = prev.points[0].id;
    const constraint: PropagationConstraint = {
      left: 0,
      right: 10,
      scope: 'segment',
      mode: 'joint',
      segmentModes: { [firstId]: 'independent' },
      segmentReasons: { [firstId]: 'test' },
    };
    const step = run(constraint);
    const first = step.evidence.find((e) => e.id === firstId)!;
    expect(first.propagationMode).toBe('independent');
    expect(first.locallySelected).toBe(true);
    expect(step.evidence.filter((e) => e.id !== firstId).every((e) => e.propagationMode === 'joint')).toBe(true);
    expect(modeForPoint(constraint, firstId)).toEqual({ mode: 'independent', locallySelected: true });
    expect(modeForPoint(constraint, 'p999')).toEqual({ mode: 'joint', locallySelected: false });
  });
});
