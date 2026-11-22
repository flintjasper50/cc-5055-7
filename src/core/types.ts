/**
 * Core data model.
 *
 * Coordinate convention: all contour coordinates are in *video pixels*.
 * Tracking may internally downscale frames; conversion happens at the frame
 * store boundary so stored control points always refer to the source video.
 */

export interface PointXY {
  x: number;
  y: number;
}

/** A control point. `id` is the stable identity used across every frame. */
export interface ControlPoint extends PointXY {
  id: string;
}

export interface Contour {
  points: ControlPoint[];
  closed: boolean;
}

export interface GrayFrame {
  width: number;
  height: number;
  /** Luma, one byte per pixel, row-major. */
  data: Uint8Array;
}

export type EvidenceSource = 'image' | 'similarity' | 'regularized' | 'anchor';

export interface PointEvidence {
  id: string;
  /** Normalised cross-correlation of the local patch after the best search. */
  ncc: number;
  /** Normalised max gradient magnitude along the contour normal. */
  edge: number;
  /** 0..1 fused observability score. */
  confidence: number;
  /** Whether image evidence was considered adequate at this point. */
  visible: boolean;
  /** Whether shape regularisation had to move this point away from pure image evidence. */
  regularized: boolean;
  /** Final displacement applied from the previous frame, in pixels. */
  motion: PointXY;
  /** Integer patch search offset that scored best. */
  searchOffset: PointXY;
  /** Contour normal used for the edge scan (unit vector). */
  normal: PointXY;
  /** Offset along the normal to the detected edge peak (px). */
  edgeOffset: number;
  patchRadius: number;
  searchRadius: number;
  /**
   * NCC against the *anchor* template, warped to this frame. Distinct from the
   * frame-to-frame `ncc`: a static occluder can track perfectly frame-to-frame
   * while having nothing to do with the object. This is the signal used to
   * report an occluded span as occluded.
   */
  templateNcc: number;
  source: EvidenceSource;
  hiddenReason?: 'low-ncc' | 'patch-out-of-bounds' | 'untrusted-seed' | 'template-mismatch' | 'no-transform';
}

/** An appearance template sampled from an anchor frame, in world-aligned form. */
export interface PointTemplate {
  id: string;
  /** Also anchor the patch's frame orientation so rotation can be undone. */
  radius: number;
  /** Luma patch, row-major, (2r+1)^2. */
  data: Float32Array;
  /** Mean-subtracted and unit-normalised version, for fast NCC. */
  normalised: Float32Array;
  /** Anchor position, for diagnostics. */
  x: number;
  y: number;
  /** Offset (in pixels) applied to the sample centre, e.g. inward from the edge. */
  offsetX: number;
  offsetY: number;
}

export interface Candidate {
  direction: 'forward' | 'backward';
  /** Frame of the anchor this candidate was propagated from. */
  fromFrame: number;
  points: ControlPoint[];
  evidence: PointEvidence[];
  ids: string[];
  meanConfidence: number;
}

export type SegmentStatus = 'ok' | 'weak' | 'occluded' | 'conflict' | 'regularized' | 'unmerged';

export interface SegmentDiagnostic {
  index: number;
  fromId: string;
  toId: string;
  status: SegmentStatus;
  reasons: string[];
}

export interface ResolvedPoint extends ControlPoint {
  visible: boolean;
  regularized: boolean;
  confidence: number;
  ncc: number;
  edge: number;
  conflict: boolean;
  source: EvidenceSource | 'blend';
}

export type AutoMethod = 'propagated' | 'manual' | 'keyframe';

export interface AutoFrameResult {
  frame: number;
  /** Project revision this result belongs to. Stale results are rejected. */
  revision: number;
  method: AutoMethod;
  forward?: Candidate;
  backward?: Candidate;
  resolved: ResolvedPoint[];
  segments: SegmentDiagnostic[];
  /** True when the two candidates disagree somewhere. Both are retained. */
  conflict: boolean;
  conflictCount: number;
  occludedCount: number;
  regularizedCount: number;
  /** `none` when candidates had different control-point topologies. */
  blend: 'none' | 'by-id';
  identityMismatch: boolean;
  /** Set when this frame was corrected by hand on top of the automatic layer. */
  manualCorrectionId?: string;
}

export interface AnchorFrame {
  frame: number;
  kind: 'keyframe' | 'manual';
  contour: Contour;
  /** Stable ids whose positions are authoritative (observable side only). */
  constrainedIds: string[];
}

export interface ManualCorrection {
  id: string;
  frame: number;
  createdAt: number;
  /** Full contour as corrected by the user, including rejected hidden-side edits. */
  contour: Contour;
  /** Ids that were observable at correction time; only these seed propagation. */
  constrainedIds: string[];
  /** Ids the user touched that had no observable evidence (kept, not propagated). */
  rejectedHiddenIds: string[];
}

export interface TrackingParams {
  patchRadius: number;
  searchRadius: number;
  /** NCC below this is treated as no appearance evidence (occluded/unreliable). */
  nccThreshold: number;
  /** Optional minimum edge score used in combination with NCC. */
  edgeMin: number;
  /** 0..1 strength of shape regularisation for low-evidence points. */
  shapeRegularization: number;
  /** Two candidates farther apart than this (px) are kept as a conflict. */
  conflictDistance: number;  /** Half-width in px of the normal-direction edge scan. */
  edgeSearch: number;
  /** Fraction of the detected edge offset applied to the tracked point. */
  edgeSnap: number;
  /** Sub-pixel refinement of NCC peak. */
  subpixel: boolean;
}

export const DEFAULT_PARAMS: TrackingParams = {
  patchRadius: 6,
  searchRadius: 10,
  nccThreshold: 0.55,
  edgeMin: 0.12,
  shapeRegularization: 0.65,
  // Forward and backward candidates legitimately drift apart by several px
  // over a long interval while both stay within ~2 px of the true boundary, so
  // a small threshold would flag ordinary drift as conflict. Genuine
  // disagreements (an occluded side following the occluder) are 30–50 px, so
  // this sits well above expected drift and well below a real conflict.
  conflictDistance: 6,
  edgeSearch: 4,
  edgeSnap: 0.7,
  subpixel: true,
};

export interface Track {
  id: string;
  name: string;
  color: string;
  /** Original user keyframes. Never rewritten by propagation. */
  keyframes: Record<number, Contour>;
  /** Manual corrections layer, independent from keyframes and auto results. */
  manual: Record<number, ManualCorrection>;
  /** Automatic propagation layer. */
  auto: Record<number, AutoFrameResult>;
  params: TrackingParams;
  /** Bumped on every edit; used to reject stale background results. */
  revision: number;
}

export interface ProjectState {
  version: 1;
  videoName: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  tracks: Track[];
  selectedTrackId: string | null;
}

export interface ProgressInfo {
  done: number;
  total: number;
  frame: number;
  direction: 'forward' | 'backward' | 'merge';
}

export interface TrackJobResult {
  frame: number;
  forward?: Candidate;
  backward?: Candidate;
  merged: Omit<AutoFrameResult, 'revision'>;
}
