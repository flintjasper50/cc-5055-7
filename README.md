# Rotoscope Contour Tracker

A keyframed **contour** rotoscoping tool. You draw closed curves on a few
keyframes; the tool propagates the control points through the intervening frames
using local image motion and edge evidence, and stores every result in revisitable
layers.

> **Output is contour control data — not a recovered alpha matte.** The tool does
> not claim to reconstruct fine transparency or hair-level detail. When image
> evidence is weak it falls back to explicit shape regularisation, and points
> moved that way are labelled as *inferred* — never described as "snapped to the
> edge".

## What it guarantees

- **Stable control-point identity.** A control point keeps its `id` across every
  frame. Parameterisation is fixed per edit — segment `i` always spans control
  point `i → i+1` — so a point you place by hand never jumps to a different
  position on the curve between frames.
- **Both candidates retained on conflict.** Each interval is propagated
  independently *forward* and *backward* from its two anchors. Where the two
  disagree, both full candidate sets are kept and the difference is flagged; the
  merge never silently averages them away.
- **Observable-side-only manual edits.** A manual correction is split into
  `constrainedIds` (points that were visible in image evidence) and
  `rejectedHiddenIds` (points the user moved on a hidden/occluded side). Only the
  observable side seeds propagation; hidden-side edits stay in the manual layer
  but are never propagated.
- **No stale overwrite of a manual correction.** Every structural edit bumps
  `track.revision`. A propagation job captures the revision when it starts, and
  `applyAutoResult` rejects any result whose captured revision no longer matches.
  A manual correction is therefore immune to a background job that was already
  running.
- **Interval-scoped recompute.** A local fix invalidates only the interval it
  touches (the auto frames strictly between the surrounding anchors), so the rest
  of the timeline is preserved and only that interval needs recomputing.
- **Explicit regularisation, honestly labelled.** With weak evidence, points are
  held on a shape-regularised prediction and marked `regularized: true`,
  `visible: false`. The UI draws these as a dashed grey span and reports them as
  suspicious; the tool does not assert they are edge-accurate.
- **No bounding-box tracking.** Tracking is not "a fixed shape scaled to a
  bounding box". Motion is estimated as a similarity transform (translation,
  rotation, scale) fitted to patch matches, then each point is refined along its
  normal by a combination of NCC and a gradient edge scan.

## How tracking works

1. **Global similarity.** For each step, per-point patch search (NCC over a
   disc) proposes displacements. Votes are gated by an anchor appearance
   template and a trimmed re-fit rejects outliers (e.g. a textured occluder
   riding a few control points), so a corrupting occluder cannot bias the model.
   The similarity is refined by joint Gauss–Newton over the summed patch NCC.
2. **Per-point refinement.** Each point is predicted by the similarity, then
   refined along the contour normal only, using the patch match and the strongest
   gradient edge. There is no unconstrained 2-D slide, which removes tangential
   drift.
3. **Occlusion handling.** Anchor templates are sampled *inward* from the
   boundary (interior texture) at the interval's anchor frames. A point counts as
   observed only when the current frame matches that anchor template, not merely
   when it matches the previous frame — a moving occluder tracks itself perfectly
   frame-to-frame but does not match the object's anchor texture. Failed spans
   coast on the similarity prediction.
4. **Two-sided merge.** Forward and backward candidates are merged per control
   point `id`. The merge prefers the more template-verified side, keeps both
   candidates on the result, and flags a conflict when the two positions differ
   by more than `conflictDistance`.

## Layers

At any frame, precedence is: **manual correction → automatic result (for the
current revision) → original keyframe**. Keyframes are never rewritten by
propagation.

## UI

### 界面启动（how to launch the interface）

```bash
npm install
npm run dev
```

Then open the local URL Vite prints. The dev server is pinned to
**http://localhost:5173** (`strictPort`). A production build can be previewed
instead with `npm run build && npm run preview` (http://localhost:4173). The
workbench includes:

- Video overlay of the **evaluated** Catmull–Rom spline (not the control
  polygon), coloured per segment by diagnostic status.
- Control-point display; drag to move, "Add point" to insert on the curve,
  Delete to remove. Edits become keyframes or manual corrections as appropriate.
- **Actual sampled evidence** for the current auto frame: per-point NCC, anchor
  template NCC, edge score, confidence, state, the propagation model that moved
  each point (`joint` / `independent`, with a marker for segment-local
  selection), and the sampled search offset.
- **Propagation model card.** Choose one model for the whole keyframe interval
  (joint + shape prior vs independent points), or select a control point and
  switch just that contour segment. Each choice is stored as a local
  `PropagationConstraint`, invalidates the interval's auto frames, and survives
  saving/reopening the shot. Segment-local independent spans are tinted cyan.
- **Reopen lens card.** Save the shot (keyframes, manual fixes and constraints)
  to JSON and reopen it; parsing is strict and throws on a wrong format version
  or malformed data instead of silently substituting defaults. The card also
  recomputes the redraw burden (changed control points and redrawn spline
  length/fraction against ground truth) and the frame-to-frame contour change
  for the current auto frame.
- **Suspicious segments** list: weak / occluded / conflicting / regularized spans
  with reasons.
- Layer panel listing keyframe, manual, and automatic frames.
- Interval recompute controls with progress and cancellation.
- A visible stale-result warning on frames whose auto result predates a later
  edit.

The controls are driven by the same tracking kernel the benchmark uses
(`hybridStep` over the joint and independent trackers). Edit a point, recompute
forward, and compare the resulting contour against the frame-to-frame readout and
the evidence table; a point that loses image evidence is fed back as an
occluded/regularized contour point rather than hidden behind a default value.

## Propagation experiment

`npm run experiment` runs the rotoscoping propagation comparison described in
[`docs/rotoscoping-propagation-experiment.zh-CN.md`](docs/rotoscoping-propagation-experiment.zh-CN.md)
(Chinese; title 转描传播实验). On two new synthetic scenarios — `weak-edge`
(soft edges, low texture, non-rigid deformation) and `local-occlusion` (a compact
occluder covering only a few segments) — it feeds the **same keyframe curves** to
three configs: uniform joint, uniform independent, and per-segment local
selection. It reports contour distance (boundary mean/p95/Hausdorff, control-point
error) and editing burden (changed points, redrawn spline length/fraction), all
recomputed from the tracked contours and ground truth by
`src/core/redraw.ts`/`src/bench/metrics.ts`. A built-in verifier rejects
non-finite numbers and impossible ratios (exit code 2), so a run cannot mask an
error with default zeros. Output goes to `bench-out/propagation-experiment.json`;
a committed snapshot of the measured evidence is kept under
[`docs/evidence/`](docs/evidence/).

## Benchmarks

`npm run bench` runs four scenarios with known ground-truth contours — rotation,
deformation, partial occlusion, and a combined clip — and reports boundary
distance (mean / p95 / Hausdorff), control-point error, propagation drift,
per-frame drift growth, and control-point identity stability. Output is written
to `bench-out/report.json`.

Representative results (320×240):

| scenario    | boundary | p95  | cp-mean | cp-max | drift | identity |
|-------------|---------:|-----:|--------:|-------:|------:|---------:|
| rotation    | 0.40     | 0.91 | 0.38    | 1.51   | 0.57  | 100%     |
| deformation | 0.41     | 0.96 | 0.38    | 4.89   | 1.69  | 100%     |
| occlusion   | 0.46     | 1.23 | 0.46    | 4.67   | 0.89  | 100%     |
| combined    | 0.48     | 1.36 | 0.48    | 8.68   | 1.05  | 100%     |

Distances are in source pixels.

## Demo video

`npm run make-demo` renders the occlusion clip, tracks it with the real engine,
and writes `demo-out/input.mp4`, `demo-out/tracked.mp4`, and
`demo-out/side-by-side.mp4`. The tracked overlay is the evaluated contour spline.

## Tests

- `npm test` — unit tests for spline evaluation, tracking, and the layered
  project state (identity, stale-revision rejection, observable-side
  classification, interval invalidation), plus the independent tracker, the
  hybrid per-point model selection, propagation-constraint lifecycle and
  invalidation, redraw-burden measurement, and strict project
  serialization/parsing.
- `npm run e2e` — Playwright tests: propagation with sampled evidence and
  suspicious spans, manual correction + interval invalidation + interval
  recompute, a stale background job failing to overwrite a manual correction,
  freehand first-keyframe drawing, and the propagation-model flow (uniform
  independent switch, single-segment switch with the rest kept joint, and a
  joint/independent constraint surviving save + reopen).

Playwright needs a Chromium build and its system libraries. If the sandbox lacks
them, install browser deps for your environment, or point `LD_LIBRARY_PATH` at
locally extracted copies.

## Limitations

- Contour control data only; no alpha matte, and no claim of fine-boundary
  accuracy on regularised points.
- Appearance matching assumes the object texture is reasonably distinct from the
  occluder; the anchor-template gate is the mechanism that distinguishes them,
  and it can still be fooled by an occluder whose interior texture closely
  resembles the object's.
- The bundled synthetic clips are luma-based; the core is dimension-agnostic but
  the demo UI generates synthetic scenes rather than loading arbitrary video.
