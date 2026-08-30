import { textResult, type McpTool } from '../../lib/webmcp';
import type { Interest } from './attention';
import type { Recording } from './capture';
import { buildZoomTrack, zoomAt, type ZoomSettings } from './zoom';
import type { Composition } from './layout';

type State = {
  recording: Recording | null;
  points: Interest[];
  interestSource: 'pointer' | 'motion' | 'none';
  settings: { composition: Composition; zoom: ZoomSettings; frameRate: number; showClicks: boolean; showCursor: boolean };
};

/**
 * Limelight's tools. Recording needs a person to choose what to share, so
 * nothing here starts a capture. What an agent can usefully do is read what was
 * recorded and what the camera is about to do with it.
 */
export function limelightTools(read: () => State): McpTool[] {
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
        'Read the camera move the automatic zoom has planned: when it pulls in, where it looks, and when it pulls back out. Use it to explain what the finished video will do, or to check the settings before a long render.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        const state = read();
        if (!state.recording) return textResult({ plan: null, note: 'Nothing has been recorded yet.' });

        const track = buildZoomTrack(state.points, state.recording.duration, state.settings.zoom);
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
  ];
}
