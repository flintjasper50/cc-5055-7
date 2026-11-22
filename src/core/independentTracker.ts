import { matchTemplateAt, scanNormalEdge, searchPatch } from './evidence';
import { controlNormals } from './spline';
import type {
  Contour,
  ControlPoint,
  GrayFrame,
  PointEvidence,
  PointTemplate,
  TrackingParams,
} from './types';
import { v } from './vec';
import { fuseConfidenceMath } from './tracker';

/**
 * Independent control-point tracking.
 *
 * The contrasting model to the joint similarity propagation in `tracker.ts`.
 * There is no global motion vote and no shape regularisation coupling the
 * points: every control point runs its own 2-D patch search and keeps the full
 * displacement (tangential and normal). The same anchor-template gate used by
 * the joint model decides whether a point actually observes the object; a
 * point that fails it stays where it was and is reported invisible/regularized
 * rather than following an occluder. The difference is purely in how visible
 * points are allowed to move — locally and freely here, as one rigid shape
 * there.
 */

export interface IndependentStepOptions {
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
}

export interface IndependentStepResult {
  points: ControlPoint[];
  evidence: PointEvidence[];
}

function deadIndependent(
  id: string,
  normal: { x: number; y: number },
  params: TrackingParams,
  reason: PointEvidence['hiddenReason'],
): PointEvidence {
  return {
    id,
    ncc: 0,
    templateNcc: 0,
    edge: 0,
    confidence: 0,
    visible: false,
    regularized: false,
    motion: v(0, 0),
    searchOffset: v(0, 0),
    normal,
    edgeOffset: 0,
    patchRadius: params.patchRadius,
    searchRadius: params.searchRadius,
    source: 'regularized',
    hiddenReason: reason,
    propagationMode: 'independent',
    locallySelected: false,
  };
}

export function trackStepIndependent(opts: IndependentStepOptions): IndependentStepResult {
  const { prev, curr, prevContour, params, trustedIds } = opts;
  const untrusted = opts.untrustedIds ?? new Set<string>();
  const normals = controlNormals(prevContour.points, prevContour.closed);
  const templateThreshold = opts.templateThreshold ?? 0.5;

  const points: ControlPoint[] = new Array(prevContour.points.length);
  const evidence: PointEvidence[] = new Array(prevContour.points.length);

  for (let i = 0; i < prevContour.points.length; i++) {
    const point = prevContour.points[i];
    const normal = normals[i] ?? v(1, 0);

    if (!trustedIds.has(point.id) || untrusted.has(point.id)) {
      points[i] = { ...point };
      evidence[i] = deadIndependent(point.id, normal, params, 'untrusted-seed');
      continue;
    }

    // Local 2-D search over the full disc: unlike the joint step the tangential
    // component is retained, so a point can follow a local boundary that
    // deforms relative to the rest of the contour.
    const search = searchPatch(
      prev,
      curr,
      point,
      params.patchRadius,
      params.searchRadius,
      params.subpixel,
    );
    const candidate = v(point.x + search.dx, point.y + search.dy);
    const template = opts.templates?.get(point.id);
    const templateNcc = template
      ? matchTemplateAt(curr, template, candidate, 0)
      : 1;

    const wasOccluded = opts.occludedIds?.has(point.id) ?? false;
    const effectiveThreshold = wasOccluded
      ? Math.max(templateThreshold, opts.templateRecover ?? 0.72)
      : templateThreshold;
    const templateOk = templateNcc >= effectiveThreshold;

    const edgeScan = scanNormalEdge(curr, candidate, normal, params.edgeSearch, 0.5);

    if (!templateOk || search.outOfBounds || search.ncc < params.nccThreshold) {
      // No trustworthy local observation. The independent model has no global
      // prediction to coast on, so the point holds its previous position and is
      // honestly labelled inferred — never snapped onto a tempting edge.
      points[i] = { id: point.id, x: point.x, y: point.y };
      evidence[i] = {
        id: point.id,
        ncc: search.ncc,
        templateNcc,
        edge: edgeScan.edge,
        confidence: Math.min(0.22, fuseConfidenceMath(search.ncc, edgeScan.edge, params.edgeMin) * 0.35),
        visible: false,
        regularized: true,
        motion: v(0, 0),
        searchOffset: v(search.dx, search.dy),
        normal,
        edgeOffset: 0,
        patchRadius: params.patchRadius,
        searchRadius: params.searchRadius,
        source: 'regularized',
        hiddenReason: !templateOk ? 'template-mismatch' : search.outOfBounds ? 'patch-out-of-bounds' : 'low-ncc',
        propagationMode: 'independent',
        locallySelected: false,
      };
      continue;
    }

    // Full 2-D local displacement, nudged along the normal by a confirming edge.
    let nx = candidate.x;
    let ny = candidate.y;
    let edgeOffset = 0;
    if (edgeScan.edge >= params.edgeMin) {
      edgeOffset = edgeScan.edgeOffset * params.edgeSnap;
      nx += normal.x * edgeOffset;
      ny += normal.y * edgeOffset;
    }

    const confidence = Math.min(
      1,
      fuseConfidenceMath(search.ncc, edgeScan.edge, params.edgeMin) *
        (template ? 0.35 + 0.65 * Math.max(0, templateNcc) : 1),
    );
    const visible = search.ncc >= params.nccThreshold * 0.6 && (!template || templateNcc >= templateThreshold);

    points[i] = { id: point.id, x: nx, y: ny };
    evidence[i] = {
      id: point.id,
      ncc: search.ncc,
      templateNcc,
      edge: edgeScan.edge,
      confidence,
      visible,
      regularized: !visible,
      motion: v(nx - point.x, ny - point.y),
      searchOffset: v(search.dx, search.dy),
      normal,
      edgeOffset,
      patchRadius: params.patchRadius,
      searchRadius: params.searchRadius,
      source: visible ? 'image' : 'similarity',
      hiddenReason: visible ? undefined : 'low-ncc',
      propagationMode: 'independent',
      locallySelected: false,
    };
  }

  return { points, evidence };
}
