import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CanvasView, type EditTool } from './CanvasView';
import { useSyntheticClip, SCENARIO_LABELS, SCENARIO_ORDER, truthContour } from './useSyntheticClip';
import { useTrackSession } from './useTrackSession';
import { viewFrameAt } from '../core/project';
import { sampleContour } from '../core/spline';
import type { ScenarioName, SyntheticClip } from '../bench/synth';
import type { AutoFrameResult, Contour, PointEvidence, ResolvedPoint, SegmentDiagnostic } from '../core/types';
import { newId } from '../core/ids';

export function App() {
  const [scenario, setScenario] = useState<ScenarioName>('occlusion');
  const { clip, loading, error } = useSyntheticClip(scenario);

  return (
    <div className="app">
      <header className="topbar">
        <h1>Rotoscope Contour Tracker</h1>
        <div className="scenario-picker">
          <label htmlFor="scenario">Synthetic clip</label>
          <select id="scenario" value={scenario} onChange={(e) => setScenario(e.target.value as ScenarioName)}>
            {SCENARIO_ORDER.map((s) => (
              <option key={s} value={s}>
                {SCENARIO_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <p className="tagline">
          Contour control data — not an alpha matte. Inferred points are labelled; they are not claimed to be
          edge-accurate.
        </p>
      </header>

      {loading && <div className="status loading">Generating synthetic clip… (≈1s)</div>}
      {error && <div className="status error">Failed to generate clip: {error}</div>}
      {clip && <Workbench key={scenario} clip={clip} />}
    </div>
  );
}

function Workbench({ clip }: { clip: SyntheticClip }) {
  const session = useTrackSession(clip);
  const [frame, setFrame] = useState(0);
  const [tool, setTool] = useState<EditTool>('move');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(true);
  const [showNormals, setShowNormals] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [draft, setDraft] = useState<Contour | null>(null);
  const [touched, setTouched] = useState<Set<string>>(() => new Set());
  const draftRef = useRef<{ frame: number; contour: Contour } | null>(null);

  const view = viewFrameAt(session.track, frame);

  // Reset any in-progress edit when the frame changes.
  useEffect(() => {
    setDraft(null);
    setTouched(new Set());
    draftRef.current = null;
    setSelectedId(null);
  }, [frame]);

  useEffect(() => {
    if (!playing) return;
    if (frame >= clip.frameCount - 1) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setFrame((f) => Math.min(clip.frameCount - 1, f + 1)), 90);
    return () => clearTimeout(t);
  }, [playing, frame, clip.frameCount]);

  const contour = draft ?? view.contour;

  const mergedEvidence = useMemo<PointEvidence[] | undefined>(() => {
    const auto = view.auto;
    if (!auto) return undefined;
    return evidenceAligned(auto, view.contour);
  }, [view.auto, view.contour]);

  const commit = useCallback(
    (next: Contour, touchedIds: Set<string>) => {
      if (next.points.length < 3) return;
      const noKeyframes = Object.keys(session.track.keyframes).length === 0;
      if (view.method === 'keyframe' || noKeyframes) {
        // The first contour drawn on an empty track is that track's first
        // keyframe; editing an existing keyframe updates it in place.
        session.addKeyframe(frame, next);
      } else {
        // Editing an interpolated frame, a manual frame, or a frame with no
        // data creates/updates a manual correction anchor at this frame.
        session.addManualCorrection(frame, next, [...touchedIds]);
      }
    },
    [frame, session, view.method],
  );

  const onDrag = useCallback(
    (id: string, p: { x: number; y: number }) => {
      const base = draftRef.current?.frame === frame ? draftRef.current.contour : contour;
      if (base.points.length === 0) return;
      const next: Contour = {
        ...base,
        points: base.points.map((pt) => (pt.id === id ? { ...pt, x: p.x, y: p.y } : pt)),
      };
      draftRef.current = { frame, contour: next };
      setDraft(next);
      setTouched((prev) => new Set(prev).add(id));
    },
    [contour, frame],
  );

  const onDragEnd = useCallback(() => {
    const d = draftRef.current;
    if (!d || d.frame !== frame) return;
    commit(d.contour, touched);
  }, [commit, frame, touched]);

  const onAddAt = useCallback(
    (p: { x: number; y: number }) => {
      if (contour.points.length < 2) return;
      const insert = insertionPoint(contour, p);
      if (!insert) return;
      const next: Contour = {
        ...contour,
        points: [
          ...contour.points.slice(0, insert.index),
          { id: newId('p'), x: p.x, y: p.y },
          ...contour.points.slice(insert.index),
        ],
      };
      const id = next.points[insert.index].id;
      draftRef.current = { frame, contour: next };
      setDraft(next);
      setTouched((prev) => new Set(prev).add(id));
      setSelectedId(id);
      commit(next, new Set([...touched, id]));
    },
    [contour, commit, frame, touched],
  );

  const onDeletePoint = useCallback(
    (id: string) => {
      if (contour.points.length <= 3) return;
      const next: Contour = { ...contour, points: contour.points.filter((p) => p.id !== id) };
      draftRef.current = { frame, contour: next };
      setDraft(next);
      setSelectedId(null);
      commit(next, touched);
    },
    [contour, commit, frame, touched],
  );

  const onDrawClosed = useCallback(
    (points: { x: number; y: number }[]) => {
      const next: Contour = {
        closed: true,
        points: points.map((p) => ({ id: newId('p'), x: p.x, y: p.y })),
      };
      draftRef.current = { frame, contour: next };
      setDraft(next);
      setTouched(new Set(next.points.map((p) => p.id)));
      commit(next, new Set(next.points.map((p) => p.id)));
      setTool('move');
    },
    [commit, frame],
  );

  const loadTruthKeyframe = useCallback(
    (f: number) => {
      session.addKeyframe(f, truthContour(clip, f));
      setFrame(f);
    },
    [clip, session],
  );

  const autoKeyframes = useCallback(() => {
    const a = 0;
    const b = Math.floor((clip.frameCount - 1) / 2);
    const c = clip.frameCount - 1;
    session.addKeyframe(a, truthContour(clip, a));
    session.addKeyframe(b, truthContour(clip, b));
    session.addKeyframe(c, truthContour(clip, c));
  }, [clip, session]);

  const layerFrames = useMemo(() => {
    const kf = Object.keys(session.track.keyframes).map(Number).sort((a, b) => a - b);
    const man = Object.keys(session.track.manual).map(Number).sort((a, b) => a - b);
    const auto = Object.keys(session.track.auto).map(Number).sort((a, b) => a - b);
    return { kf, man, auto };
  }, [session.track]);

  const suspicious = useMemo(() => {
    if (!view.segments) return [];
    return view.segments.filter((s) => s.status !== 'ok');
  }, [view.segments]);

  const stats = useMemo(() => {
    const resolved = view.resolved ?? [];
    return {
      points: contour.points.length,
      visible: resolved.filter((r) => r.visible).length,
      hidden: resolved.filter((r) => !r.visible).length,
      regularized: resolved.filter((r) => r.regularized).length,
      conflicts: resolved.filter((r) => r.conflict).length,
      segments: view.segments?.length ?? 0,
      suspicious: suspicious.length,
    };
  }, [contour.points.length, view.resolved, view.segments, suspicious.length]);

  const methodLabel = {
    keyframe: 'Keyframe',
    manual: 'Manual correction',
    auto: view.staleRevision ? 'Auto (stale — recompute)' : 'Auto propagation',
    none: 'No contour',
  }[view.method];

  return (
    <div className="workbench">
      <section className="stage-panel">
        <div className="stage-header">
          <div className="frame-controls">
            <button onClick={() => setFrame((f) => Math.max(0, f - 1))} aria-label="previous frame">
              ◀
            </button>
            <button onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Play'}</button>
            <button onClick={() => setFrame((f) => Math.min(clip.frameCount - 1, f + 1))} aria-label="next frame">
              ▶
            </button>
            <input
              type="range"
              min={0}
              max={clip.frameCount - 1}
              value={frame}
              onChange={(e) => setFrame(Number(e.target.value))}
              aria-label="frame slider"
            />
            <span className="frame-readout" data-testid="frame-readout">
              {frame} / {clip.frameCount - 1}
            </span>
          </div>
          <div className="method-badge" data-method={view.method} data-testid="method-badge">
            {methodLabel}
          </div>
        </div>

        <CanvasView
          clip={clip}
          frame={frame}
          contour={contour}
          resolved={view.resolved}
          evidence={mergedEvidence}
          segments={view.segments}
          method={view.method}
          tool={tool}
          selectedId={selectedId}
          showEvidence={showEvidence}
          showNormals={showNormals}
          onSelect={setSelectedId}
          onDrag={onDrag}
          onDragEnd={onDragEnd}
          onAddAt={onAddAt}
          onDrawClosed={onDrawClosed}
          onDeletePoint={onDeletePoint}
        />

        <div className="stage-footer">
          <div className="tool-group">
            <button
              className={tool === 'move' ? 'active' : ''}
              onClick={() => setTool('move')}
              data-testid="tool-move"
            >
              Move points
            </button>
            <button className={tool === 'add' ? 'active' : ''} onClick={() => setTool('add')} data-testid="tool-add">
              Add point
            </button>
            <button className={tool === 'draw' ? 'active' : ''} onClick={() => setTool('draw')} data-testid="tool-draw">
              Draw contour
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={showEvidence} onChange={(e) => setShowEvidence(e.target.checked)} />
            Show sampled evidence
          </label>
          <label className="check">
            <input type="checkbox" checked={showNormals} onChange={(e) => setShowNormals(e.target.checked)} />
            Show normals
          </label>
          <div className="legend">
            <span className="swatch" style={{ background: '#4ade80' }} /> observed
            <span className="swatch" style={{ background: '#94a3b8' }} /> inferred / occluded
            <span className="swatch" style={{ background: '#f87171' }} /> conflicting candidates
            <span className="swatch" style={{ background: '#facc15' }} /> weak / regularized
          </div>
        </div>
      </section>

      <aside className="side-panel">
        <section className="card">
          <h2>Propagation</h2>
          <div className="row">
            <button className="primary" onClick={autoKeyframes}>
              Add truth keyframes (start/mid/end)
            </button>
          </div>
          <div className="row">
            <button onClick={() => loadTruthKeyframe(frame)}>Keyframe from truth at {frame}</button>
          </div>
          <div className="row">
            <button className="primary" disabled={session.running} onClick={() => void session.recomputeAll()}>
              Recompute all intervals
            </button>
            <button disabled={session.running} onClick={() => void session.recomputeAround(frame)}>
              Recompute interval at {frame}
            </button>
          </div>
          <div className="row">
            <button disabled={session.running} onClick={session.clearAuto}>
              Clear automatic results
            </button>
            {session.running && <button onClick={session.cancel}>Cancel job</button>}
          </div>
          {session.running && session.progress && (
            <div className="progress" data-testid="progress">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${(100 * session.progress.done) / Math.max(1, session.progress.total)}%` }}
                />
              </div>
              <span>
                {session.progress.direction} frame {session.progress.frame} — interval{' '}
                {session.progress.intervalLeft}→{session.progress.intervalRight}
              </span>
            </div>
          )}
          {session.appliedCount > 0 && !session.running && (
            <p className="note">Applied {session.appliedCount} automatic frames this run.</p>
          )}
          {session.error && <p className="error-text">{session.error}</p>}
        </section>

        <section className="card">
          <h2>Frame state</h2>
          <dl className="stat-grid">
            <dt>Points</dt>
            <dd>{stats.points}</dd>
            <dt>Observed</dt>
            <dd data-testid="stat-visible">{stats.visible}</dd>
            <dt>Inferred</dt>
            <dd data-testid="stat-hidden">{stats.hidden}</dd>
            <dt>Regularized</dt>
            <dd>{stats.regularized}</dd>
            <dt>Conflicting</dt>
            <dd data-testid="stat-conflicts">{stats.conflicts}</dd>
            <dt>Suspicious segments</dt>
            <dd data-testid="stat-suspicious">{stats.suspicious}</dd>
          </dl>
          {view.staleRevision && (
            <p className="warn-text">
              These automatic results predate your latest edit and are shown for reference only. Recompute to
              refresh them.
            </p>
          )}
        </section>

        <section className="card">
          <h2>Layers</h2>
          <LayerList title="Keyframes" frames={layerFrames.kf} current={frame} onJump={setFrame} tone="key" />
          <LayerList title="Manual" frames={layerFrames.man} current={frame} onJump={setFrame} tone="manual" />
          <LayerList title="Automatic" frames={layerFrames.auto} current={frame} onJump={setFrame} tone="auto" dense />
          {layerFrames.man.length > 0 && (
            <button className="small" onClick={() => session.removeManual(frame)} disabled={!session.track.manual[frame]}>
              Remove manual correction at {frame}
            </button>
          )}
        </section>

        <section className="card">
          <h2>Evidence (this frame)</h2>
          {view.method === 'auto' && mergedEvidence ? (
            <EvidenceTable resolved={view.resolved ?? []} evidence={mergedEvidence} />
          ) : (
            <p className="note">
              No sampled evidence at this frame. Evidence is recorded for automatically propagated frames; move to
              an auto frame or recompute.
            </p>
          )}
        </section>

        <section className="card">
          <h2>Suspicious segments</h2>
          {suspicious.length === 0 ? (
            <p className="note">No weak, occluded, or conflicting segments reported at this frame.</p>
          ) : (
            <ul className="seg-list" data-testid="seg-list">
              {suspicious.slice(0, 24).map((s) => (
                <li key={s.index} className={`seg seg-${s.status}`}>
                  <span className="seg-index">#{s.index}</span>
                  <span className="seg-status">{s.status}</span>
                  <span className="seg-reasons">{s.reasons.join(', ')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>Parameters</h2>
          <ParamSlider
            label="Patch radius"
            value={session.track.params.patchRadius}
            min={3}
            max={12}
            step={1}
            onChange={(v) => session.setParams({ patchRadius: v })}
          />
          <ParamSlider
            label="Search radius"
            value={session.track.params.searchRadius}
            min={4}
            max={20}
            step={1}
            onChange={(v) => session.setParams({ searchRadius: v })}
          />
          <ParamSlider
            label="NCC threshold"
            value={session.track.params.nccThreshold}
            min={0.2}
            max={0.9}
            step={0.05}
            onChange={(v) => session.setParams({ nccThreshold: v })}
          />
          <ParamSlider
            label="Conflict distance (px)"
            value={session.track.params.conflictDistance}
            min={1}
            max={12}
            step={0.5}
            onChange={(v) => session.setParams({ conflictDistance: v })}
          />
        </section>
      </aside>
    </div>
  );
}

function LayerList({
  title,
  frames,
  current,
  onJump,
  tone,
  dense,
}: {
  title: string;
  frames: number[];
  current: number;
  onJump: (f: number) => void;
  tone: 'key' | 'manual' | 'auto';
  dense?: boolean;
}) {
  return (
    <div className="layer">
      <div className="layer-head">
        <span className={`layer-dot layer-${tone}`} />
        {title} <span className="layer-count">({frames.length})</span>
      </div>
      <div className={`layer-frames ${dense ? 'dense' : ''}`}>
        {frames.length === 0 && <span className="note">none</span>}
        {frames.map((f) => (
          <button key={f} className={`chip ${f === current ? 'chip-current' : ''}`} onClick={() => onJump(f)}>
            {f}
          </button>
        ))}
      </div>
    </div>
  );
}

function EvidenceTable({ resolved, evidence }: { resolved: ResolvedPoint[]; evidence: PointEvidence[] }) {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  return (
    <div className="evidence-table-wrap">
      <table className="evidence-table">
        <thead>
          <tr>
            <th>id</th>
            <th>ncc</th>
            <th>tpl</th>
            <th>edge</th>
            <th>conf</th>
            <th>state</th>
            <th>offset</th>
          </tr>
        </thead>
        <tbody>
          {resolved.map((r) => {
            const e = byId.get(r.id);
            const state = r.conflict ? 'conflict' : r.regularized || !r.visible ? 'inferred' : 'observed';
            return (
              <tr key={r.id} className={`ev-${state}`} data-conflict={r.conflict ? 'true' : 'false'}>
                <td>{r.id}</td>
                <td>{fmt(e?.ncc ?? r.ncc)}</td>
                <td>{fmt(e?.templateNcc ?? 0)}</td>
                <td>{fmt(e?.edge ?? r.edge)}</td>
                <td>{fmt(r.confidence)}</td>
                <td>{state}</td>
                <td>
                  {e ? `${e.searchOffset.x.toFixed(1)},${e.searchOffset.y.toFixed(1)}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ParamSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="param">
      <span>
        {label}: <b>{value}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return '—';
  return x.toFixed(2);
}

/**
 * Align per-point evidence to the merged resolved order by choosing, for each
 * resolved point, the sampled evidence from whichever candidate lies closest to
 * the merged position. This is the evidence that actually drove the shown point.
 */
function evidenceAligned(auto: AutoFrameResult, contour: Contour): PointEvidence[] {
  const out: PointEvidence[] = [];
  const fwdById = new Map((auto.forward?.evidence ?? []).map((e) => [e.id, e]));
  const bwdById = new Map((auto.backward?.evidence ?? []).map((e) => [e.id, e]));
  const fwdPt = new Map((auto.forward?.points ?? []).map((p) => [p.id, p]));
  const bwdPt = new Map((auto.backward?.points ?? []).map((p) => [p.id, p]));
  for (const p of contour.points) {
    const fe = fwdById.get(p.id);
    const be = bwdById.get(p.id);
    const fp = fwdPt.get(p.id);
    const bp = bwdPt.get(p.id);
    if (!fe && !be) continue;
    if (fe && be && fp && bp) {
      const df = Math.hypot(fp.x - p.x, fp.y - p.y);
      const db = Math.hypot(bp.x - p.x, bp.y - p.y);
      out.push(db < df ? be : fe);
    } else {
      out.push((fe ?? be)!);
    }
  }
  return out;
}

function insertionPoint(contour: Contour, p: { x: number; y: number }): { index: number } | null {
  if (contour.points.length < 2) return null;
  const segCount = contour.closed ? contour.points.length : contour.points.length - 1;
  const dense = sampleContour(contour.points, contour.closed, 16);
  let bestSeg = 0;
  let bestD = Infinity;
  for (let k = 0; k < dense.points.length; k++) {
    const q = dense.points[k];
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      bestSeg = dense.segmentIndex[k];
    }
  }
  // Insert after the control point that starts the closest segment.
  const index = Math.min(segCount, bestSeg + 1);
  return { index };
}

export type { SegmentDiagnostic };
