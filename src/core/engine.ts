import { sampleTemplate } from './evidence';
import { controlNormals } from './spline';
import {
  makeCandidate,
  mergeCandidates,
  trackStep,
  zeroMotion,
  type MotionModel,
} from './tracker';
import type {
  Candidate,
  Contour,
  GrayFrame,
  PointTemplate,
  ProgressInfo,
  TrackingParams,
  TrackJobResult,
} from './types';

/**
 * Interval propagation.
 *
 * An interval is the open range between two anchors (keyframes or manual
 * corrections). Each interval is propagated independently from both ends so a
 * mid-clip correction only invalidates the two adjacent intervals. Every frame
 * keeps both candidates; the merge step decides per control-point id and flags
 * disagreements rather than silently averaging them away.
 */

export type FrameReader = (frame: number) => Promise<GrayFrame | undefined>;

export interface AnchorSeed {
  frame: number;
  contour: Contour;
  /** Stable ids that may seed propagation from this anchor. */
  constrainedIds: string[];
  /** Ids present at this anchor that must not seed (unobservable side). */
  rejectedIds?: string[];
}

export interface IntervalRunOptions {
  left: AnchorSeed;
  right: AnchorSeed;
  params: TrackingParams;
  readFrame: FrameReader;
  /** The project revision captured when the job started. */
  revision: number;
  onFrame?: (result: TrackJobResult) => void | Promise<void>;
  onProgress?: (info: ProgressInfo) => void;
  /** Called before every frame; return true to abort (stale job / user cancel). */
  shouldAbort?: () => boolean;
  /** Yield to the host event loop between frames. */
  yieldFn?: () => Promise<void>;
}

const defaultYield = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });

/** Merge two id orders, inserting ids that exist only in one direction. */
export function mergeIdOrder(forward: string[], backward: string[]): string[] {
  if (forward.length === 0) return [...backward];
  if (backward.length === 0) return [...forward];
  const base = forward.length >= backward.length ? [...forward] : [...backward];
  const other = forward.length >= backward.length ? backward : forward;
  const baseIndex = new Map(base.map((id, i) => [id, i]));
  for (let k = 0; k < other.length; k++) {
    const id = other[k];
    if (baseIndex.has(id)) continue;
    let pred = -1;
    for (let j = k - 1; j >= 0; j--) {
      const p = baseIndex.get(other[j]);
      if (p !== undefined) {
        pred = p;
        break;
      }
    }
    if (pred >= 0) {
      base.splice(pred + 1, 0, id);
    } else {
      let succ = -1;
      for (let j = k + 1; j < other.length; j++) {
        const p = baseIndex.get(other[j]);
        if (p !== undefined) {
          succ = p;
          break;
        }
      }
      if (succ >= 0) base.splice(succ, 0, id);
      else base.push(id);
    }
    baseIndex.clear();
    base.forEach((x, i) => baseIndex.set(x, i));
  }
  return base;
}

interface DirectionSeed {
  contour: Contour;
  constrained: Set<string>;
  rejected: Set<string>;
}

function seedSets(seed: AnchorSeed): DirectionSeed {
  const constrained = new Set(seed.constrainedIds);
  const rejected = new Set(seed.rejectedIds ?? []);
  // A rejected id can never also be constrained.
  for (const id of rejected) constrained.delete(id);
  return { contour: seed.contour, constrained, rejected };
}

function rigidMotionFromAnchor(contour: Contour): MotionModel {
  const m = zeroMotion(contour.points);
  return { ...m, trustedCount: 0 };
}

/** Maintain the hysteresis set for occlusion across a propagation pass. */
function updateOccludedSet(set: Set<string>, evidence: { id: string; visible: boolean }[]): void {
  for (const e of evidence) {
    if (e.visible) set.delete(e.id);
    else set.add(e.id);
  }
}

/** Sample anchor templates for every constrained control point. */
function buildTemplates(
  frame: GrayFrame,
  contour: Contour,
  constrained: Set<string>,
  radius: number,
): Map<string, PointTemplate> {
  const map = new Map<string, PointTemplate>();
  // Outward normals point away from the object; sampling inward keeps the
  // template on interior texture instead of on the boundary gradient.
  const normals = controlNormals(contour.points, contour.closed);
  contour.points.forEach((p, i) => {
    if (!constrained.has(p.id)) return;
    const n = normals[i] ?? { x: 0, y: 0 };
    map.set(p.id, sampleTemplate(frame, p.id, p, radius, { x: -n.x, y: -n.y }));
  });
  return map;
}

export async function runInterval(options: IntervalRunOptions): Promise<{
  emitted: number;
  aborted: boolean;
}> {
  const { left, right, params, readFrame } = options;
  const yieldFn = options.yieldFn ?? defaultYield;
  const closed = left.contour.closed;
  const ids = left.contour.points.map((p) => p.id);

  if (right.frame <= left.frame + 1) {
    return { emitted: 0, aborted: false };
  }

  const interior: number[] = [];
  for (let f = left.frame + 1; f < right.frame; f++) interior.push(f);
  const totalSteps = interior.length * 2 + 1;
  let done = 0;
  const report = (frame: number, direction: ProgressInfo['direction']) => {
    options.onProgress?.({ done, total: totalSteps, frame, direction });
  };
  const aborted = () => options.shouldAbort?.() ?? false;

  // ---- Forward pass -------------------------------------------------------
  const forward = new Map<number, Candidate>();
  {
    const seed = seedSets(left);
    let contour: Contour = { points: seed.contour.points.map((p) => ({ ...p })), closed };
    let prevFrame = await readFrame(left.frame);
    if (!prevFrame) return { emitted: 0, aborted: aborted() };
    let motion = rigidMotionFromAnchor(contour);
    let first = true;
    let totalRotation = 0;
    const templates = buildTemplates(prevFrame, contour, seed.constrained, params.patchRadius);
    const occludedIds = new Set<string>();

    for (const f of interior) {
      if (aborted()) return { emitted: 0, aborted: true };
      const curr = await readFrame(f);
      if (!curr) break;
      const trustedIds = first ? seed.constrained : new Set(contour.points.map((p) => p.id));
      const untrustedIds = first ? seed.rejected : new Set<string>();
      const step = trackStep({
        prev: prevFrame,
        curr,
        prevContour: contour,
        params,
        trustedIds,
        untrustedIds,
        motion,
        templates,
        templateThreshold: 0.72,
        templateRotation: totalRotation,
        occludedIds,
      });
      contour = { points: step.points, closed };
      motion = step.motion;
      totalRotation += step.motion.angle;
      updateOccludedSet(occludedIds, step.evidence);
      forward.set(f, makeCandidate('forward', left.frame, step.points, step.evidence));
      prevFrame = curr;
      first = false;
      done++;
      report(f, 'forward');
      if (yieldFn) await yieldFn();
    }
    // Keep ids used by the forward candidate for topology reporting.
    void ids;
  }

  // ---- Backward pass ------------------------------------------------------
  const backward = new Map<number, Candidate>();
  {
    const seed = seedSets(right);
    let contour: Contour = { points: seed.contour.points.map((p) => ({ ...p })), closed };
    let nextFrame = await readFrame(right.frame);
    if (!nextFrame) return { emitted: 0, aborted: aborted() };
    let motion = rigidMotionFromAnchor(contour);
    let first = true;
    let totalRotation = 0;
    const templates = buildTemplates(nextFrame, contour, seed.constrained, params.patchRadius);
    const occludedIds = new Set<string>();

    for (let k = interior.length - 1; k >= 0; k--) {
      const f = interior[k];
      if (aborted()) return { emitted: 0, aborted: true };
      const curr = await readFrame(f);
      if (!curr) break;
      const trustedIds = first ? seed.constrained : new Set(contour.points.map((p) => p.id));
      const untrustedIds = first ? seed.rejected : new Set<string>();
      // Backward: `prev` is the later frame, `curr` the earlier one.
      const step = trackStep({
        prev: nextFrame,
        curr,
        prevContour: contour,
        params,
        trustedIds,
        untrustedIds,
        motion,
        templates,
        templateThreshold: 0.72,
        templateRotation: -totalRotation,
        occludedIds,
      });
      contour = { points: step.points, closed };
      motion = step.motion;
      totalRotation += step.motion.angle;
      updateOccludedSet(occludedIds, step.evidence);
      backward.set(f, makeCandidate('backward', right.frame, step.points, step.evidence));
      nextFrame = curr;
      first = false;
      done++;
      report(f, 'backward');
      if (yieldFn) await yieldFn();
    }
  }

  // ---- Merge and emit -----------------------------------------------------
  let emitted = 0;
  for (const f of interior) {
    if (aborted()) return { emitted, aborted: true };
    const fwd = forward.get(f);
    const bwd = backward.get(f);
    if (!fwd && !bwd) continue;
    const merged = mergeCandidates(fwd, bwd, params);
    const result: TrackJobResult = {
      frame: f,
      forward: fwd,
      backward: bwd,
      merged: {
        frame: f,
        method: 'propagated',
        forward: fwd,
        backward: bwd,
        ...merged,
      },
    };
    await options.onFrame?.(result);
    emitted++;
    done++;
    report(f, 'merge');
    await yieldFn();
  }

  return { emitted, aborted: false };
}
