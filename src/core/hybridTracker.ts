import { trackStep, type MotionModel, type StepResult } from './tracker';
import { trackStepIndependent } from './independentTracker';
import type {
  Contour,
  ControlPoint,
  GrayFrame,
  PointEvidence,
  PointTemplate,
  PropagationConstraint,
  PropagationMode,
  TrackingParams,
} from './types';

/**
 * Hybrid propagation step.
 *
 * Both candidate models — the joint similarity step and the independent
 * per-point step — run on the same frames, anchors and keyframe curves. The
 * stored `PropagationConstraint` then selects per control point which result
 * survives:
 *
 * - scope `interval`  -> every point uses the single uniform `mode`;
 * - scope `segment`   -> the point starting segment `i` uses
 *   `constraint.segmentModes[points[i].id]`, i.e. the model is chosen locally
 *   by contour segment rather than once between the keyframes.
 *
 * The joint step's own motion model is always carried forward because it is the
 * shape prior the joint points depend on. Independent points feed nothing back
 * into that vote, so an independent segment cannot drag the joint shape.
 */

export interface HybridStepOptions {
  prev: GrayFrame;
  curr: GrayFrame;
  prevContour: Contour;
  params: TrackingParams;
  trustedIds: Set<string>;
  untrustedIds?: Set<string>;
  templates?: Map<string, PointTemplate>;
  templateThreshold?: number;
  occludedIds?: Set<string>;
  templateRecover?: number;
  templateRotation?: number;
  motion?: MotionModel;
  constraint?: PropagationConstraint;
}

export interface HybridStepResult {
  points: ControlPoint[];
  evidence: PointEvidence[];
  motion: MotionModel;
  trustedCount: number;
  /** Mode actually used per control-point id. */
  modeById: Map<string, PropagationMode>;
}

const DEFAULT_MODE: PropagationMode = 'joint';

/** Resolve the mode for the point starting segment `index`. */
export function modeForPoint(
  constraint: PropagationConstraint | undefined,
  pointId: string,
): { mode: PropagationMode; locallySelected: boolean } {
  if (!constraint) return { mode: DEFAULT_MODE, locallySelected: false };
  if (constraint.scope === 'interval') {
    return { mode: constraint.mode, locallySelected: false };
  }
  const segmentMode = constraint.segmentModes[pointId];
  if (segmentMode) return { mode: segmentMode, locallySelected: segmentMode !== constraint.mode };
  return { mode: constraint.mode, locallySelected: false };
}

export function hybridStep(opts: HybridStepOptions): HybridStepResult {
  const joint: StepResult = trackStep({
    prev: opts.prev,
    curr: opts.curr,
    prevContour: opts.prevContour,
    params: opts.params,
    trustedIds: opts.trustedIds,
    untrustedIds: opts.untrustedIds,
    templates: opts.templates,
    templateThreshold: opts.templateThreshold,
    occludedIds: opts.occludedIds,
    templateRecover: opts.templateRecover,
    templateRotation: opts.templateRotation,
    motion: opts.motion,
  });

  const independent = trackStepIndependent({
    prev: opts.prev,
    curr: opts.curr,
    prevContour: opts.prevContour,
    params: opts.params,
    trustedIds: opts.trustedIds,
    untrustedIds: opts.untrustedIds,
    templates: opts.templates,
    templateThreshold: opts.templateThreshold,
    occludedIds: opts.occludedIds,
    templateRecover: opts.templateRecover,
  });

  const n = opts.prevContour.points.length;
  const points: ControlPoint[] = new Array(n);
  const evidence: PointEvidence[] = new Array(n);
  const modeById = new Map<string, PropagationMode>();
  const indepById = new Map(independent.points.map((p, i) => [p.id, { point: p, ev: independent.evidence[i] }]));

  for (let i = 0; i < n; i++) {
    const base = joint.points[i];
    const { mode, locallySelected } = modeForPoint(opts.constraint, base.id);
    modeById.set(base.id, mode);
    if (mode === 'independent') {
      const chosen = indepById.get(base.id);
      if (chosen) {
        points[i] = { ...chosen.point };
        evidence[i] = { ...chosen.ev, propagationMode: 'independent', locallySelected };
        continue;
      }
    }
    points[i] = { ...base };
    evidence[i] = { ...joint.evidence[i], propagationMode: 'joint', locallySelected };
  }

  return { points, evidence, motion: joint.motion, trustedCount: joint.trustedCount, modeById };
}
