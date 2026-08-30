import { errorResult, readNumber, readString, textResult, type McpTool } from '../../lib/webmcp';
import type { Interest } from './attention';
import type { Recording } from './capture';
import { zoomAt, type ZoomKeyframe, type ZoomSettings } from './zoom';
import {
  CAMERA_SHAPES, CROP_ASPECTS, cropToAspect, FULL_CROP, isFullCrop, normaliseCrop, OUTPUT_SIZES, PRESETS,
  type CameraCorner, type CameraShape, type Composition, type Crop,
} from './layout';

type State = {
  recording: Recording | null;
  points: Interest[];
  interestSource: 'pointer' | 'motion' | 'none';
  settings: { composition: Composition; zoom: ZoomSettings; frameRate: number; showClicks: boolean; showCursor: boolean };
  /** The camera move as the timeline actually has it, hand edits included. */
  track: ZoomKeyframe[];
  crop: Crop;
  trim: { start: number; end: number };
};

/** Changes an agent is allowed to make. Everything is local and reversible. */
type Edit = (change: {
  crop?: Crop;
  trim?: { start: number; end: number };
  composition?: Partial<Composition>;
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

        if (unknown.length > 0) {
          return errorResult(`This does not recognise ${unknown.join(' or ')}.`, {
            backgrounds: PRESETS.map((entry) => entry.id),
            sizes: OUTPUT_SIZES.map((entry) => entry.id),
            cameraShapes: CAMERA_SHAPES.map((entry) => entry.id),
            cameraCorners: ['bottomRight', 'bottomLeft', 'topRight', 'topLeft'],
          });
        }
        if (Object.keys(change).length === 0) return errorResult('Nothing to change.');

        edit({ composition: change });
        const after = read().settings.composition;
        return textResult({
          background: after.background,
          colours: after.colours,
          output: { width: after.width, height: after.height },
          padding: after.padding,
          radius: after.radius,
          shadow: after.shadow,
          camera: after.camera,
        });
      },
    },
  ];
}
