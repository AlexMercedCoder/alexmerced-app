import {
  errorResult, readBoolean, readEnum, readNumber, readString, requireString, textResult,
  type McpTool,
} from '../../lib/webmcp';
import type { Interest } from './attention';
import type { Recording } from './capture';
import {
  MOTIONS, reviveMotion, reviveTilt, type Motion, type MotionSettings, type Tilt,
} from './plate';
import {
  addText, removeText, textsAt, updateText, type TextAlign, type TextBlock,
} from './text';
import { zoomAt, type ZoomKeyframe, type ZoomSettings } from './zoom';
import {
  addBlock, constrain, MIN_BLOCK, removeBlock, sortBlocks, type ZoomBlock,
} from './zooms';
import {
  defaultSilence, findSilences, keptDuration, mergeSpans, type Span,
} from './waveform';
import type { Look } from './store';
import { createId } from '../../lib/id';
import {
  joins, layout, moveClipTo, reelDuration, removeClip, splitAt, updateClip, type Clip,
} from './reel';
import {
  CAMERA_SHAPES, CROP_ASPECTS, cropToAspect, FULL_CROP, isFullCrop, normaliseCrop, OUTPUT_SIZES, PRESETS,
  type CameraCorner, type CameraShape, type Composition, type Crop,
} from './layout';

type State = {
  recording: Recording | null;
  points: Interest[];
  interestSource: 'pointer' | 'motion' | 'none';
  settings: {
    composition: Composition; zoom: ZoomSettings; frameRate: number;
    showClicks: boolean; showCursor: boolean; tilt: Tilt; motion: MotionSettings;
  };
  /** The camera move as the timeline actually has it, hand edits included. */
  track: ZoomKeyframe[];
  crop: Crop;
  trim: { start: number; end: number };
  texts: TextBlock[];
  /** The zoom blocks themselves, which are what an agent edits. */
  zooms: ZoomBlock[];
  /** Stretches removed from the middle. */
  cuts: Span[];
  /** Loudness per column of the decoded audio, when the recording has sound. */
  loudness: Float32Array | null;
  looks: Look[];
  previewTime: number;
  playing: boolean;
  /** The reel, when the timeline holds more than one recording. */
  clips: Clip[];
  sourceDurations: Record<string, number>;
};

/** Changes an agent is allowed to make. Everything is local and reversible. */
type Edit = (change: {
  crop?: Crop;
  trim?: { start: number; end: number };
  composition?: Partial<Composition>;
  texts?: TextBlock[];
  tilt?: Tilt;
  motion?: MotionSettings;
  zooms?: ZoomBlock[];
  cuts?: Span[];
  seek?: number;
  play?: boolean;
  applyLook?: string;
  /** Run the first pass: cut the quiet gaps and add the zooms. */
  tidy?: true;
  reel?: { clips: Clip[]; preserveTimeline?: boolean; message: string };
}) => void;

/**
 * Limelight's tools. Recording needs a person to choose what to share, so
 * nothing here starts a capture. What an agent can usefully do is read what was
 * recorded and what the camera is about to do with it.
 */
export function limelightTools(read: () => State, edit: Edit): McpTool[] {
  return [
    {
      name: 'limelight_describe_recording',
      description:
        'Report what has been recorded: how long, what size, whether there is a pointer track, and where the automatic zoom decided to look. Nothing here starts or stops a recording, because choosing what to share has to be a person’s decision made in the browser’s own dialog.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const state = read();
        if (!state.recording) {
          return textResult({ recording: null, note: 'Nothing has been recorded or opened yet.' });
        }

        return textResult({
          duration: Number(state.recording.duration.toFixed(2)),
          width: state.recording.width,
          height: state.recording.height,
          bytes: state.recording.blob.size,
          hasAudio: state.recording.hasAudio,
          hasCamera: state.recording.camera !== null,
          pointerSamples: state.recording.pointer.length,
          clicks: state.recording.clicks.length,
          attention: {
            source: state.interestSource,
            explanation:
              state.interestSource === 'pointer'
                ? 'The recording was of this page, so pointer events were available and the zoom follows them exactly.'
                : state.interestSource === 'motion'
                  ? 'The recording was of another window. A browser is never told where the pointer is there, so the zoom follows where the picture changed instead.'
                  : 'Nothing moved enough to be worth zooming to.',
            moments: state.points.length,
          },
          trim: {
            start: Number(state.trim.start.toFixed(2)),
            end: Number(state.trim.end.toFixed(2)),
            length: Number((state.trim.end - state.trim.start).toFixed(2)),
          },
          crop: isFullCrop(state.crop)
            ? { whole: true }
            : {
                whole: false,
                ...state.crop,
                pixels: {
                  width: Math.round(state.recording.width * state.crop.width),
                  height: Math.round(state.recording.height * state.crop.height),
                },
              },
          texts: state.texts.map((text) => ({
            id: text.id,
            text: text.text,
            at: [Number(text.start.toFixed(2)), Number(text.end.toFixed(2))],
          })),
          output: {
            width: state.settings.composition.width,
            height: state.settings.composition.height,
            frameRate: state.settings.frameRate,
          },
        });
      },
    },
    {
      name: 'limelight_zoom_plan',
      description:
        'Read the camera move the timeline currently has: when it pulls in, where it looks, and when it pulls back out. This is the move that will be rendered, including any zoom that was moved, resized or added by hand, not the automatic suggestion.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const state = read();
        if (!state.recording) return textResult({ plan: null, note: 'Nothing has been recorded yet.' });

        const track = state.track;
        return textResult({
          settings: state.settings.zoom,
          keyframes: track.map((frame) => ({
            at: Number(frame.time.toFixed(2)),
            scale: Number(frame.scale.toFixed(2)),
            x: Number(frame.x.toFixed(3)),
            y: Number(frame.y.toFixed(3)),
          })),
          // A few samples, so the shape of the move is legible without reading
          // the keyframes and interpolating by hand.
          samples: Array.from({ length: 11 }, (_, index) => {
            const time = (state.recording!.duration * index) / 10;
            const frame = zoomAt(track, time);
            return { at: Number(time.toFixed(2)), scale: Number(frame.scale.toFixed(2)) };
          }),
        });
      },
    },
    {
      name: 'limelight_set_frame',
      description:
        'Set the part of the recording to keep and the range to export. The crop is given in fractions of the source, or by naming a shape to fit around the middle of the current one. Both are reversible: crop "whole" restores the full picture and omitting a range leaves the trim alone.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Left edge of the crop, 0 to 1.' },
          y: { type: 'number', description: 'Top edge of the crop, 0 to 1.' },
          width: { type: 'number', description: 'Crop width as a fraction of the source.' },
          height: { type: 'number', description: 'Crop height as a fraction of the source.' },
          aspect: {
            type: 'string',
            description: `A shape to fit the crop to, one of: whole, ${CROP_ASPECTS.filter((entry) => entry.ratio !== null).map((entry) => entry.id).join(', ')}. Takes the largest crop of that shape around the middle of the current one.`,
          },
          start: { type: 'number', description: 'Seconds into the recording to begin the export.' },
          end: { type: 'number', description: 'Seconds into the recording to end the export.' },
        },
      },
      execute: (input) => {
        const state = read();
        if (!state.recording) return errorResult('Nothing has been recorded or opened yet.');

        const change: { crop?: Crop; trim?: { start: number; end: number } } = {};
        const aspect = readString(input, 'aspect').trim();

        if (aspect === 'whole') {
          change.crop = { ...FULL_CROP };
        } else if (aspect) {
          const entry = CROP_ASPECTS.find((item) => item.id === aspect && item.ratio !== null);
          const ratio = entry?.ratio === 0
            ? state.settings.composition.width / state.settings.composition.height
            : entry?.ratio ?? null;
          if (ratio === null) {
            return errorResult(`"${aspect}" is not a shape this understands.`, {
              known: ['whole', ...CROP_ASPECTS.filter((item) => item.ratio !== null).map((item) => item.id)],
            });
          }
          change.crop = cropToAspect(state.crop, ratio, state.recording.width, state.recording.height);
        } else if (['x', 'y', 'width', 'height'].some((key) => key in input)) {
          change.crop = normaliseCrop({
            x: readNumber(input, 'x', state.crop.x),
            y: readNumber(input, 'y', state.crop.y),
            width: readNumber(input, 'width', state.crop.width),
            height: readNumber(input, 'height', state.crop.height),
          });
        }

        if ('start' in input || 'end' in input) {
          const duration = state.recording.duration;
          const start = Math.max(0, Math.min(duration, readNumber(input, 'start', state.trim.start)));
          const end = Math.max(0, Math.min(duration, readNumber(input, 'end', state.trim.end)));
          if (end - start < 0.1) {
            return errorResult('An export has to be at least a tenth of a second long.', { start, end, duration });
          }
          change.trim = { start, end };
        }

        if (!change.crop && !change.trim) {
          return errorResult('Nothing to change. Give a crop, a shape, or a range.');
        }

        edit(change);
        const after = read();
        return textResult({
          crop: isFullCrop(after.crop) ? { whole: true } : after.crop,
          trim: after.trim,
          keptPixels: {
            width: Math.round(state.recording.width * after.crop.width),
            height: Math.round(state.recording.height * after.crop.height),
          },
        });
      },
    },
    {
      name: 'limelight_set_look',
      description:
        'Set how the finished video is composed: the background, the output size, the inset and corners, and the camera bubble. Every field is optional and only what is given is changed.',
      inputSchema: {
        type: 'object',
        properties: {
          background: {
            type: 'string',
            description: `A background preset, one of: ${PRESETS.map((entry) => entry.id).join(', ')}.`,
          },
          size: {
            type: 'string',
            description: `An output size, one of: ${OUTPUT_SIZES.map((entry) => entry.id).join(', ')}.`,
          },
          padding: { type: 'number', description: 'Inset around the recording, 0 to 0.2 of the shorter edge.' },
          radius: { type: 'number', description: 'Corner rounding, 0 to 0.1 of the shorter recording edge.' },
          shadow: { type: 'number', description: 'Shadow strength, 0 to 1.' },
          camera: { type: 'boolean', description: 'Whether to show the camera bubble.' },
          cameraShape: {
            type: 'string',
            description: `The bubble's shape, one of: ${CAMERA_SHAPES.map((entry) => entry.id).join(', ')}.`,
          },
          cameraCorner: {
            type: 'string',
            description: 'Where the bubble sits: bottomRight, bottomLeft, topRight or topLeft.',
          },
          tiltX: { type: 'number', description: 'Degrees to lean the top away, -45 to 45.' },
          tiltY: { type: 'number', description: 'Degrees to turn the right side away, -45 to 45.' },
          tiltRotate: { type: 'number', description: 'Degrees of roll in the plane, -30 to 30.' },
          tiltDepth: { type: 'number', description: 'How strong the perspective is, 0 to 1.' },
          entrance: {
            type: 'string',
            description: `How the recording arrives, one of: ${MOTIONS.map((entry) => entry.id).join(', ')}.`,
          },
          exit: { type: 'string', description: 'How it leaves, from the same list.' },
          motionSeconds: { type: 'number', description: 'How long the arrival and the departure take.' },
        },
      },
      execute: (input) => {
        const state = read();
        const current = state.settings.composition;
        const change: Partial<Composition> = {};
        const unknown: string[] = [];

        const background = readString(input, 'background').trim();
        if (background) {
          const preset = PRESETS.find((entry) => entry.id === background);
          if (preset) {
            change.background = preset.background;
            change.colours = [...preset.colours];
          } else unknown.push(`background "${background}"`);
        }

        const size = readString(input, 'size').trim();
        if (size) {
          const found = OUTPUT_SIZES.find((entry) => entry.id === size);
          if (found) { change.width = found.width; change.height = found.height; }
          else unknown.push(`size "${size}"`);
        }

        const clampInto = (key: 'padding' | 'radius' | 'shadow', high: number) => {
          if (!(key in input)) return;
          change[key] = Math.max(0, Math.min(high, readNumber(input, key, current[key])));
        };
        clampInto('padding', 0.2);
        clampInto('radius', 0.1);
        clampInto('shadow', 1);

        const camera = { ...current.camera };
        let touchedCamera = false;
        if ('camera' in input) {
          camera.enabled = input.camera === true || input.camera === 'true';
          touchedCamera = true;
        }
        const shape = readString(input, 'cameraShape').trim();
        if (shape) {
          if (CAMERA_SHAPES.some((entry) => entry.id === shape)) {
            camera.shape = shape as CameraShape;
            touchedCamera = true;
          } else unknown.push(`camera shape "${shape}"`);
        }
        const corner = readString(input, 'cameraCorner').trim();
        if (corner) {
          if (['bottomRight', 'bottomLeft', 'topRight', 'topLeft'].includes(corner)) {
            camera.corner = corner as CameraCorner;
            touchedCamera = true;
          } else unknown.push(`camera corner "${corner}"`);
        }
        if (touchedCamera) change.camera = camera;

        const tiltKeys = ['tiltX', 'tiltY', 'tiltRotate', 'tiltDepth'];
        let tilt: Tilt | undefined;
        if (tiltKeys.some((key) => key in input)) {
          tilt = reviveTilt({
            x: readNumber(input, 'tiltX', state.settings.tilt.x),
            y: readNumber(input, 'tiltY', state.settings.tilt.y),
            rotate: readNumber(input, 'tiltRotate', state.settings.tilt.rotate),
            depth: readNumber(input, 'tiltDepth', state.settings.tilt.depth),
          });
        }

        const motionKeys = ['entrance', 'exit', 'motionSeconds'];
        let motion: MotionSettings | undefined;
        if (motionKeys.some((key) => key in input)) {
          const named = (key: 'entrance' | 'exit', spare: Motion): Motion => {
            const value = readString(input, key).trim();
            if (!value) return spare;
            if (!MOTIONS.some((entry) => entry.id === value)) {
              unknown.push(`${key} "${value}"`);
              return spare;
            }
            return value as Motion;
          };
          motion = reviveMotion({
            entrance: named('entrance', state.settings.motion.entrance),
            exit: named('exit', state.settings.motion.exit),
            seconds: readNumber(input, 'motionSeconds', state.settings.motion.seconds),
          });
        }

        if (unknown.length > 0) {
          return errorResult(`This does not recognise ${unknown.join(' or ')}.`, {
            backgrounds: PRESETS.map((entry) => entry.id),
            sizes: OUTPUT_SIZES.map((entry) => entry.id),
            cameraShapes: CAMERA_SHAPES.map((entry) => entry.id),
            cameraCorners: ['bottomRight', 'bottomLeft', 'topRight', 'topLeft'],
            movements: MOTIONS.map((entry) => entry.id),
          });
        }
        if (Object.keys(change).length === 0 && !tilt && !motion) {
          return errorResult('Nothing to change.');
        }

        edit({
          ...(Object.keys(change).length > 0 ? { composition: change } : {}),
          ...(tilt ? { tilt } : {}),
          ...(motion ? { motion } : {}),
        });
        const settings = read().settings;
        const after = settings.composition;
        return textResult({
          background: after.background,
          colours: after.colours,
          output: { width: after.width, height: after.height },
          padding: after.padding,
          radius: after.radius,
          shadow: after.shadow,
          camera: after.camera,
          tilt: settings.tilt,
          motion: settings.motion,
        });
      },
    },
    {
      name: 'limelight_edit_zooms',
      description:
        'Add, move, aim, rescale or remove the zooms on the timeline. Aiming is the point: a zoom carries where it looks as well as when it happens, given as fractions across and down the frame, and a zoom pointed at the wrong thing is the usual reason a recording looks wrong. Zooms may not overlap, so an edit that would collide is trimmed back rather than refused. Everything here is undoable in the editor.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'update', 'remove', 'clear'], description: 'What to do.' },
          id: { type: 'string', description: 'Which zoom to update or remove. Read them from limelight_zoom_plan.' },
          at: { type: 'number', description: 'For add: the moment in seconds to put it at.' },
          start: { type: 'number', description: 'For update: a new start in seconds.' },
          end: { type: 'number', description: 'For update: a new end in seconds.' },
          scale: { type: 'number', description: 'How far in, from 1 to 4.' },
          x: { type: 'number', description: 'Where to look across the frame, 0 to 1.' },
          y: { type: 'number', description: 'Where to look down the frame, 0 to 1.' },
        },
        required: ['action'],
      },
      execute: (input = {}) => {
        const state = read();
        if (!state.recording) return errorResult('Nothing has been recorded or opened yet.');
        const duration = state.recording.duration;
        const action = readEnum(input, 'action', ['add', 'update', 'remove', 'clear'] as const, 'add');

        if (action === 'clear') {
          edit({ zooms: [] });
          return textResult({ zooms: [], note: 'Every zoom removed. Undo in the editor puts them back.' });
        }

        if (action === 'add') {
          const at = readNumber(input, 'at', state.previewTime);
          const focus = {
            x: readNumber(input, 'x', 0.5),
            y: readNumber(input, 'y', 0.5),
          };
          const before = state.zooms.length;
          let next = addBlock(state.zooms, Math.max(0, Math.min(duration, at)), duration, state.settings.zoom, focus);
          if (next.length === before) {
            return errorResult('There is no room for a zoom there.', {
              reason: 'That moment is inside an existing zoom, or the gap around it is shorter than the minimum.',
              minimumSeconds: MIN_BLOCK,
            });
          }
          const added = next.find((zoom) => !state.zooms.some((old) => old.id === zoom.id));
          if (added && Number.isFinite(readNumber(input, 'scale', Number.NaN))) {
            next = next.map((zoom) => (zoom.id === added.id
              ? { ...zoom, scale: Math.max(1, Math.min(4, readNumber(input, 'scale', zoom.scale))) }
              : zoom));
            next = constrain(next, added.id, duration);
          }
          edit({ zooms: next });
          return textResult({ added: describeZoom(next.find((zoom) => zoom.id === added?.id)), zooms: next.map(describeZoom) });
        }

        const id = requireString(input, 'id');
        const target = state.zooms.find((zoom) => zoom.id === id);
        if (!target) return errorResult(`There is no zoom with the id ${id}.`, { ids: state.zooms.map((zoom) => zoom.id) });

        if (action === 'remove') {
          const next = removeBlock(state.zooms, id);
          edit({ zooms: next });
          return textResult({ removed: id, zooms: next.map(describeZoom) });
        }

        const changed: ZoomBlock = {
          ...target,
          start: Math.max(0, readNumber(input, 'start', target.start)),
          end: Math.min(duration, readNumber(input, 'end', target.end)),
          scale: Math.max(1, Math.min(4, readNumber(input, 'scale', target.scale))),
          x: Math.max(0, Math.min(1, readNumber(input, 'x', target.x))),
          y: Math.max(0, Math.min(1, readNumber(input, 'y', target.y))),
          // Touched by an agent counts as touched by hand, so a re-analysis
          // leaves it alone rather than overwriting the instruction.
          pinned: true,
        };
        if (changed.end <= changed.start) {
          return errorResult('A zoom has to end after it starts.', { start: changed.start, end: changed.end });
        }

        const next = constrain(
          sortBlocks(state.zooms.map((zoom) => (zoom.id === id ? changed : zoom))), id, duration,
        );
        edit({ zooms: next });
        const after = next.find((zoom) => zoom.id === id);
        return textResult({
          updated: describeZoom(after),
          note: after && (after.start !== changed.start || after.end !== changed.end)
            ? 'Trimmed back so it does not overlap its neighbour.'
            : undefined,
          zooms: next.map(describeZoom),
        });
      },
    },
    {
      name: 'limelight_describe_sound',
      description:
        'Report where the recording is loud and where it is quiet, and which stretches are silent enough to be worth cutting. This is what makes editing by ear possible without listening: silences are where sentences end and where mistakes were left in.',
      inputSchema: {
        type: 'object',
        properties: {
          threshold: { type: 'number', description: 'Quiet is below this fraction of the loudest moment. Default 0.06.' },
          minSeconds: { type: 'number', description: 'Ignore quiet shorter than this. Default 0.6.' },
        },
      },
      execute: (input = {}) => {
        const state = read();
        if (!state.recording) return errorResult('Nothing has been recorded or opened yet.');
        if (!state.loudness) {
          return textResult({
            sound: false,
            note: state.recording.hasAudio
              ? 'This recording has sound but it could not be decoded, so silences cannot be found.'
              : 'This recording has no sound.',
          });
        }

        const options = {
          threshold: Math.max(0, Math.min(1, readNumber(input, 'threshold', defaultSilence.threshold))),
          minSeconds: Math.max(0.05, readNumber(input, 'minSeconds', defaultSilence.minSeconds)),
          padSeconds: defaultSilence.padSeconds,
        };
        const silences = findSilences(state.loudness, state.recording.duration, options);
        const perColumn = state.recording.duration / state.loudness.length;

        return textResult({
          sound: true,
          duration: Number(state.recording.duration.toFixed(2)),
          settingsUsed: options,
          silences: silences.map((span) => ({
            start: Number(span.start.toFixed(2)),
            end: Number(span.end.toFixed(2)),
            seconds: Number((span.end - span.start).toFixed(2)),
          })),
          quietSeconds: Number(silences.reduce((total, span) => total + (span.end - span.start), 0).toFixed(2)),
          // A coarse shape of the whole recording, so an agent can talk about
          // it without asking for every column.
          loudnessOverTime: Array.from({ length: 20 }, (_, index) => {
            const from = Math.floor((index * state.loudness!.length) / 20);
            const to = Math.max(from + 1, Math.floor(((index + 1) * state.loudness!.length) / 20));
            let peak = 0;
            for (let at = from; at < to; at += 1) peak = Math.max(peak, state.loudness![at]);
            return { at: Number((from * perColumn).toFixed(2)), level: Number(peak.toFixed(3)) };
          }),
        });
      },
    },
    {
      name: 'limelight_cut',
      description:
        'Remove a stretch from the middle of the recording, take out every silence at once, or put every cut back. Cuts are what shorten a recording without re-recording it: trim only sets an outer start and end. The picture and the sound both skip a cut, so what is exported is what is left.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['remove', 'silences', 'clear'], description: 'What to do.' },
          start: { type: 'number', description: 'For remove: the first second to take out.' },
          end: { type: 'number', description: 'For remove: the second to stop at.' },
          threshold: { type: 'number', description: 'For silences: quiet is below this fraction of the loudest moment.' },
          minSeconds: { type: 'number', description: 'For silences: ignore quiet shorter than this.' },
        },
        required: ['action'],
      },
      execute: (input = {}) => {
        const state = read();
        if (!state.recording) return errorResult('Nothing has been recorded or opened yet.');
        const action = readEnum(input, 'action', ['remove', 'silences', 'clear'] as const, 'remove');
        const { start: from, end: to } = state.trim;

        if (action === 'clear') {
          edit({ cuts: [] });
          return textResult({ cuts: [], keptSeconds: Number((to - from).toFixed(2)), note: 'Every cut put back.' });
        }

        let added: Span[];
        if (action === 'silences') {
          if (!state.loudness) return errorResult('This recording has no sound to find silences in.');
          added = findSilences(state.loudness, state.recording.duration, {
            threshold: Math.max(0, Math.min(1, readNumber(input, 'threshold', defaultSilence.threshold))),
            minSeconds: Math.max(0.05, readNumber(input, 'minSeconds', defaultSilence.minSeconds)),
            padSeconds: defaultSilence.padSeconds,
          })
            // Only inside the trimmed range: cutting from a part already being
            // thrown away changes nothing and reads as a bug.
            .map((span) => ({ start: Math.max(span.start, from), end: Math.min(span.end, to) }))
            .filter((span) => span.end - span.start > 0.05);
          if (added.length === 0) return textResult({ cuts: state.cuts, note: 'No silences long enough to be worth cutting.' });
        } else {
          const start = readNumber(input, 'start', Number.NaN);
          const end = readNumber(input, 'end', Number.NaN);
          if (!Number.isFinite(start) || !Number.isFinite(end)) {
            return errorResult('A cut needs a start and an end, in seconds.');
          }
          if (end <= start) return errorResult('A cut has to end after it starts.', { start, end });
          added = [{ start: Math.max(0, start), end: Math.min(state.recording.duration, end) }];
        }

        const cuts = mergeSpans([...state.cuts, ...added]);
        edit({ cuts });
        return textResult({
          cuts: cuts.map((span) => ({
            start: Number(span.start.toFixed(2)),
            end: Number(span.end.toFixed(2)),
            seconds: Number((span.end - span.start).toFixed(2)),
          })),
          removedSeconds: Number(((to - from) - keptDuration(cuts, from, to)).toFixed(2)),
          keptSeconds: Number(keptDuration(cuts, from, to).toFixed(2)),
        });
      },
    },
    {
      name: 'limelight_preview',
      description:
        'Move the playhead or start and stop playback. Useful for putting the editor on the moment being discussed so a person can look at it. This does not return the picture: an agent cannot see the canvas, only place it.',
      inputSchema: {
        type: 'object',
        properties: {
          at: { type: 'number', description: 'Seconds to move the playhead to.' },
          play: { type: 'boolean', description: 'True to start playing, false to stop.' },
        },
      },
      execute: (input = {}) => {
        const state = read();
        if (!state.recording) return errorResult('Nothing has been recorded or opened yet.');
        const at = readNumber(input, 'at', Number.NaN);
        const change: { seek?: number; play?: boolean } = {};
        if (Number.isFinite(at)) change.seek = Math.max(0, Math.min(state.recording.duration, at));
        if ('play' in input) change.play = readBoolean(input, 'play', false);
        if (change.seek === undefined && change.play === undefined) {
          return textResult({ at: Number(state.previewTime.toFixed(2)), playing: state.playing });
        }
        edit(change);
        return textResult({
          at: Number((change.seek ?? state.previewTime).toFixed(2)),
          playing: change.play ?? state.playing,
        });
      },
    },
    {
      name: 'limelight_looks',
      description:
        'List the saved looks and apply one. A look is the presentation only: background, padding, shadow, tilt, entrance and the defaults new zooms are built from. It carries nothing about a particular recording, so applying one to a different video is safe.',
      inputSchema: {
        type: 'object',
        properties: {
          apply: { type: 'string', description: 'The name or id of a look to apply. Omit to just list them.' },
        },
      },
      execute: (input = {}) => {
        const state = read();
        const listed = state.looks.map((look) => ({ id: look.id, name: look.name }));
        const wanted = readString(input, 'apply').trim();
        if (!wanted) return textResult({ looks: listed });

        const match = state.looks.find((look) => look.id === wanted)
          ?? state.looks.find((look) => look.name.toLowerCase() === wanted.toLowerCase());
        if (!match) return errorResult(`There is no look called ${wanted}.`, { looks: listed });

        edit({ applyLook: match.id });
        return textResult({ applied: { id: match.id, name: match.name }, looks: listed });
      },
    },
    {
      name: 'limelight_add_text',
      description:
        'Put a caption on the recording. It is drawn into the finished video, not overlaid in the page, so what the preview shows is what the file will contain. Position is given as fractions of the finished frame.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What it should say. Line breaks are kept.' },
          start: { type: 'number', description: 'Seconds into the recording it appears.' },
          end: { type: 'number', description: 'Seconds into the recording it leaves.' },
          x: { type: 'number', description: 'Middle of the caption across the frame, 0 to 1.' },
          y: { type: 'number', description: 'Middle of the caption down the frame, 0 to 1.' },
          size: { type: 'number', description: 'Line height as a fraction of the shorter edge, 0.02 to 0.2.' },
          colour: { type: 'string', description: 'A CSS colour for the words.' },
          plate: { type: 'number', description: 'How solid the panel behind the words is, 0 to 1. Zero draws none.' },
          align: { type: 'string', description: 'left, centre or right.' },
          fade: { type: 'number', description: 'Seconds to appear and to leave.' },
        },
        required: ['text'],
      },
      execute: (input) => {
        const state = read();
        if (!state.recording) return errorResult('Nothing has been recorded or opened yet.');

        const duration = state.recording.duration;
        const start = Math.max(0, Math.min(duration, readNumber(input, 'start', 0)));
        const added = addText(state.texts, start, duration);
        const fresh = added.find((text) => !state.texts.some((existing) => existing.id === text.id));
        if (!fresh) return errorResult('There was no room for a caption there.');

        const end = 'end' in input
          ? Math.max(start + 0.4, Math.min(duration, readNumber(input, 'end', fresh.end)))
          : fresh.end;

        edit({
          texts: updateText(added, fresh.id, {
            text: requireString(input, 'text'),
            end,
            x: clamp01(readNumber(input, 'x', fresh.x)),
            y: clamp01(readNumber(input, 'y', fresh.y)),
            size: Math.max(0.02, Math.min(0.2, readNumber(input, 'size', fresh.size))),
            colour: readString(input, 'colour', fresh.colour),
            plate: clamp01(readNumber(input, 'plate', fresh.plate)),
            align: readEnum(input, 'align', ['left', 'centre', 'right'] as const, fresh.align) as TextAlign,
            fade: Math.max(0, Math.min(3, readNumber(input, 'fade', fresh.fade))),
          }),
        });

        const now = read().texts.find((text) => text.id === fresh.id);
        return textResult({ added: now, total: read().texts.length });
      },
    },
    {
      name: 'limelight_remove_text',
      description:
        'Remove a caption by its id, or every caption at once. Ids come from limelight_describe_recording.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Which caption to remove.' },
          all: { type: 'boolean', description: 'Remove every caption instead.' },
        },
      },
      execute: (input) => {
        const state = read();
        if (input.all === true || input.all === 'true') {
          const removed = state.texts.length;
          edit({ texts: [] });
          return textResult({ removed, remaining: 0 });
        }

        const id = requireString(input, 'id');
        if (!state.texts.some((text) => text.id === id)) {
          return errorResult(`There is no caption called "${id}".`, {
            known: state.texts.map((text) => text.id),
          });
        }
        edit({ texts: removeText(state.texts, id) });
        return textResult({ removed: 1, remaining: read().texts.length });
      },
    },
    {
      name: 'limelight_text_at',
      description:
        'Read which captions are showing at a moment, and how far through their fade each one is. Use it to check a caption lands where it was meant to without rendering the video.',
      inputSchema: {
        type: 'object',
        properties: { at: { type: 'number', description: 'Seconds into the recording.' } },
        required: ['at'],
      },
      execute: (input) => {
        const state = read();
        const at = readNumber(input, 'at', 0);
        return textResult({
          at,
          showing: textsAt(state.texts, at).map(({ block, opacity }) => ({
            id: block.id,
            text: block.text,
            opacity: Number(opacity.toFixed(3)),
          })),
        });
      },
    },
    {
      name: 'limelight_describe_reel',
      description:
        'Report whether this timeline is one recording or several, where each clip sits, and where the joins between them fall. Everything else in these tools is addressed in timeline seconds, and this is what those seconds are made of.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const state = read();
        if (!state.recording) return textResult({ clips: [], note: 'Nothing has been recorded or opened yet.' });
        const placed = layout(state.clips);
        return textResult({
          clips: placed.map((clip) => ({
            id: clip.id,
            name: clip.name ?? null,
            source: clip.source,
            startsAt: Number(clip.at.toFixed(2)),
            runsFor: Number(clip.length.toFixed(2)),
            fromItsOwn: [Number(clip.in.toFixed(2)), Number(clip.out.toFixed(2))],
            audio: {
              gain: clip.gain ?? 1, muted: clip.muted ?? false,
              fadeIn: clip.fadeIn ?? 0, fadeOut: clip.fadeOut ?? 0,
            },
          })),
          duration: Number(reelDuration(state.clips).toFixed(2)),
          joins: joins(placed).map((at) => Number(at.toFixed(2))),
          note: 'Timeline seconds run across every clip. A retake or an added clip moves everything after it.',
        });
      },
    },
    {
      name: 'limelight_edit_reel',
      description:
        'Edit the clips on the timeline: move or remove one, rename it, change its source trim and audio, or split the clip under a timeline moment. Every change is local, undoable, and uses the same timeline remapping as the visible controls.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['move', 'remove', 'update', 'split'], description: 'What to change.' },
          id: { type: 'string', description: 'The clip id from limelight_describe_reel.' },
          index: { type: 'number', description: 'For move: the zero-based destination position.' },
          at: { type: 'number', description: 'For split: a moment in timeline seconds.' },
          name: { type: 'string', description: 'For update: a new clip name.' },
          in: { type: 'number', description: 'For update: first source second to use.' },
          out: { type: 'number', description: 'For update: source second to stop using.' },
          gain: { type: 'number', description: 'For update: clip volume from 0 to 2.' },
          muted: { type: 'boolean', description: 'For update: whether this clip is silent.' },
          fadeIn: { type: 'number', description: 'For update: seconds for sound to fade in.' },
          fadeOut: { type: 'number', description: 'For update: seconds for sound to fade out.' },
        },
        required: ['action'],
      },
      execute: (input) => {
        const state = read();
        if (!state.recording || state.clips.length === 0) return errorResult('There is no reel to edit yet.');
        const action = readEnum(input, 'action', ['move', 'remove', 'update', 'split'] as const, 'update');
        if (action === 'split') {
          const at = readNumber(input, 'at', state.previewTime);
          const clips = splitAt(state.clips, at, () => createId('clip'));
          if (clips.length === state.clips.length) return errorResult('That moment is not inside a clip.');
          edit({ reel: { clips, preserveTimeline: true, message: `Split the clip at ${at.toFixed(2)} seconds.` } });
          return textResult({ done: true, action, at, clips: clips.length });
        }

        const id = requireString(input, 'id');
        const clip = state.clips.find((entry) => entry.id === id);
        if (!clip) return errorResult(`There is no clip named ${id}.`);
        let clips = state.clips;
        if (action === 'remove') {
          if (clips.length === 1) return errorResult('The only clip cannot be removed.');
          clips = removeClip(clips, id);
        } else if (action === 'move') {
          clips = moveClipTo(clips, id, readNumber(input, 'index', 0));
        } else {
          const change: Partial<Pick<Clip, 'name' | 'in' | 'out' | 'gain' | 'muted' | 'fadeIn' | 'fadeOut'>> = {};
          if (typeof input.name === 'string') change.name = readString(input, 'name', clip.name ?? '');
          if (typeof input.in === 'number') change.in = readNumber(input, 'in', clip.in);
          if (typeof input.out === 'number') change.out = readNumber(input, 'out', clip.out);
          if (typeof input.gain === 'number') change.gain = readNumber(input, 'gain', clip.gain ?? 1);
          if (typeof input.muted === 'boolean') change.muted = readBoolean(input, 'muted', clip.muted ?? false);
          if (typeof input.fadeIn === 'number') change.fadeIn = readNumber(input, 'fadeIn', clip.fadeIn ?? 0);
          if (typeof input.fadeOut === 'number') change.fadeOut = readNumber(input, 'fadeOut', clip.fadeOut ?? 0);
          clips = updateClip(clips, id, change, state.sourceDurations[clip.source] ?? clip.out);
        }
        if (clips === state.clips) return errorResult('That change did not move or update the clip.');
        const message = action === 'remove' ? 'Removed the clip.' : action === 'move' ? 'Moved the clip.' : 'Updated the clip.';
        edit({ reel: { clips, message } });
        return textResult({ done: true, action, clips: layout(clips).map((entry) => entry.id) });
      },
    },
    {
      name: 'limelight_tidy',
      description:
        'Do the first pass over a recording: cut the quiet gaps out and put zooms where the action was. Safe to run at any point, since a zoom placed by hand is never moved. One undo reverses the whole thing.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const state = read();
        if (!state.recording) return errorResult('There is nothing to tidy yet.');
        edit({ tidy: true });
        return textResult({
          done: true,
          note: 'Read limelight_describe_recording again to see what changed.',
        });
      },
    },
  ];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** One zoom, as an agent reads it back. */
function describeZoom(zoom: ZoomBlock | undefined): Record<string, unknown> | null {
  if (!zoom) return null;
  return {
    id: zoom.id,
    start: Number(zoom.start.toFixed(2)),
    end: Number(zoom.end.toFixed(2)),
    scale: Number(zoom.scale.toFixed(2)),
    x: Number(zoom.x.toFixed(3)),
    y: Number(zoom.y.toFixed(3)),
    setByHand: zoom.pinned,
  };
}
