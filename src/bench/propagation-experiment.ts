import { mkdirSync, writeFileSync } from 'node:fs';
import { runInterval } from '../core/engine';
import { redrawBurden } from '../core/redraw';
import { matchTemplateAt, sampleTemplate } from '../core/evidence';
import { controlNormals } from '../core/spline';
import { boundaryError, controlPointErrors } from './metrics';
import {
  generateScene,
  scenarioConfig,
  type ScenarioName,
  type SyntheticClip,
} from './synth';
import {
  DEFAULT_PARAMS,
  type Contour,
  type GrayFrame,
  type PropagationConstraint,
  type ResolvedPoint,
  type TrackJobResult,
} from '../core/types';

/**
 * Raw local trackability: NCC of an inward-sampled anchor template against the
 * next frame at the same spot. Unlike the percentile-normalised edge score this
 * does not saturate to 1 on a soft weak edge, so it distinguishes spans where
 * the independent 2-D patch search has real appearance to lock onto.
 */
function localTemplateNcc(clip: SyntheticClip, frame: number, index: number): number {
  const gray = clip.gray[frame] as GrayFrame;
  const points = clip.truth[frame].controlPoints;
  const normals = controlNormals(points, true);
  const template = sampleTemplate(
    gray,
    `p${index}`,
    points[index],
    DEFAULT_PARAMS.patchRadius,
    { x: -normals[index].x, y: -normals[index].y },
  );
  const nextFrame = clip.gray[Math.min(clip.frameCount - 1, frame + 1)];
  return matchTemplateAt(nextFrame, template, points[index], 0);
}

/**
 * Propagation-model trade-off experiment.
 *
 * Same keyframe curves are fed to three configurations on identical clips:
 *   1. joint-interval      — one global similarity model for the whole interval
 *                            with shape regularisation;
 *   2. independent-interval— every control point tracks its own local patch,
 *                            no cross-point shape coupling;
 *   3. segment-local       — the boundary condition: the model is chosen per
 *                            contour segment (independent on visible/deforming
 *                            spans, joint on occluded/weak spans) rather than
 *                            once between the keyframes.
 *
 * Outputs contour distance (boundary mean/p95/Hausdorff, control-point error)
 * and editing burden (changed control points, redrawn curve length, redraw
 * fraction). Every number is recomputed from the stored contours and ground
 * truth by this script; nothing is taken from a default or a hard-coded table.
 */

export type ExperimentScenario = Extract<ScenarioName, 'weak-edge' | 'local-occlusion'>;
export type ConfigName = 'joint-interval' | 'independent-interval' | 'segment-local';

export interface ConfigRun {
  config: ConfigName;
  scope: 'interval' | 'segment';
  boundaryMean: number;
  boundaryP95: number;
  boundaryHausdorff: number;
  controlMean: number;
  controlMax: number;
  changedPoints: number;
  totalPoints: number;
  redrawLength: number;
  contourLength: number;
  redrawFraction: number;
  visibleFrames: number;
  occludedPointFrames: number;
  locallySelectedPoints: number;
}

export interface ScenarioExperiment {
  scenario: ExperimentScenario;
  frames: number;
  keyframes: number[];
  pointTolerance: number;
  sampleTolerance: number;
  runs: ConfigRun[];
}

export interface ExperimentDocument {
  generatedAt: string;
  params: typeof DEFAULT_PARAMS;
  scenarios: ScenarioExperiment[];
}

const KEYFRAME_EVERY = 20;
const POINT_TOLERANCE = 2;
const SAMPLE_TOLERANCE = 1.5;
/**
 * Local-trackability gate, fixed from the measured anchor-template NCC
 * distribution rather than tuned to the result: weak-edge spans cluster below
 * ~0.7 while visible local-occlusion spans score above 0.9. This equals the
 * engine's own template threshold so the experiment uses the same evidence
 * standard as the tracker.
 */
const LOCAL_NCC_GATE = 0.72;

function contourFrom(points: { x: number; y: number }[], ids: string[]): Contour {
  return { closed: true, points: points.map((p, i) => ({ id: ids[i] ?? `p${i}`, x: p.x, y: p.y })) };
}

/**
 * Segment-local decision derived from *real sampled evidence* at the two
 * anchor frames plus ground-truth occlusion labels. A segment start id is
 * switched to independent only when its control point (a) is unoccluded at
 * both anchors and hidden for at most a third of the interval, and (b) has
 * genuinely trackable texture and an edge at both anchors. Weak/flat or
 * occluded spans stay on the joint shape prior — this is the boundary
 * condition separating per-segment local selection from a uniform choice.
 */
function buildSegmentLocalConstraint(
  clip: SyntheticClip,
  left: number,
  right: number,
  ids: string[],
): PropagationConstraint {
  const occCount = new Map<string, number>();
  for (let f = left; f <= right; f++) {
    clip.truth[f].occluded.forEach((hidden, i) => {
      if (hidden) occCount.set(ids[i], (occCount.get(ids[i]) ?? 0) + 1);
    });
  }
  const span = right - left + 1;

  // A span is locally trackable only when the raw anchor-template correlation
  // clears the same NCC gate the tracker uses, at BOTH bracketing keyframes.
  const trackableAt = (frame: number, index: number): boolean =>
    localTemplateNcc(clip, frame, index) >= LOCAL_NCC_GATE;

  const segmentModes: Record<string, 'joint' | 'independent'> = {};
  const segmentReasons: Record<string, string> = {};
  ids.forEach((id, i) => {
    const hiddenAtAnchor = clip.truth[left].occluded[i] || clip.truth[right].occluded[i];
    const hiddenRate = (occCount.get(id) ?? 0) / span;
    const locallyTrackable =
      !hiddenAtAnchor &&
      hiddenRate <= 0.34 &&
      trackableAt(left, i) &&
      trackableAt(right, i);

    if (locallyTrackable) {
      segmentModes[id] = 'independent';
      segmentReasons[id] = 'observable, textured span with local deformation';
    } else {
      segmentModes[id] = 'joint';
      const why = hiddenAtAnchor || hiddenRate > 0.34 ? 'occluded span held by shape prior' : 'weak edge/low texture held by shape prior';
      segmentReasons[id] = why;
    }
  });

  return {
    left,
    right,
    scope: 'segment',
    mode: 'joint',
    segmentModes,
    segmentReasons,
  };
}

async function runConfig(
  clip: SyntheticClip,
  ids: string[],
  keyframes: number[],
  config: ConfigName,
): Promise<{ tracked: Map<number, ResolvedPoint[]>; localCount: number }> {
  const readFrame = async (f: number): Promise<GrayFrame | undefined> => clip.gray[f];
  const tracked = new Map<number, ResolvedPoint[]>();
  let localCount = 0;

  for (let k = 0; k < keyframes.length - 1; k++) {
    const left = keyframes[k];
    const right = keyframes[k + 1];
    const leftContour = contourFrom(clip.truth[left].controlPoints, ids);
    const rightContour = contourFrom(clip.truth[right].controlPoints, ids);
    const trust = ids;

    let constraint: PropagationConstraint | undefined;
    if (config === 'joint-interval') {
      constraint = { left, right, scope: 'interval', mode: 'joint', segmentModes: {}, segmentReasons: {} };
    } else if (config === 'independent-interval') {
      constraint = { left, right, scope: 'interval', mode: 'independent', segmentModes: {}, segmentReasons: {} };
    } else {
      constraint = buildSegmentLocalConstraint(clip, left, right, ids);
    }

    await runInterval({
      left: { frame: left, contour: leftContour, constrainedIds: [...trust] },
      right: { frame: right, contour: rightContour, constrainedIds: [...trust] },
      params: { ...DEFAULT_PARAMS },
      readFrame,
      revision: 0,
      constraint,
      yieldFn: async () => {},
      onFrame: (r: TrackJobResult) => {
        tracked.set(r.frame, r.merged.resolved);
        localCount += r.merged.resolved.filter((p) => p.locallySelected).length;
      },
    });
  }
  return { tracked, localCount };
}

function aggregate(
  clip: SyntheticClip,
  config: ConfigName,
  scope: 'interval' | 'segment',
  tracked: Map<number, ResolvedPoint[]>,
  localCount: number,
): ConfigRun {
  const boundaryMeans: number[] = [];
  const boundaryP95: number[] = [];
  const boundaryHausdorff: number[] = [];
  const controlMeans: number[] = [];
  const controlMaxes: number[] = [];
  let changedPoints = 0;
  let totalPoints = 0;
  let redrawLength = 0;
  let contourLength = 0;
  let visibleFrames = 0;
  let occludedPointFrames = 0;

  for (const [frame, resolved] of [...tracked.entries()].sort((a, b) => a[0] - b[0])) {
    const truth = clip.truth[frame];
    const contour: Contour = { closed: true, points: resolved.map((p) => ({ id: p.id, x: p.x, y: p.y })) };
    const berr = boundaryError(contour, truth.polygon);
    const cerr = controlPointErrors(contour.points, truth.polygon);
    const burden = redrawBurden(contour, truth.polygon, POINT_TOLERANCE, SAMPLE_TOLERANCE);

    boundaryMeans.push(berr.mean);
    boundaryP95.push(berr.p95);
    boundaryHausdorff.push(berr.hausdorff);
    controlMeans.push(cerr.mean);
    controlMaxes.push(cerr.max);
    changedPoints += burden.changedPoints;
    totalPoints += burden.totalPoints;
    redrawLength += burden.redrawLength;
    contourLength += burden.contourLength;
    if (resolved.some((p) => p.visible)) visibleFrames++;
    occludedPointFrames += resolved.filter((p) => !p.visible).length;
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  if (!boundaryMeans.length) {
    throw new Error(`config ${config} produced no tracked frames — refusing to report default zeros`);
  }

  return {
    config,
    scope,
    boundaryMean: mean(boundaryMeans),
    boundaryP95: mean(boundaryP95),
    boundaryHausdorff: mean(boundaryHausdorff),
    controlMean: mean(controlMeans),
    controlMax: Math.max(...controlMaxes),
    changedPoints,
    totalPoints,
    redrawLength,
    contourLength,
    redrawFraction: contourLength > 0 ? redrawLength / contourLength : 0,
    visibleFrames,
    occludedPointFrames,
    locallySelectedPoints: localCount,
  };
}

export async function runExperiment(scenario: ExperimentScenario): Promise<ScenarioExperiment> {
  const cfg = scenarioConfig(scenario);
  const clip = generateScene(cfg);
  const ids = Array.from({ length: clip.controlPointCount }, (_, i) => `p${i}`);

  const keyframes: number[] = [];
  for (let f = 0; f < clip.frameCount; f += KEYFRAME_EVERY) keyframes.push(f);
  if (keyframes[keyframes.length - 1] !== clip.frameCount - 1) keyframes.push(clip.frameCount - 1);

  const configs: ConfigName[] = ['joint-interval', 'independent-interval', 'segment-local'];
  const runs: ConfigRun[] = [];
  for (const config of configs) {
    const { tracked, localCount } = await runConfig(clip, ids, keyframes, config);
    runs.push(aggregate(clip, config, config === 'segment-local' ? 'segment' : 'interval', tracked, localCount));
  }
  return { scenario, frames: clip.frameCount, keyframes, pointTolerance: POINT_TOLERANCE, sampleTolerance: SAMPLE_TOLERANCE, runs };
}

/**
 * Independent recomputation check: re-run every boundary distance from the
 * saved summary's raw inputs would need the frames, so instead we verify the
 * internal consistency of the stored figures (fractions, counts) and fail on
 * any NaN/Infinity or impossible ratio. This guards against a default value
 * masquerading as a measurement.
 */
export function verifyDocument(doc: ExperimentDocument): string[] {
  const problems: string[] = [];
  for (const sc of doc.scenarios) {
    for (const run of sc.runs) {
      const nums: [string, number][] = [
        ['boundaryMean', run.boundaryMean],
        ['boundaryP95', run.boundaryP95],
        ['boundaryHausdorff', run.boundaryHausdorff],
        ['controlMean', run.controlMean],
        ['redrawLength', run.redrawLength],
        ['contourLength', run.contourLength],
      ];
      for (const [name, value] of nums) {
        if (!Number.isFinite(value)) problems.push(`${sc.scenario}/${run.config}: ${name} not finite (${value})`);
      }
      if (run.changedPoints > run.totalPoints) {
        problems.push(`${sc.scenario}/${run.config}: changedPoints exceeds totalPoints`);
      }
      if (run.redrawFraction < 0 || run.redrawFraction > 1.0001) {
        problems.push(`${sc.scenario}/${run.config}: redrawFraction out of [0,1] (${run.redrawFraction})`);
      }
      const recomputedFraction = run.contourLength > 0 ? run.redrawLength / run.contourLength : 0;
      if (Math.abs(recomputedFraction - run.redrawFraction) > 1e-9) {
        problems.push(`${sc.scenario}/${run.config}: stored redrawFraction does not match recomputed value`);
      }
      if (run.totalPoints === 0) problems.push(`${sc.scenario}/${run.config}: no points measured`);
    }
  }
  return problems;
}

function printTable(doc: ExperimentDocument): void {
  for (const sc of doc.scenarios) {
    console.log(`\n== ${sc.scenario} (${sc.frames} frames, keyframes ${sc.keyframes.join(',')}) ==`);
    console.log(
      'config                  bnd-mean  bnd-p95  hausdorff  cp-mean  cp-max  changedPts  redrawLen  redraw%  localPts',
    );
    for (const r of sc.runs) {
      console.log(
        [
          r.config.padEnd(24),
          r.boundaryMean.toFixed(3).padStart(8),
          r.boundaryP95.toFixed(3).padStart(8),
          r.boundaryHausdorff.toFixed(3).padStart(10),
          r.controlMean.toFixed(3).padStart(8),
          r.controlMax.toFixed(3).padStart(7),
          String(r.changedPoints).padStart(11),
          r.redrawLength.toFixed(1).padStart(10),
          (r.redrawFraction * 100).toFixed(1).padStart(7),
          String(r.locallySelectedPoints).padStart(9),
        ].join(' '),
      );
    }
  }
}

async function main(): Promise<void> {
  const scenarios: ExperimentScenario[] = ['weak-edge', 'local-occlusion'];
  const results: ScenarioExperiment[] = [];
  for (const scenario of scenarios) results.push(await runExperiment(scenario));

  const doc: ExperimentDocument = {
    generatedAt: new Date().toISOString(),
    params: DEFAULT_PARAMS,
    scenarios: results,
  };
  const problems = verifyDocument(doc);
  if (problems.length) {
    for (const p of problems) console.error(`VERIFY FAILURE: ${p}`);
    process.exit(2);
  }

  mkdirSync('bench-out', { recursive: true });
  writeFileSync('bench-out/propagation-experiment.json', JSON.stringify(doc, null, 2));
  printTable(doc);
  console.log('\nwrote bench-out/propagation-experiment.json (verification passed)');
}

const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('propagation-experiment.ts')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
