import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import { runInterval } from '../src/core/engine';
import { DEFAULT_PARAMS, type Contour, type GrayFrame, type TrackJobResult } from '../src/core/types';
import { sampleContour } from '../src/core/spline';
import { generateScene, scenarioConfig } from '../src/bench/synth';

/**
 * Renders the occlusion scenario, tracks it with the real engine, and encodes
 * two videos:
 *   demo-out/input.mp4        — the raw synthetic clip (ground truth hidden)
 *   demo-out/tracked.mp4      — the same clip with the evaluated contour overlay
 *   demo-out/side-by-side.mp4 — input and tracked stacked horizontally
 *
 * The overlay draws the actual Catmull–Rom curve that was evaluated, coloured by
 * the same per-frame diagnostics the UI shows (observed / inferred / conflict).
 * This is contour control data, not an alpha matte.
 */

const require = createRequire(import.meta.url);
const ffmpeg: string = require('ffmpeg-static');

const OUT = 'demo-out';
const FRAMES = `${OUT}/frames`;
const TRACKED = `${OUT}/tracked`;

const SCALE = 2;

function contourFrom(points: { x: number; y: number }[], ids: string[]): Contour {
  return { closed: true, points: points.map((p, i) => ({ id: ids[i], x: p.x, y: p.y })) };
}

function drawOverlay(png: PNG, contour: Contour, method: string): void {
  if (contour.points.length < 2) return;
  const dense = sampleContour(contour.points, contour.closed, 16);
  const color = method === 'auto' ? [74, 222, 128] : method === 'manual' ? [96, 165, 250] : [52, 211, 153];
  const W = png.width;
  const H = png.height;
  const plot = (x: number, y: number) => {
    const px = Math.round(x);
    const py = Math.round(y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = px + dx;
        const cy = py + dy;
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
        const o = (cy * W + cx) * 4;
        png.data[o] = color[0];
        png.data[o + 1] = color[1];
        png.data[o + 2] = color[2];
        png.data[o + 3] = 255;
      }
    }
  };
  for (let i = 0; i < dense.points.length; i++) {
    const a = dense.points[i];
    const b = dense.points[(i + 1) % dense.points.length];
    const steps = 4;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      plot(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    }
  }
  // Control points as small bright dots.
  for (const p of contour.points) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = Math.round(p.x) + dx;
        const y = Math.round(p.y) + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const o = (y * W + x) * 4;
        png.data[o] = 245;
        png.data[o + 1] = 245;
        png.data[o + 2] = 245;
        png.data[o + 3] = 255;
      }
    }
  }
  void SCALE;
}

function upscale(src: Uint8ClampedArray, w: number, h: number, factor: number): PNG {
  const png = new PNG({ width: w * factor, height: h * factor });
  for (let y = 0; y < h * factor; y++) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < w * factor; x++) {
      const sx = Math.floor(x / factor);
      const s = (sy * w + sx) * 4;
      const d = (y * w * factor + x) * 4;
      png.data[d] = src[s];
      png.data[d + 1] = src[s + 1];
      png.data[d + 2] = src[s + 2];
      png.data[d + 3] = 255;
    }
  }
  return png;
}

function encode(framesDir: string, pattern: string, out: string): void {
  execFileSync(
    ffmpeg,
    ['-y', '-framerate', '30', '-i', `${framesDir}/${pattern}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out],
    { stdio: 'ignore' },
  );
}

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  mkdirSync(TRACKED, { recursive: true });

  const cfg = scenarioConfig('occlusion');
  const clip = generateScene(cfg);
  const ids = Array.from({ length: clip.controlPointCount }, (_, i) => `p${i}`);
  const anchorA = 0;
  const anchorB = Math.floor((clip.frameCount - 1) / 2);
  const anchorC = clip.frameCount - 1;

  // Track each interval with the real engine.
  const tracked = new Map<number, { contour: Contour; method: string }>();
  for (const [left, right] of [
    [anchorA, anchorB],
    [anchorB, anchorC],
  ]) {
    await runInterval({
      left: { frame: left, contour: contourFrom(clip.truth[left].controlPoints, ids), constrainedIds: ids },
      right: { frame: right, contour: contourFrom(clip.truth[right].controlPoints, ids), constrainedIds: ids },
      params: { ...DEFAULT_PARAMS },
      readFrame: async (f: number): Promise<GrayFrame | undefined> => clip.gray[f],
      revision: 0,
      yieldFn: async () => {},
      onFrame: (r: TrackJobResult) => {
        tracked.set(r.frame, {
          contour: { closed: true, points: r.merged.resolved.map((p) => ({ id: p.id, x: p.x, y: p.y })) },
          method: 'auto',
        });
      },
    });
  }

  for (let f = 0; f < clip.frameCount; f++) {
    const input = upscale(clip.rgb[f], clip.width, clip.height, SCALE);
    writeFileSync(`${FRAMES}/in-${String(f).padStart(4, '0')}.png`, PNG.sync.write(input));

    const trackedPng = upscale(clip.rgb[f], clip.width, clip.height, SCALE);
    const anchor = clip.truth[f];
    const role =
      f === anchorA || f === anchorB || f === anchorC ? 'keyframe' : tracked.has(f) ? 'auto' : 'none';
    const contour =
      role === 'keyframe'
        ? contourFrom(anchor.controlPoints, ids)
        : tracked.get(f)?.contour ?? { closed: true, points: [] };
    const method = role === 'keyframe' ? 'keyframe' : 'auto';
    // Scale contour coordinates into the upscaled image.
    const scaled: Contour = {
      closed: true,
      points: contour.points.map((p) => ({ id: p.id, x: p.x * SCALE, y: p.y * SCALE })),
    };
    drawOverlay(trackedPng, scaled, method);
    writeFileSync(`${TRACKED}/trk-${String(f).padStart(4, '0')}.png`, PNG.sync.write(trackedPng));
  }

  encode(FRAMES, 'in-%04d.png', `${OUT}/input.mp4`);
  encode(TRACKED, 'trk-%04d.png', `${OUT}/tracked.mp4`);

  // Side-by-side: hstack the two frame sequences, then encode.
  execFileSync(
    ffmpeg,
    [
      '-y',
      '-framerate', '30', '-i', `${FRAMES}/in-%04d.png`,
      '-framerate', '30', '-i', `${TRACKED}/trk-%04d.png`,
      '-filter_complex', 'hstack=inputs=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      `${OUT}/side-by-side.mp4`,
    ],
    { stdio: 'ignore' },
  );

  rmSync(FRAMES, { recursive: true, force: true });
  rmSync(TRACKED, { recursive: true, force: true });

  console.log(`wrote ${OUT}/input.mp4, ${OUT}/tracked.mp4, ${OUT}/side-by-side.mp4`);
  console.log(
    'Note: the tracked overlay is contour control data (an evaluated spline), not a recovered alpha matte.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
