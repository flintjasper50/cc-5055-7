import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { runInterval, type AnchorSeed } from '../core/engine';
import {
  anchorAt,
  anchorFrames,
  applyAutoResult,
  applyManualCorrection,
  bumpRevision,
  clearAllAuto,
  clearIntervalConstraint,
  clearSegmentConstraint,
  constraintForInterval,
  emptyTrack,
  keyframeFrames,
  intervalFor,
  removeManualCorrection,
  setIntervalConstraint,
  setKeyframe,
  setSegmentConstraint,
  viewFrameAt,
} from '../core/project';
import {
  DEFAULT_PARAMS,
  type Contour,
  type ProjectState,
  type PropagationMode,
  type Track,
  type TrackingParams,
} from '../core/types';
import { parseProject, serializeProject } from '../core/persistence';
import type { SyntheticClip } from '../bench/synth';
import { clipReader } from './useSyntheticClip';

export interface JobProgress {
  done: number;
  total: number;
  frame: number;
  direction: string;
  intervalLeft: number;
  intervalRight: number;
}

export interface SessionState {
  track: Track;
  running: boolean;
  progress: JobProgress | null;
  error: string | null;
  appliedCount: number;
}

export interface SessionApi extends SessionState {
  setParams: (patch: Partial<TrackingParams>) => void;
  addKeyframe: (frame: number, contour: Contour) => void;
  removeKeyframe: (frame: number) => void;
  addManualCorrection: (frame: number, contour: Contour, touchedIds: string[]) => void;
  removeManual: (frame: number) => void;
  clearAuto: () => void;
  recomputeAll: () => Promise<void>;
  recomputeAround: (frame: number) => Promise<void>;
  cancel: () => void;
  chooseIntervalMode: (left: number, right: number, mode: PropagationMode) => void;
  chooseSegmentMode: (
    left: number,
    right: number,
    segmentStartId: string,
    mode: PropagationMode,
    reason: string,
  ) => void;
  clearSegmentMode: (left: number, right: number, segmentStartId: string) => void;
  clearConstraint: (left: number, right: number) => void;
  constraintAt: (left: number, right: number) => Track['constraints'][number] | undefined;
  saveProject: () => string;
  reopenProject: (text: string) => void;
}

function seedFor(track: Track, frame: number): AnchorSeed | null {
  const anchor = anchorAt(track, frame);
  if (!anchor) return null;
  const manual = track.manual[frame];
  return {
    frame,
    contour: anchor.contour,
    constrainedIds: anchor.constrainedIds,
    rejectedIds: manual ? manual.rejectedHiddenIds : [],
  };
}

/**
 * Owns the tracked layers and the propagation jobs.
 *
 * The critical safety property: a job captures `track.revision` when it starts,
 * and every streamed result is written through `applyAutoResult`, which rejects
 * stale revisions. A manual correction bumps the revision, so a background job
 * that is still running cannot overwrite the user's fix. Jobs additionally
 * poll `shouldAbort`, which stops them promptly.
 */
export function useTrackSession(clip: SyntheticClip | null): SessionApi {
  const [track, setTrack] = useState<Track>(() => emptyTrack('Object 1', '#4ade80', DEFAULT_PARAMS));
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appliedCount, setAppliedCount] = useState(0);

  const trackRef = useRef(track);
  trackRef.current = track;
  const cancelledRef = useRef(false);
  const jobToken = useRef(0);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const readFrame = useMemo(() => (clip ? clipReader(clip) : async () => undefined), [clip]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
  }, []);

  const runOneInterval = useCallback(
    async (left: number, right: number): Promise<void> => {
      const current = trackRef.current;
      const capturedRevision = current.revision;
      const leftSeed = seedFor(current, left);
      const rightSeed = seedFor(current, right);
      if (!leftSeed || !rightSeed) return;
      if (right - left < 2) return;

      const token = ++jobToken.current;
      cancelledRef.current = false;
      const constraint = constraintForInterval(current, left, right);

      await runInterval({
        left: leftSeed,
        right: rightSeed,
        params: { ...current.params },
        readFrame,
        revision: capturedRevision,
        constraint,
        shouldAbort: () => cancelledRef.current || jobToken.current !== token,
        yieldFn: () => new Promise<void>((r) => setTimeout(r, 0)),
        onProgress: (p) => {
          if (jobToken.current !== token) return;
          setProgress({
            done: p.done,
            total: p.total,
            frame: p.frame,
            direction: p.direction,
            intervalLeft: left,
            intervalRight: right,
          });
        },
        onFrame: (result) => {
          if (jobToken.current !== token) return;
          setTrack((prev) => {
            const applied = applyAutoResult(prev, capturedRevision, result.merged);
            if (applied.accepted) setAppliedCount((c) => c + 1);
            return applied.track;
          });
        },
      });
    },
    [readFrame],
  );

  const recomputeAll = useCallback(async () => {
    if (!clip) return;
    const frames = anchorFrames(trackRef.current);
    if (frames.length < 2) {
      setError('Add at least two keyframes before propagating.');
      return;
    }
    setError(null);
    setRunning(true);
    setAppliedCount(0);
    cancelledRef.current = false;
    try {
      for (let i = 0; i < frames.length - 1; i++) {
        if (cancelledRef.current) break;
        await runOneInterval(frames[i], frames[i + 1]);
        if (cancelledRef.current) break;
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [clip, runOneInterval]);

  const recomputeAround = useCallback(
    async (frame: number) => {
      if (!clip) return;
      const interval = intervalFor(trackRef.current, frame);
      if (!interval) {
        setError('This frame is an anchor; pick an interpolated frame or add another keyframe.');
        return;
      }
      setError(null);
      setRunning(true);
      setAppliedCount(0);
      cancelledRef.current = false;
      try {
        await runOneInterval(interval.left, interval.right);
      } catch (err) {
        setError(String(err));
      } finally {
        setRunning(false);
        setProgress(null);
      }
    },
    [clip, runOneInterval],
  );

  const setParams = useCallback((patch: Partial<TrackingParams>) => {
    setTrack((prev) => ({ ...prev, params: { ...prev.params, ...patch }, revision: prev.revision + 1 }));
  }, []);

  const addKeyframe = useCallback((frame: number, contour: Contour) => {
    setTrack((prev) => {
      const withKf = setKeyframe({ ...prev, manual: omitManual(prev.manual, frame) }, frame, contour);
      return withKf;
    });
  }, []);

  const removeKeyframe = useCallback((frame: number) => {
    setTrack((prev) => {
      if (!prev.keyframes[frame]) return prev;
      const keyframes = { ...prev.keyframes };
      delete keyframes[frame];
      const next: Track = { ...prev, keyframes };
      return bumpRevision(next);
    });
  }, []);

  const addManualCorrection = useCallback((frame: number, contour: Contour, touchedIds: string[]) => {
    setTrack((prev) => applyManualCorrection(prev, frame, contour, touchedIds));
  }, []);

  const removeManual = useCallback((frame: number) => {
    setTrack((prev) => removeManualCorrection(prev, frame));
  }, []);

  const clearAuto = useCallback(() => {
    setTrack((prev) => bumpRevision(clearAllAuto(prev)));
  }, []);

  const chooseIntervalMode = useCallback((left: number, right: number, mode: PropagationMode) => {
    setTrack((prev) => setIntervalConstraint(prev, left, right, mode));
  }, []);

  const chooseSegmentMode = useCallback(
    (left: number, right: number, segmentStartId: string, mode: PropagationMode, reason: string) => {
      setTrack((prev) => setSegmentConstraint(prev, left, right, segmentStartId, mode, reason));
    },
    [],
  );

  const clearSegmentMode = useCallback((left: number, right: number, segmentStartId: string) => {
    setTrack((prev) => clearSegmentConstraint(prev, left, right, segmentStartId));
  }, []);

  const clearConstraint = useCallback((left: number, right: number) => {
    setTrack((prev) => clearIntervalConstraint(prev, left, right));
  }, []);

  const constraintAt = useCallback(
    (left: number, right: number) => constraintForInterval(trackRef.current, left, right),
    [],
  );

  const saveProject = useCallback((): string => {
    const project: ProjectState = {
      version: 1,
      videoName: 'synthetic-clip',
      width: clip?.width ?? 0,
      height: clip?.height ?? 0,
      fps: clip?.fps ?? 30,
      frameCount: clip?.frameCount ?? 0,
      tracks: [trackRef.current],
      selectedTrackId: trackRef.current.id,
    };
    return serializeProject(project);
  }, [clip]);

  const reopenProject = useCallback((text: string) => {
    const project = parseProject(text);
    const first = project.tracks[0];
    if (!first) throw new Error('reopened project contains no tracks');
    jobToken.current++;
    setTrack(first);
  }, []);

  return {
    track,
    running,
    progress,
    error,
    appliedCount,
    setParams,
    addKeyframe,
    removeKeyframe,
    addManualCorrection,
    removeManual,
    clearAuto,
    recomputeAll,
    recomputeAround,
    cancel,
    chooseIntervalMode,
    chooseSegmentMode,
    clearSegmentMode,
    clearConstraint,
    constraintAt,
    saveProject,
    reopenProject,
  };
}

function omitManual(manual: Track['manual'], frame: number): Track['manual'] {
  if (!manual[frame]) return manual;
  const next = { ...manual };
  delete next[frame];
  return next;
}

export { viewFrameAt, keyframeFrames };
