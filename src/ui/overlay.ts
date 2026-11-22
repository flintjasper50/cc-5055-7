import type { Contour } from '../core/types';

export interface ViewTransform {
  /** Video pixel → canvas pixel scale factor. */
  scale: number;
  /** Video pixel coordinate that sits at canvas (0,0). */
  offsetX: number;
  offsetY: number;
  canvasWidth: number;
  canvasHeight: number;
}

export const IDENTITY_VIEW: ViewTransform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  canvasWidth: 1,
  canvasHeight: 1,
};

export function fitView(videoW: number, videoH: number, canvasW: number, canvasH: number, pad = 0): ViewTransform {
  const availW = Math.max(1, canvasW - pad * 2);
  const availH = Math.max(1, canvasH - pad * 2);
  const scale = Math.min(availW / Math.max(1, videoW), availH / Math.max(1, videoH));
  const drawnW = videoW * scale;
  const drawnH = videoH * scale;
  return {
    scale,
    offsetX: (canvasW - drawnW) / 2,
    offsetY: (canvasH - drawnH) / 2,
    canvasWidth: canvasW,
    canvasHeight: canvasH,
  };
}

export const toCanvas = (view: ViewTransform, p: { x: number; y: number }) => ({
  x: view.offsetX + p.x * view.scale,
  y: view.offsetY + p.y * view.scale,
});

export const toVideo = (view: ViewTransform, p: { x: number; y: number }) => ({
  x: (p.x - view.offsetX) / view.scale,
  y: (p.y - view.offsetY) / view.scale,
});

/** Dense Catmull–Rom samples are already computed by the spline module; this
 * only converts them to canvas space and builds a Path2D. */
export function denseToPath(dense: { x: number; y: number }[], view: ViewTransform, closed: boolean): Path2D {
  const path = new Path2D();
  if (dense.length === 0) return path;
  const first = toCanvas(view, dense[0]);
  path.moveTo(first.x, first.y);
  for (let i = 1; i < dense.length; i++) {
    const p = toCanvas(view, dense[i]);
    path.lineTo(p.x, p.y);
  }
  if (closed) path.closePath();
  return path;
}

/** Dense polyline for a contour, using the evaluated spline (not the control
 * polygon). This is what the user sees as the real curve. */
export function buildPath(
  dense: { x: number; y: number }[],
  view: ViewTransform,
  closed: boolean,
): Path2D {
  return denseToPath(dense, view, closed);
}

export interface CanvasTheme {
  contour: string;
  contourWeak: string;
  contourOccluded: string;
  contourConflict: string;
  contourManual: string;
  contourKey: string;
  contourIndependent: string;
  controlPoint: string;
  controlPointHidden: string;
  controlPointSelected: string;
  normal: string;
  normalHidden: string;
  evidence: string;
  evidenceLow: string;
  background: string;
}

export const THEME: CanvasTheme = {
  contour: '#4ade80',
  contourWeak: '#facc15',
  contourOccluded: '#94a3b8',
  contourConflict: '#f87171',
  contourManual: '#60a5fa',
  contourKey: '#34d399',
  contourIndependent: '#38bdf8',
  controlPoint: '#e2e8f0',
  controlPointHidden: '#64748b',
  controlPointSelected: '#fbbf24',
  normal: 'rgba(226,232,240,0.55)',
  normalHidden: 'rgba(148,163,184,0.4)',
  evidence: 'rgba(74,222,128,0.9)',
  evidenceLow: 'rgba(248,113,113,0.8)',
  background: '#0b1220',
};

export function drawEmptyState(ctx: CanvasRenderingContext2D, view: ViewTransform, text: string): void {
  ctx.save();
  ctx.fillStyle = 'rgba(226,232,240,0.6)';
  ctx.font = '14px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, view.canvasWidth / 2, view.canvasHeight / 2);
  ctx.restore();
}

/** Draw a small circle; used for control points and evidence dots. */
export function marker(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke?: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

/** Arrow from a point along a unit direction, for normals / search offsets. */
export function arrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dx: number,
  dy: number,
  color: string,
): void {
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + dx, y + dy);
  ctx.stroke();
  const ang = Math.atan2(dy, dx);
  const h = Math.min(5, len * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + dx, y + dy);
  ctx.lineTo(x + dx - h * Math.cos(ang - 0.4), y + dy - h * Math.sin(ang - 0.4));
  ctx.lineTo(x + dx - h * Math.cos(ang + 0.4), y + dy - h * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

export function pointContour(points: { id: string; x: number; y: number }[], closed: boolean): Contour {
  return { points: points.map((p) => ({ id: p.id, x: p.x, y: p.y })), closed };
}
