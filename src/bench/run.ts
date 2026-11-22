import { runInterval } from '../core/engine';
import { DEFAULT_PARAMS, type Contour, type GrayFrame, type ResolvedPoint, type TrackJobResult } from '../core/types';
import {
  generateScene,
  scenarioConfig,
  type ScenarioName,
  type SyntheticClip,
} from './synth';
import { boundaryError, controlPointErrors, identityStability, propagationDrift } from './metrics';
import { dist, type Vec2 } from '../core/vec';

export interface FrameMetrics {
  frame: number;
  boundaryMean: number;
  boundaryP95: number;
  boundaryHausdorff: number;
  controlMean: number;
  controlMax: number;
  driftMean: number;
  occludedCount: number;
  conflictCount: number;
  visibleCount: number;
  identityStable: boolean;
}

export interface ScenarioReport {
  scenario: ScenarioName;
  frames: number;
  meanBoundary: number;
  meanP95: number;
  meanHausdorff: number;
  meanControl: number;
  maxControl: number;
  meanDrift: number;
  maxDrift: number;
  driftGrowthPerFrame: number;
  identityStability: number;
  occludedFrameCount: number;
  conflictFrameCount: number;
  perFrame: FrameMetrics[];
}

export interface BenchOptions {
  scenario: ScenarioName;
  keyframeEvery?: number;
  fps?: number;
  sizes?: { width: number; height: number };
  frames?: number;
}

function contourFrom(points: Vec2[], ids: string[]): Contour {
  return {
    closed: true,
    points: points.map((p, i) => ({ id: ids[i] ?? `p${i}`, x: p.x, y: p.y })),
  };
}

export async function runScenario(options: BenchOptions): Promise<ScenarioReport> {
  const cfg = scenarioConfig(options.scenario, {
    width: options.sizes?.width,
    height: options.sizes?.height,
    frames: options.frames,
  });
  const clip = generateScene(cfg);
  const keyframeEvery = options.keyframeEvery ?? Math.max(8, Math.floor(clip.frameCount / 4));
  const ids = Array.from({ length: clip.controlPointCount }, (_, i) => `p${i}`);

  const keyframes: number[] = [];
  for (let f = 0; f < clip.frameCount; f += keyframeEvery) keyframes.push(f);
  if (keyframes[keyframes.length - 1] !== clip.frameCount - 1) keyframes.push(clip.frameCount - 1);

  const readFrame = async (f: number): Promise<GrayFrame | undefined> => clip.gray[f];
  const tracked = new Map<number, ResolvedPoint[]>();

  for (let k = 0; k < keyframes.length - 1; k++) {
    const left = keyframes[k];
    const right = keyframes[k + 1];
    const leftContour = contourFrom(clip.truth[left].controlPoints, ids);
    const rightContour = contourFrom(clip.truth[right].controlPoints, ids);
    const trust = new Set(ids);
    await runInterval({
      left: { frame: left, contour: leftContour, constrainedIds: [...trust] },
      right: { frame: right, contour: rightContour, constrainedIds: [...trust] },
      params: { ...DEFAULT_PARAMS },
      readFrame,
      revision: 0,
      yieldFn: async () => {},
      onFrame: (r: TrackJobResult) => {
        tracked.set(r.frame, r.merged.resolved);
      },
    });
  }

  const perFrame: FrameMetrics[] = [];
  const truthById = new Map<number, Vec2[]>();
  for (const truth of clip.truth) truthById.set(truth.frame, truth.controlPoints);

  let identityHits = 0;
  let identityChecks = 0;

  for (const f of keyframes) {
    const contour = contourFrom(clip.truth[f].controlPoints, ids);
    const err = boundaryError(contour, clip.truth[f].polygon);
    perFrame.push({
      frame: f,
      boundaryMean: err.mean,
      boundaryP95: err.p95,
      boundaryHausdorff: err.hausdorff,
      controlMean: 0,
      controlMax: 0,
      driftMean: 0,
      occludedCount: clip.truth[f].occluded.filter(Boolean).length,
      conflictCount: 0,
      visibleCount: ids.length,
      identityStable: true,
    });
  }

  for (const truth of clip.truth) {
    const res = tracked.get(truth.frame);
    if (!res) continue;
    const contour: Contour = { closed: true, points: res.map((p) => ({ id: p.id, x: p.x, y: p.y })) };
    const berr = boundaryError(contour, truth.polygon);
    const cerr = controlPointErrors(contour.points, truth.polygon);
    let drift = 0;
    let driftMax = 0;
    const n = Math.min(res.length, truth.controlPoints.length);
    for (let i = 0; i < n; i++) {
      const d = dist(res[i], truth.controlPoints[i]);
      drift += d;
      if (d > driftMax) driftMax = d;
    }
    drift = n ? drift / n : 0;
    const identity = identityStability(
      ids,
      res.map((p) => p.id),
    );
    identityChecks++;
    if (identity.stable) identityHits++;

    perFrame.push({
      frame: truth.frame,
      boundaryMean: berr.mean,
      boundaryP95: berr.p95,
      boundaryHausdorff: berr.hausdorff,
      controlMean: cerr.mean,
      controlMax: cerr.max,
      driftMean: drift,
      occludedCount: truth.occluded.filter(Boolean).length,
      conflictCount: res.filter((p) => p.conflict).length,
      visibleCount: res.filter((p) => p.visible).length,
      identityStable: identity.stable,
    });
  }
  perFrame.sort((a, b) => a.frame - b.frame);

  const projected = [...tracked.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([frame, res]) => ({ frame, points: res.map((p) => ({ x: p.x, y: p.y })) }));
  const drift = propagationDrift(projected, truthById);

  const trackedFrames = perFrame.filter((p) => !keyframes.includes(p.frame));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

  return {
    scenario: options.scenario,
    frames: clip.frameCount,
    meanBoundary: mean(trackedFrames.map((p) => p.boundaryMean)),
    meanP95: mean(trackedFrames.map((p) => p.boundaryP95)),
    meanHausdorff: mean(trackedFrames.map((p) => p.boundaryHausdorff)),
    meanControl: mean(trackedFrames.map((p) => p.controlMean)),
    maxControl: trackedFrames.length ? Math.max(...trackedFrames.map((p) => p.controlMax)) : 0,
    meanDrift: drift.meanDrift,
    maxDrift: drift.maxDrift,
    driftGrowthPerFrame: drift.growthPerFrame,
    identityStability: identityChecks ? identityHits / identityChecks : 1,
    occludedFrameCount: trackedFrames.filter((p) => p.occludedCount > 0).length,
    conflictFrameCount: trackedFrames.filter((p) => p.conflictCount > 0).length,
    perFrame,
  };
}

export { contourFrom };
export type { SyntheticClip };
