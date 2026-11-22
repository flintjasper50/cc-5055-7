import { describe, expect, it } from 'vitest';
import {
  anchorFrames,
  applyAutoResult,
  applyManualCorrection,
  classifyManualEdit,
  emptyTrack,
  invalidateIntervalContaining,
  removeManualCorrection,
  setKeyframe,
  viewFrameAt,
  intervalFor,
  previousAnchor,
  nextAnchor,
  clearAutoInRange,
} from '../src/core/project';
import { DEFAULT_PARAMS, type AutoFrameResult, type Contour, type ResolvedPoint } from '../src/core/types';

const circle = (n: number, cx: number, cy: number, r = 20): Contour => ({
  closed: true,
  points: Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    x: cx + r * Math.cos((i / n) * Math.PI * 2),
    y: cy + r * Math.sin((i / n) * Math.PI * 2),
  })),
});

function resolvedFrom(contour: Contour, visibleIds: string[] = []): ResolvedPoint[] {
  const vis = new Set(visibleIds.length ? visibleIds : contour.points.map((p) => p.id));
  return contour.points.map((p) => ({
    id: p.id,
    x: p.x,
    y: p.y,
    visible: vis.has(p.id),
    regularized: false,
    confidence: vis.has(p.id) ? 0.8 : 0.1,
    ncc: vis.has(p.id) ? 0.8 : 0.2,
    edge: 0.5,
    conflict: false,
    source: vis.has(p.id) ? 'image' : 'regularized',
  }));
}

function autoResult(frame: number, contour: Contour, visibleIds?: string[]): Omit<AutoFrameResult, 'revision'> {
  const resolved = resolvedFrom(contour, visibleIds);
  return {
    frame,
    method: 'propagated',
    resolved,
    segments: [],
    conflict: false,
    conflictCount: 0,
    occludedCount: resolved.filter((r) => !r.visible).length,
    regularizedCount: 0,
    blend: 'none',
    identityMismatch: false,
  };
}

function trackWithKeyframes(keys: number[]): ReturnType<typeof emptyTrack> {
  let t = emptyTrack('t', '#f00', DEFAULT_PARAMS);
  for (const f of keys) t = setKeyframe(t, f, circle(12, 50 + f, 60));
  return t;
}

describe('layer precedence', () => {
  it('shows keyframe when no auto result exists', () => {
    const t = trackWithKeyframes([0, 10]);
    expect(viewFrameAt(t, 0).method).toBe('keyframe');
  });

  it('auto result overrides keyframe-absent frames, manual overrides auto', () => {
    let t = trackWithKeyframes([0, 10]);
    const rev = t.revision;
    t = applyAutoResult(t, rev, autoResult(5, circle(12, 55, 60))).track;
    expect(viewFrameAt(t, 5).method).toBe('auto');
    t = applyManualCorrection(t, 5, circle(12, 70, 60), ['p0']);
    expect(viewFrameAt(t, 5).method).toBe('manual');
  });
});

describe('stale background results', () => {
  it('rejects an auto result whose captured revision is out of date', () => {
    let t = trackWithKeyframes([0, 10]);
    const captured = t.revision;
    // User edits while the job is running.
    t = applyManualCorrection(t, 5, circle(12, 70, 60), ['p0']);
    const applied = applyAutoResult(t, captured, autoResult(6, circle(12, 56, 60)));
    expect(applied.accepted).toBe(false);
    expect(applied.reason).toBe('stale-revision');
    // The manual correction at frame 5 is untouched.
    expect(viewFrameAt(t, 5).method).toBe('manual');
  });

  it('never overwrites a manual correction at the exact same frame', () => {
    let t = trackWithKeyframes([0, 10]);
    t = applyManualCorrection(t, 5, circle(12, 70, 60), ['p0']);
    const rev = t.revision;
    const applied = applyAutoResult(t, rev, autoResult(5, circle(12, 56, 60)));
    expect(applied.accepted).toBe(false);
    expect(applied.reason).toBe('manual-correction-present');
  });

  it('accepts a fresh result when revision still matches', () => {
    const t = trackWithKeyframes([0, 10]);
    const applied = applyAutoResult(t, t.revision, autoResult(5, circle(12, 55, 60)));
    expect(applied.accepted).toBe(true);
    expect(viewFrameAt(applied.track, 5).method).toBe('auto');
  });
});

describe('interval-scoped recompute', () => {
  it('editing one interval keeps auto results in the other interval', () => {
    let t = trackWithKeyframes([0, 10, 20]);
    const rev = t.revision;
    for (const f of [5, 6, 15, 16]) t = applyAutoResult(t, rev, autoResult(f, circle(12, 50 + f, 60))).track;
    expect(Object.keys(t.auto).map(Number).sort((a, b) => a - b)).toEqual([5, 6, 15, 16]);

    // Insert a manual correction at 12, which lies inside interval (10,20).
    t = applyManualCorrection(t, 12, circle(12, 62, 60), ['p0']);
    // Only the (10,20) interval is cleared.
    expect(Object.keys(t.auto).map(Number).sort((a, b) => a - b)).toEqual([5, 6]);
    expect(anchorFrames(t)).toEqual([0, 10, 12, 20]);
    expect(intervalFor(t, 15)).toEqual({ left: 12, right: 20 });
    expect(previousAnchor(t, 12)).toBe(10);
    expect(nextAnchor(t, 12)).toBe(20);
  });

  it('removing a manual correction re-opens only its merged interval', () => {
    let t = trackWithKeyframes([0, 10, 20]);
    const rev = t.revision;
    for (const f of [5, 15]) t = applyAutoResult(t, rev, autoResult(f, circle(12, 50 + f, 60))).track;
    t = removeManualCorrection(t, 12);
    expect(t.manual[12]).toBeUndefined();
    // No manual existed; unchanged auto frames remain.
    expect(Object.keys(t.auto)).toHaveLength(2);
  });

  it('clearAutoInRange leaves anchors intact', () => {
    let t = trackWithKeyframes([0, 10]);
    const rev = t.revision;
    for (const f of [0, 5, 10]) t = applyAutoResult(t, rev, autoResult(f, circle(12, 50 + f, 60))).track;
    const cleared = clearAutoInRange(t, 0, 10);
    // Only strictly interior frames are cleared.
    expect(cleared.auto[0]).toBeDefined();
    expect(cleared.auto[10]).toBeDefined();
    expect(cleared.auto[5]).toBeUndefined();
    expect(invalidateIntervalContaining(t, 5)).toBeTruthy();
  });
});

describe('observable-side classification', () => {
  it('seeds only observable points after a partial-occlusion correction', () => {
    let t = trackWithKeyframes([0, 10]);
    const rev = t.revision;
    const contour = circle(8, 60, 60);
    // Points p0..p3 are visible; p4..p7 are occluded.
    t = applyAutoResult(t, rev, autoResult(5, contour, ['p0', 'p1', 'p2', 'p3'])).track;

    // User nudges everything, including the hidden side.
    const nudged: Contour = {
      closed: true,
      points: contour.points.map((p, i) => ({ ...p, x: p.x + (i % 2 === 0 ? 3 : -3), y: p.y + 2 })),
    };
    const touched = nudged.points.map((p) => p.id);
    const { constrainedIds, rejectedHiddenIds } = classifyManualEdit(t, 5, nudged, touched);
    expect(constrainedIds.sort()).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(rejectedHiddenIds.sort()).toEqual(['p4', 'p5', 'p6', 'p7']);
  });

  it('keeps rejected hidden ids in the manual layer without seeding them', () => {
    let t = trackWithKeyframes([0, 10]);
    const rev = t.revision;
    const contour = circle(8, 60, 60);
    t = applyAutoResult(t, rev, autoResult(5, contour, ['p0', 'p1'])).track;
    const nudged: Contour = {
      closed: true,
      points: contour.points.map((p) => ({ ...p, x: p.x + 4 })),
    };
    t = applyManualCorrection(t, 5, nudged, nudged.points.map((p) => p.id));
    const manual = t.manual[5];
    expect(manual.rejectedHiddenIds.sort()).toEqual(['p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(manual.constrainedIds.sort()).toEqual(['p0', 'p1']);
    // Manual contour shows *all* the user's points (their picture is preserved).
    expect(manual.contour.points[4].x).toBeCloseTo(nudged.points[4].x, 5);
  });

  it('trusts every touched point when no automatic evidence exists', () => {
    const t = trackWithKeyframes([0, 10]);
    const key = t.keyframes[0];
    const { constrainedIds, rejectedHiddenIds } = classifyManualEdit(t, 0, key, [key.points[0].id]);
    expect(constrainedIds).toEqual([key.points[0].id]);
    expect(rejectedHiddenIds).toEqual([]);
  });
});
