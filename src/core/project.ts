import { closestDenseSample, sampleContour } from './spline';
import type {
  AnchorFrame,
  AutoFrameResult,
  Contour,
  ManualCorrection,
  ProjectState,
  ResolvedPoint,
  Track,
  TrackingParams,
} from './types';
import { newId } from './ids';
import { bbox, dist, pointInPolygon, type Vec2 } from './vec';

/**
 * Layered project state.
 *
 * Precedence at a frame, highest first:
 *   1. manual correction
 *   2. automatic result for the current revision
 *   3. original keyframe
 *
 * Revision rule: every structural edit increments `track.revision`. A tracking
 * job captures the revision when it starts and `applyAutoResult` refuses any
 * result whose captured revision no longer matches. That single guard, plus
 * deleting affected automatic frames at edit time, prevents a background job
 * from overwriting a just-finished manual correction. Edits invalidate only the
 * intervals they touch.
 */

export interface ViewFrame {
  frame: number;
  contour: Contour;
  method: 'keyframe' | 'manual' | 'auto' | 'none';
  resolved?: ResolvedPoint[];
  segments?: AutoFrameResult['segments'];
  auto?: AutoFrameResult;
  manual?: ManualCorrection;
  conflict: boolean;
  staleRevision: boolean;
}

export function emptyTrack(name: string, color: string, params: TrackingParams): Track {
  return {
    id: newId('track'),
    name,
    color,
    keyframes: {},
    manual: {},
    auto: {},
    params: { ...params },
    revision: 0,
  };
}

export function bumpRevision(track: Track): Track {
  return { ...track, revision: track.revision + 1 };
}

export function keyframeFrames(track: Track): number[] {
  return Object.keys(track.keyframes)
    .map(Number)
    .sort((a, b) => a - b);
}

export function manualFrames(track: Track): number[] {
  return Object.keys(track.manual)
    .map(Number)
    .sort((a, b) => a - b);
}

export function anchorFrames(track: Track): number[] {
  const set = new Set<number>([...keyframeFrames(track), ...manualFrames(track)]);
  return [...set].sort((a, b) => a - b);
}

export function anchorAt(track: Track, frame: number): AnchorFrame | undefined {
  const manual = track.manual[frame];
  if (manual) {
    return { frame, kind: 'manual', contour: manual.contour, constrainedIds: manual.constrainedIds };
  }
  const key = track.keyframes[frame];
  if (key) {
    return { frame, kind: 'keyframe', contour: key, constrainedIds: key.points.map((p) => p.id) };
  }
  return undefined;
}

export function trackClosed(track: Track): boolean {
  const first = Object.values(track.keyframes)[0] ?? Object.values(track.manual)[0]?.contour;
  return first ? first.closed : true;
}

export function viewFrameAt(track: Track, frame: number): ViewFrame {
  const manual = track.manual[frame];
  if (manual) {
    return {
      frame,
      contour: manual.contour,
      method: 'manual',
      manual,
      conflict: false,
      staleRevision: false,
    };
  }
  const auto = track.auto[frame];
  if (auto) {
    return {
      frame,
      contour: {
        points: auto.resolved.map((p) => ({ id: p.id, x: p.x, y: p.y })),
        closed: trackClosed(track),
      },
      method: 'auto',
      resolved: auto.resolved,
      segments: auto.segments,
      auto,
      conflict: auto.conflict,
      staleRevision: auto.revision !== track.revision,
    };
  }
  const key = track.keyframes[frame];
  if (key) {
    return { frame, contour: key, method: 'keyframe', conflict: false, staleRevision: false };
  }
  return {
    frame,
    contour: { points: [], closed: trackClosed(track) },
    method: 'none',
    conflict: false,
    staleRevision: false,
  };
}

export function previousAnchor(track: Track, frame: number): number | undefined {
  let prev: number | undefined;
  for (const f of anchorFrames(track)) {
    if (f < frame) prev = f;
    else break;
  }
  return prev;
}

export function nextAnchor(track: Track, frame: number): number | undefined {
  for (const f of anchorFrames(track)) if (f > frame) return f;
  return undefined;
}

export function intervalFor(track: Track, frame: number): { left: number; right: number } | null {
  if (anchorFrames(track).includes(frame)) return null;
  const left = previousAnchor(track, frame);
  const right = nextAnchor(track, frame);
  if (left === undefined || right === undefined) return null;
  return { left, right };
}

/** Delete every automatic frame strictly inside (lo, hi). Anchors are untouched. */
export function clearAutoInRange(track: Track, lo: number, hi: number): Track {
  const auto = { ...track.auto };
  for (const key of Object.keys(auto)) {
    const f = Number(key);
    if (f > lo && f < hi) delete auto[f];
  }
  return { ...track, auto };
}

export function clearAllAuto(track: Track): Track {
  return { ...track, auto: {} };
}

/**
 * Record an automatic result. Accepted only if the job's captured revision
 * still matches and no manual correction exists at that frame. Rejection is
 * the safety net for results that arrive after an edit.
 */
export function applyAutoResult(
  track: Track,
  capturedRevision: number,
  result: Omit<AutoFrameResult, 'revision'>,
): { track: Track; accepted: boolean; reason?: string } {
  if (capturedRevision !== track.revision) {
    return { track, accepted: false, reason: 'stale-revision' };
  }
  if (track.manual[result.frame]) {
    return { track, accepted: false, reason: 'manual-correction-present' };
  }
  const stored: AutoFrameResult = { ...result, revision: capturedRevision };
  return { track: { ...track, auto: { ...track.auto, [result.frame]: stored } }, accepted: true };
}

/**
 * Classify a user edit as observable or hidden-side.
 *
 * A touched control point may seed the next propagation only when it was
 * visible in the automatic evidence at that frame. Hidden-side edits are kept
 * in the manual layer (so the user's picture stays as drawn) but are reported
 * as `rejectedHiddenIds` and never seeded. If no automatic evidence exists at
 * this frame (e.g. editing a keyframe), the edit is treated as fully trusted.
 */
export function classifyManualEdit(
  track: Track,
  frame: number,
  contour: Contour,
  touchedIds: string[],
): { constrainedIds: string[]; rejectedHiddenIds: string[] } {
  const touched = new Set(touchedIds.length > 0 ? touchedIds : contour.points.map((p) => p.id));
  const auto = track.auto[frame];
  if (!auto) {
    return { constrainedIds: contour.points.filter((p) => touched.has(p.id)).map((p) => p.id), rejectedHiddenIds: [] };
  }
  const byId = new Map<string, ResolvedPoint>();
  for (const p of auto.resolved) byId.set(p.id, p);

  const constrained: string[] = [];
  const rejected: string[] = [];
  for (const p of contour.points) {
    const visible = byId.get(p.id)?.visible ?? false;
    if (touched.has(p.id)) {
      if (visible) constrained.push(p.id);
      else rejected.push(p.id);
    } else if (visible) {
      constrained.push(p.id);
    }
  }
  return { constrainedIds: constrained, rejectedHiddenIds: rejected };
}

export function makeManualCorrection(
  track: Track,
  frame: number,
  contour: Contour,
  touchedIds: string[],
  now = Date.now(),
): ManualCorrection {
  const { constrainedIds, rejectedHiddenIds } = classifyManualEdit(track, frame, contour, touchedIds);
  return {
    id: newId('manual'),
    frame,
    createdAt: now,
    contour: { points: contour.points.map((p) => ({ ...p })), closed: contour.closed },
    constrainedIds,
    rejectedHiddenIds,
  };
}

/**
 * Invalidate the automatic frames bracketed by the anchors immediately around
 * `frame`. Computed from the *current* anchor set, so call it after the edit has
 * been applied (or removed).
 */
export function invalidateIntervalContaining(track: Track, frame: number): Track {
  const left = previousAnchor(track, frame) ?? frame;
  const right = nextAnchor(track, frame) ?? frame;
  return clearAutoInRange(track, left, right);
}

export function applyManualCorrection(
  track: Track,
  frame: number,
  contour: Contour,
  touchedIds: string[],
  now = Date.now(),
): Track {
  const correction = makeManualCorrection(track, frame, contour, touchedIds, now);
  const withManual: Track = { ...track, manual: { ...track.manual, [frame]: correction } };
  return bumpRevision(invalidateIntervalContaining(withManual, frame));
}

export function removeManualCorrection(track: Track, frame: number): Track {
  if (!track.manual[frame]) return track;
  const manual = { ...track.manual };
  delete manual[frame];
  const next: Track = { ...track, manual };
  return bumpRevision(invalidateIntervalContaining(next, frame));
}

export function setKeyframe(track: Track, frame: number, contour: Contour): Track {
  const keyframes = { ...track.keyframes, [frame]: contour };
  const next: Track = { ...track, keyframes };
  return bumpRevision(invalidateIntervalContaining(next, frame));
}

export function removeKeyframe(track: Track, frame: number): Track {
  if (!track.keyframes[frame]) return track;
  const keyframes = { ...track.keyframes };
  delete keyframes[frame];
  const next: Track = { ...track, keyframes };
  return bumpRevision(invalidateIntervalContaining(next, frame));
}

export function hitControlPoint(
  contour: Contour,
  p: Vec2,
  tolerance: number,
): { index: number; id: string } | null {
  let best: { index: number; id: string; d: number } | null = null;
  for (let i = 0; i < contour.points.length; i++) {
    const d = dist(contour.points[i], p);
    if (d <= tolerance && (!best || d < best.d)) best = { index: i, id: contour.points[i].id, d };
  }
  return best ? { index: best.index, id: best.id } : null;
}

/** Nearest insertion slot on the spline, preserving existing control-point ids. */
export function insertionIndexAt(contour: Contour, p: Vec2): { index: number; denseT: number } | null {
  if (contour.points.length < 2) return null;
  const dense = sampleContour(contour.points, contour.closed, 12);
  const closest = closestDenseSample(p, dense);
  return { index: closest.segmentIndex, denseT: closest.segmentT };
}

export function pointsInside(contour: Contour, candidates: Vec2[]): number[] {
  const poly = contour.points;
  if (poly.length < 3) return [];
  const out: number[] = [];
  candidates.forEach((c, i) => {
    if (pointInPolygon(c, poly)) out.push(i);
  });
  return out;
}

export function robustContourBBox(contour: Contour): { minX: number; minY: number; maxX: number; maxY: number } {
  const points = contour.points;
  if (points.length < 5) return bbox(points);
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length;
  const ds = points.map((p) => Math.hypot(p.x - cx, p.y - cy)).sort((a, b) => a - b);
  const limit = ds[Math.floor(ds.length * 0.95)] * 1.5;
  const filtered = points.filter((p) => Math.hypot(p.x - cx, p.y - cy) <= limit);
  return bbox(filtered.length >= 3 ? filtered : points);
}

export function emptyProject(): ProjectState {
  return {
    version: 1,
    videoName: '',
    width: 0,
    height: 0,
    fps: 30,
    frameCount: 0,
    tracks: [],
    selectedTrackId: null,
  };
}

export function withTrack(project: ProjectState, track: Track): ProjectState {
  const tracks = project.tracks.some((t) => t.id === track.id)
    ? project.tracks.map((t) => (t.id === track.id ? track : t))
    : [...project.tracks, track];
  return { ...project, tracks };
}

export function selectedTrack(project: ProjectState): Track | undefined {
  return project.tracks.find((t) => t.id === project.selectedTrackId);
}
