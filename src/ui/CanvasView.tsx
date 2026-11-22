import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sampleContour } from '../core/spline';
import type { Contour, PointEvidence, ResolvedPoint, SegmentDiagnostic } from '../core/types';
import { dist } from '../core/vec';
import {
  arrow,
  drawEmptyState,
  fitView,
  marker,
  THEME,
  toCanvas,
  toVideo,
  type ViewTransform,
} from './overlay';
import { rgbToImageData } from './useSyntheticClip';
import type { SyntheticClip } from '../bench/synth';

export type EditTool = 'move' | 'add' | 'draw';

/**
 * Resample a freehand closed stroke into an evenly spaced control polygon. The
 * point count is bounded so a long scribble does not create hundreds of control
 * points; the result keeps the drawn shape while staying editable.
 */
function simplifyClosed(path: { x: number; y: number }[], maxPoints: number): { x: number; y: number }[] {
  if (path.length < 3) return [];
  // Cumulative arc length around the closed loop.
  const pts = [...path, path[0]];
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const total = cum[cum.length - 1];
  if (total < 12) return [];
  const count = Math.max(4, Math.min(maxPoints, Math.round(total / 12)));
  const out: { x: number; y: number }[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / count) * total;
    while (seg < pts.length - 2 && cum[seg + 1] < target) seg++;
    const span = cum[seg + 1] - cum[seg] || 1;
    const t = (target - cum[seg]) / span;
    out.push({
      x: pts[seg].x + (pts[seg + 1].x - pts[seg].x) * t,
      y: pts[seg].y + (pts[seg + 1].y - pts[seg].y) * t,
    });
  }
  return out;
}

export interface CanvasViewProps {
  clip: SyntheticClip;
  frame: number;
  contour: Contour;
  resolved?: ResolvedPoint[];
  evidence?: PointEvidence[];
  segments?: SegmentDiagnostic[];
  method: 'keyframe' | 'manual' | 'auto' | 'none';
  tool: EditTool;
  selectedId: string | null;
  showEvidence: boolean;
  showNormals: boolean;
  onSelect: (id: string | null) => void;
  onDrag: (id: string, point: { x: number; y: number }) => void;
  onDragEnd: () => void;
  onAddAt: (point: { x: number; y: number }) => void;
  onDrawClosed: (points: { x: number; y: number }[]) => void;
  onDeletePoint: (id: string) => void;
}

interface Size {
  width: number;
  height: number;
}

export function CanvasView(props: CanvasViewProps) {
  const {
    clip,
    frame,
    contour,
    resolved,
    evidence,
    segments,
    method,
    tool,
    selectedId,
    showEvidence,
    showNormals,
    onSelect,
    onDrag,
    onDragEnd,
    onAddAt,
    onDrawClosed,
    onDeletePoint,
  } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const dragRef = useRef<{ id: string } | null>(null);
  const drawRef = useRef<{ x: number; y: number }[] | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      setSize({ width: Math.floor(box.width), height: Math.floor(box.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const view: ViewTransform = useMemo(
    () => fitView(clip.width, clip.height, size.width, size.height, 8),
    [clip.width, clip.height, size.width, size.height],
  );

  const resolvedById = useMemo(() => new Map((resolved ?? []).map((r) => [r.id, r])), [resolved]);
  const evidenceById = useMemo(() => new Map((evidence ?? []).map((e) => [e.id, e])), [evidence]);

  // Cache the frame image so we don't rebuild RGBA every render.
  const frameImage = useRef<{ frame: number; data: ImageData } | null>(null);
  const getFrameImage = useCallback((): ImageData | null => {
    if (size.width === 0) return null;
    const cached = frameImage.current;
    if (cached && cached.frame === frame && cached.data.width === clip.width) return cached.data;
    const data = rgbToImageData(clip.width, clip.height, clip.rgb[frame]);
    frameImage.current = { frame, data };
    return data;
  }, [clip, frame, size.width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);

    // Background video frame.
    const img = getFrameImage();
    if (img) {
      const tmp = document.createElement('canvas');
      tmp.width = clip.width;
      tmp.height = clip.height;
      tmp.getContext('2d')?.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tmp, view.offsetX, view.offsetY, clip.width * view.scale, clip.height * view.scale);
    }
    ctx.strokeStyle = 'rgba(148,163,184,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(view.offsetX, view.offsetY, clip.width * view.scale, clip.height * view.scale);

    if (contour.points.length === 0) {
      drawEmptyState(ctx, view, 'Add a keyframe, or load the synthetic truth contour');
      return;
    }

    // Evaluated spline, colored per segment by its diagnostic status. This is
    // the *real* curve, not the control polygon, and suspicious spans are
    // visibly flagged rather than reported as accurate.
    const dense = sampleContour(contour.points, contour.closed, 14);
    const statusBySeg = new Map<number, SegmentDiagnostic>();
    for (const s of segments ?? []) statusBySeg.set(s.index, s);

    const strokeFor = (index: number): { color: string; width: number; dash: number[] } => {
      const status = statusBySeg.get(index)?.status;
      if (status === 'conflict') return { color: THEME.contourConflict, width: 2, dash: [] };
      if (status === 'occluded') return { color: THEME.contourOccluded, width: 1.5, dash: [5, 4] };
      if (status === 'weak') return { color: THEME.contourWeak, width: 1.5, dash: [7, 3] };
      if (status === 'regularized') return { color: THEME.contourWeak, width: 1.5, dash: [2, 3] };
      if (method === 'manual') return { color: THEME.contourManual, width: 2, dash: [] };
      if (method === 'keyframe') return { color: THEME.contourKey, width: 2, dash: [] };
      return { color: THEME.contour, width: 2, dash: [] };
    };

    let current = -1;
    let path: Path2D | null = null;
    const flush = () => {
      if (!path) return;
      const st = strokeFor(current);
      ctx.setLineDash(st.dash);
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.width;
      ctx.stroke(path);
      ctx.setLineDash([]);
      path = null;
    };
    for (let k = 0; k < dense.points.length; k++) {
      const segIndex = dense.segmentIndex[k];
      const c = toCanvas(view, dense.points[k]);
      if (segIndex !== current) {
        flush();
        current = segIndex;
        path = new Path2D();
        path.moveTo(c.x, c.y);
      } else {
        path!.lineTo(c.x, c.y);
      }
    }
    if (contour.closed && dense.points.length > 0) {
      const first = toCanvas(view, dense.points[0]);
      path?.lineTo(first.x, first.y);
    }
    flush();

    // Evidence: contour normals and the actual normal-direction / search
    // offsets that were sampled this frame. This shows *what the tracker saw*,
    // including on points it could not observe.
    if (showEvidence) {
      for (const p of contour.points) {
        const ev = evidenceById.get(p.id);
        if (!ev) continue;
        const c = toCanvas(view, p);
        const color = ev.visible ? THEME.evidence : THEME.evidenceLow;
        if (showNormals && (ev.normal.x !== 0 || ev.normal.y !== 0)) {
          const tip = toCanvas(view, { x: p.x + ev.normal.x * 10, y: p.y + ev.normal.y * 10 });
          ctx.strokeStyle = ev.visible ? THEME.normal : THEME.normalHidden;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(tip.x, tip.y);
          ctx.stroke();
        }
        // Search offset: where the patch actually matched.
        const off = ev.searchOffset;
        if (Math.abs(off.x) > 0.75 || Math.abs(off.y) > 0.75) {
          const tip = toCanvas(view, { x: p.x + off.x, y: p.y + off.y });
          arrow(ctx, c.x, c.y, tip.x - c.x, tip.y - c.y, color);
        }
      }
    }

    // Control points. Hidden/regularized points are hollow; conflicts get a
    // red ring; the selected point is highlighted.
    for (const p of contour.points) {
      const c = toCanvas(view, p);
      const res = resolvedById.get(p.id);
      const hidden = res ? !res.visible : false;
      const conflict = res?.conflict ?? false;
      const selected = p.id === selectedId;
      const r = selected ? 5.5 : 4;
      if (hidden) {
        marker(ctx, c.x, c.y, r, 'rgba(11,18,32,0.9)', THEME.controlPointHidden);
      } else {
        marker(ctx, c.x, c.y, r, THEME.controlPoint, 'rgba(11,18,32,0.9)');
      }
      if (conflict) marker(ctx, c.x, c.y, r + 3, 'rgba(0,0,0,0)', THEME.contourConflict);
      if (selected) marker(ctx, c.x, c.y, r + 3, 'rgba(0,0,0,0)', THEME.controlPointSelected);
    }
  }, [
    size,
    clip,
    frame,
    contour,
    segments,
    method,
    selectedId,
    showEvidence,
    showNormals,
    view,
    getFrameImage,
    resolvedById,
    evidenceById,
  ]);

  const pointerToVideo = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return toVideo(view, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const hitTolerance = 9 / view.scale;

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    const v = pointerToVideo(e);
    if (!v) return;
    if (tool === 'draw') {
      drawRef.current = [v];
      return;
    }
    if (tool === 'add') {
      onAddAt(v);
      return;
    }
    let best: { id: string; d: number } | null = null;
    for (const p of contour.points) {
      const d = dist(p, v);
      if (d <= hitTolerance && (!best || d < best.d)) best = { id: p.id, d };
    }
    if (best) {
      onSelect(best.id);
      dragRef.current = { id: best.id };
    } else {
      onSelect(null);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawRef.current) {
      const v = pointerToVideo(e);
      if (!v) return;
      const last = drawRef.current[drawRef.current.length - 1];
      if (Math.hypot(v.x - last.x, v.y - last.y) >= 3 / view.scale) drawRef.current.push(v);
      return;
    }
    const drag = dragRef.current;
    if (!drag) return;
    const v = pointerToVideo(e);
    if (!v) return;
    onDrag(drag.id, v);
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (drawRef.current) {
      const path = drawRef.current;
      drawRef.current = null;
      const closed = simplifyClosed(path, 14);
      if (closed.length >= 3) onDrawClosed(closed);
    }
    if (dragRef.current) {
      dragRef.current = null;
      onDragEnd();
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      e.preventDefault();
      onDeletePoint(selectedId);
    }
  };

  return (
    <div ref={wrapRef} className="canvas-wrap">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className={`stage stage-${tool}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
