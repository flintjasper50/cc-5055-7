import { useEffect, useRef, useState } from 'react';
import { generateScene, scenarioConfig, type ScenarioName, type SyntheticClip } from '../bench/synth';
import type { Contour, GrayFrame } from '../core/types';

export type { SyntheticClip };

export interface ClipState {
  clip: SyntheticClip | null;
  loading: boolean;
  error: string | null;
}

/** A keyframe contour built from the scene's ground truth. Used both for the
 * initial demo keyframe and for the "load truth" button. */
export function truthContour(clip: SyntheticClip, frame: number, initialCount?: number): Contour {
  const truth = clip.truth[frame];
  const pts = truth.controlPoints.map((p, i) => ({ id: `p${i}`, x: p.x, y: p.y }));
  return { points: pts.slice(0, initialCount ?? pts.length), closed: true };
}

export const SCENARIO_LABELS: Record<ScenarioName, string> = {
  rotation: 'Rotation',
  deformation: 'Deformation',
  occlusion: 'Partial occlusion',
  combined: 'Combined',
  'weak-edge': 'Weak edge / low texture',
  'local-occlusion': 'Local occlusion',
};

export const SCENARIO_ORDER: ScenarioName[] = [
  'rotation',
  'deformation',
  'occlusion',
  'combined',
  'weak-edge',
  'local-occlusion',
];

/**
 * Generates a deterministic synthetic clip in-browser and keeps its luma
 * frames accessible to the interval runner. Generation is synchronous and
 * takes ~1 s; it runs once per scenario on the next macrotask so the loading
 * state can paint.
 */
export function useSyntheticClip(name: ScenarioName): ClipState {
  const [state, setState] = useState<ClipState>({ clip: null, loading: true, error: null });
  const token = useRef(0);

  useEffect(() => {
    const id = ++token.current;
    setState({ clip: null, loading: true, error: null });
    const timer = setTimeout(() => {
      try {
        const clip = generateScene(scenarioConfig(name));
        if (token.current !== id) return;
        setState({ clip, loading: false, error: null });
      } catch (err) {
        if (token.current !== id) return;
        setState({ clip: null, loading: false, error: String(err) });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [name]);

  return state;
}

// ------------------------------------------------------------ frame store ----

/** Wrap the clip's luma frames in the async reader shape the engine expects. */
export function clipReader(clip: SyntheticClip) {
  return async (frame: number): Promise<GrayFrame | undefined> => clip.gray[frame];
}

/** Render a GrayFrame into an RGBA ImageData for the canvas background. */
export function grayToImageData(frame: GrayFrame): ImageData {
  const out = new ImageData(frame.width, frame.height);
  const src = frame.data;
  const dst = out.data;
  for (let i = 0, j = 0; i < src.length; i++, j += 4) {
    const g = src[i];
    dst[j] = g;
    dst[j + 1] = g;
    dst[j + 2] = g;
    dst[j + 3] = 255;
  }
  return out;
}

/**
 * Draw the clip's RGB preview (with occluders and colour tint) into a canvas.
 * Frames are pre-rendered RGBA buffers, so this is a straight putImageData.
 */
export function rgbToImageData(width: number, height: number, rgb: Uint8ClampedArray): ImageData {
  const out = new ImageData(width, height);
  out.data.set(rgb);
  return out;
}
