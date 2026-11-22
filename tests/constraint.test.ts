import { describe, expect, it } from 'vitest';
import {
  clearIntervalConstraint,
  clearSegmentConstraint,
  constraintForInterval,
  effectiveSegmentMode,
  emptyTrack,
  setIntervalConstraint,
  setKeyframe,
  setSegmentConstraint,
  viewFrameAt,
} from '../src/core/project';
import { redrawBurden } from '../src/core/redraw';
import { parseProject, serializeProject } from '../src/core/persistence';
import { DEFAULT_PARAMS, type Contour, type ProjectState } from '../src/core/types';

const circle = (n: number, cx: number, cy: number, r = 20): Contour => ({
  closed: true,
  points: Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    x: cx + r * Math.cos((i / n) * Math.PI * 2),
    y: cy + r * Math.sin((i / n) * Math.PI * 2),
  })),
});

function seeded(): ReturnType<typeof emptyTrack> {
  let t = emptyTrack('t', '#f00', DEFAULT_PARAMS);
  t = setKeyframe(t, 0, circle(10, 50, 60));
  t = setKeyframe(t, 10, circle(10, 70, 60));
  return t;
}

describe('propagation constraints', () => {
  it('stores a uniform interval model and invalidates auto frames', () => {
    let t = seeded();
    t = setIntervalConstraint(t, 0, 10, 'independent');
    const c = constraintForInterval(t, 0, 10)!;
    expect(c.scope).toBe('interval');
    expect(c.mode).toBe('independent');
    // Editing the model bumps the revision so stale auto results cannot linger.
    expect(t.revision).toBeGreaterThan(2);
  });

  it('promotes to segment scope and keeps per-segment decisions', () => {
    let t = seeded();
    t = setSegmentConstraint(t, 0, 10, 'p3', 'independent', 'occlusion toggle');
    let c = constraintForInterval(t, 0, 10)!;
    expect(c.scope).toBe('segment');
    expect(c.segmentModes.p3).toBe('independent');
    expect(c.segmentReasons.p3).toBe('occlusion toggle');
    expect(effectiveSegmentMode(c, 'p3').locallySelected).toBe(true);
    expect(effectiveSegmentMode(c, 'p4').mode).toBe('joint');

    // A second switch on another segment is retained.
    t = setSegmentConstraint(t, 0, 10, 'p7', 'joint', 'weak edge');
    c = constraintForInterval(t, 0, 10)!;
    expect(c.segmentModes.p3).toBe('independent');
    expect(c.segmentModes.p7).toBe('joint');

    // Clearing the only overrides reverts to a uniform interval constraint.
    t = clearSegmentConstraint(t, 0, 10, 'p3');
    t = clearSegmentConstraint(t, 0, 10, 'p7');
    c = constraintForInterval(t, 0, 10)!;
    expect(c.scope).toBe('interval');
    expect(Object.keys(c.segmentModes)).toHaveLength(0);
  });

  it('removes the whole interval decision on clear', () => {
    let t = setIntervalConstraint(seeded(), 0, 10, 'independent');
    t = clearIntervalConstraint(t, 0, 10);
    expect(constraintForInterval(t, 0, 10)).toBeUndefined();
  });
});

describe('redraw burden', () => {
  it('counts only points beyond tolerance and measures redrawn arc length', () => {
    const truth = circle(12, 100, 100, 40);
    // Shift the whole contour by 8 px: the minimum normal displacement over a
    // circle's points is 8 px too, so every control point exceeds the 2 px
    // tolerance against the truth boundary polyline.
    const drifted: Contour = {
      closed: true,
      points: truth.points.map((p) => ({ ...p, x: p.x + 8 })),
    };
    const report = redrawBurden(drifted, truth.points, 2, 1.5);
    expect(report.changedPoints).toBe(12);
    expect(report.totalPoints).toBe(12);
    expect(report.redrawLength).toBeGreaterThan(0);
    expect(report.redrawFraction).toBeGreaterThan(0);
    expect(report.redrawFraction).toBeLessThan(1);
  });

  it('reports zero burden for an exact contour', () => {
    const truth = circle(12, 100, 100, 40);
    const report = redrawBurden(truth, truth.points);
    expect(report.changedPoints).toBe(0);
    expect(report.redrawLength).toBeCloseTo(0, 6);
    expect(report.redrawFraction).toBeCloseTo(0, 6);
  });
});

describe('project persistence', () => {
  function project(): ProjectState {
    let t = seeded();
    t = setSegmentConstraint(t, 0, 10, 'p2', 'independent', 'editor switch');
    return {
      version: 1,
      videoName: 'synthetic-clip',
      width: 320,
      height: 240,
      fps: 30,
      frameCount: 11,
      tracks: [t],
      selectedTrackId: t.id,
    };
  }

  it('round-trips a project including local constraints', () => {
    const original = project();
    const text = serializeProject(original);
    const reopened = parseProject(text);
    expect(reopened.tracks).toHaveLength(1);
    const c = reopened.tracks[0].constraints[0];
    expect(c.scope).toBe('segment');
    expect(c.segmentModes.p2).toBe('independent');
    expect(Object.keys(reopened.tracks[0].keyframes).sort()).toEqual(['0', '10']);
    expect(viewFrameAt(reopened.tracks[0], 0).method).toBe('keyframe');
  });

  it('refuses a wrong format version instead of defaulting', () => {
    const text = JSON.stringify({ formatVersion: 999, project: {} });
    expect(() => parseProject(text)).toThrow(/formatVersion/);
  });

  it('refuses malformed control points instead of repairing them', () => {
    const parsed = JSON.parse(serializeProject(project()));
    const firstPoint = parsed.project.tracks[0].keyframes[0].points[0];
    firstPoint.x = 'not-a-number';
    expect(() => parseProject(JSON.stringify(parsed))).toThrow(/numeric x\/y/);
  });
});
