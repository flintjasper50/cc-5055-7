import type {
  Contour,
  ProjectState,
  PropagationConstraint,
  PropagationMode,
  PropagationScope,
  Track,
  TrackingParams,
} from './types';

/**
 * Shot persistence for "reopen the lens".
 *
 * Serialisation is explicit and structural. Loading validates every field and
 * throws on a wrong version or malformed data rather than silently substituting
 * defaults, so a corrupted or hand-edited file can never be mistaken for a
 * valid tracking result.
 */

export const PROJECT_FORMAT_VERSION = 1;

export interface SavedProject {
  formatVersion: number;
  savedAt: string;
  project: ProjectState;
}

function fail(message: string): never {
  throw new Error(`Invalid rotoscope project file: ${message}`);
}

function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function loadContour(raw: unknown): Contour {
  if (!isObject(raw) || !Array.isArray(raw.points)) fail('contour.points must be an array');
  const points = raw.points.map((p) => {
    if (!isObject(p) || typeof p.id !== 'string' || !isNumber(p.x) || !isNumber(p.y)) {
      fail('each control point needs a string id and numeric x/y');
    }
    return { id: p.id, x: p.x, y: p.y };
  });
  if (new Set(points.map((p) => p.id)).size !== points.length) fail('duplicate control-point id');
  return { points, closed: raw.closed === true };
}

const MODES: PropagationMode[] = ['joint', 'independent'];
const SCOPES: PropagationScope[] = ['interval', 'segment'];

function loadModes(raw: unknown): Record<string, PropagationMode> {
  if (!isObject(raw)) fail('segmentModes must be an object');
  const out: Record<string, PropagationMode> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !MODES.includes(value as PropagationMode)) {
      fail(`segmentModes.${key} must be one of ${MODES.join('/')}`);
    }
    out[key] = value as PropagationMode;
  }
  return out;
}

function loadReasons(raw: unknown): Record<string, string> {
  if (!isObject(raw)) fail('segmentReasons must be an object');
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') fail(`segmentReasons.${key} must be a string`);
    out[key] = value;
  }
  return out;
}

function loadConstraint(raw: unknown): PropagationConstraint {
  if (!isObject(raw)) fail('constraint must be an object');
  if (!isNumber(raw.left) || !isNumber(raw.right) || raw.left >= raw.right) {
    fail('constraint needs left < right numeric frame bounds');
  }
  if (typeof raw.mode !== 'string' || !MODES.includes(raw.mode as PropagationMode)) {
    fail(`constraint.mode must be one of ${MODES.join('/')}`);
  }
  if (typeof raw.scope !== 'string' || !SCOPES.includes(raw.scope as PropagationScope)) {
    fail(`constraint.scope must be one of ${SCOPES.join('/')}`);
  }
  return {
    left: raw.left,
    right: raw.right,
    scope: raw.scope as PropagationScope,
    mode: raw.mode as PropagationMode,
    segmentModes: loadModes(raw.segmentModes),
    segmentReasons: loadReasons(raw.segmentReasons),
  };
}

function loadParams(raw: unknown): TrackingParams {
  if (!isObject(raw)) fail('tracking params missing');
  const required: (keyof TrackingParams)[] = [
    'patchRadius',
    'searchRadius',
    'nccThreshold',
    'edgeMin',
    'shapeRegularization',
    'conflictDistance',
    'edgeSearch',
    'edgeSnap',
    'subpixel',
  ];
  for (const key of required) {
    const value = raw[key];
    if (key === 'subpixel') {
      if (typeof value !== 'boolean') fail(`params.${key} must be boolean`);
    } else if (!isNumber(value)) {
      fail(`params.${key} must be a finite number`);
    }
  }
  return raw as unknown as TrackingParams;
}

function loadTrack(raw: unknown): Track {
  if (!isObject(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    fail('track needs string id and name');
  }
  if (!isObject(raw.keyframes) || !isObject(raw.manual) || !isObject(raw.auto)) {
    fail('track layers must be objects');
  }
  const keyframes: Track['keyframes'] = {};
  for (const [frame, contour] of Object.entries(raw.keyframes)) {
    const f = Number(frame);
    if (!Number.isInteger(f)) fail(`keyframe frame ${frame} not integer`);
    keyframes[f] = loadContour(contour);
  }
  if (!Array.isArray(raw.constraints)) fail('track.constraints must be an array');
  return {
    id: raw.id,
    name: raw.name,
    color: typeof raw.color === 'string' ? raw.color : '#4ade80',
    keyframes,
    manual: raw.manual as Track['manual'],
    auto: raw.auto as Track['auto'],
    params: loadParams(raw.params),
    constraints: (raw.constraints as unknown[]).map(loadConstraint),
    revision: isNumber(raw.revision) ? raw.revision : fail('track.revision must be a number'),
  };
}

export function serializeProject(project: ProjectState, now = new Date()): string {
  const saved: SavedProject = {
    formatVersion: PROJECT_FORMAT_VERSION,
    savedAt: now.toISOString(),
    project,
  };
  return JSON.stringify(saved, null, 2);
}

export function parseProject(text: string): ProjectState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    fail(`not valid JSON (${(err as Error).message})`);
  }
  if (!isObject(raw)) fail('top level must be an object');
  if (raw.formatVersion !== PROJECT_FORMAT_VERSION) {
    fail(`unsupported formatVersion ${String(raw.formatVersion)}; expected ${PROJECT_FORMAT_VERSION}`);
  }
  const project = raw.project;
  if (!isObject(project)) fail('project payload missing');
  if (project.version !== 1) fail(`unsupported project.version ${String(project.version)}`);
  if (!Array.isArray(project.tracks)) fail('project.tracks must be an array');
  return {
    version: 1,
    videoName: typeof project.videoName === 'string' ? project.videoName : fail('videoName missing'),
    width: isNumber(project.width) ? project.width : fail('width missing'),
    height: isNumber(project.height) ? project.height : fail('height missing'),
    fps: isNumber(project.fps) ? project.fps : fail('fps missing'),
    frameCount: isNumber(project.frameCount) ? project.frameCount : fail('frameCount missing'),
    tracks: (project.tracks as unknown[]).map(loadTrack),
    selectedTrackId: typeof project.selectedTrackId === 'string' ? project.selectedTrackId : null,
  };
}
