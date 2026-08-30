import {
  errorResult, fileResult, readBoolean, readEnum, readNumber, readStringArray, requireString,
  textResult, type McpTool,
} from '../../lib/webmcp';
import { decode } from './audio';
import {
  changeSpeed, cut, fadeIn, fadeOut, findBounds, formatTime, gain, gainToDecibels, join,
  normalisePeak, normaliseRms, peak, resample, reverse, rms, toMono, toStereo, trim, trimSilence,
} from './dsp';
import { duration, encodeWav, frameCount, type Samples } from './wav';

const DEPTHS = [16, 24, 32] as const;

/**
 * Cadence's tools. Audio arrives and leaves as data URIs, so an agent can hand
 * over a voice memo and get back a trimmed, levelled WAV without any of it
 * touching a server.
 */
export function cadenceTools(): McpTool[] {
  return [
    {
      name: 'cadence_describe_audio',
      description:
        'Read an audio file and report its length, sample rate, channels, peak and average level, and where the sound actually starts and stops inside it. Call this before editing so the times you ask for are right. Reads WAV directly, and anything else the browser can decode: MP3, M4A, Opus, FLAC.',
      inputSchema: {
        type: 'object',
        properties: { audio: { type: 'string', description: 'A data: URI, blob: URL, or http URL.' } },
        required: ['audio'],
      },
      execute: async (input) => {
        const samples = await load(requireString(input, 'audio'));
        const bounds = findBounds(samples, -50, 0);
        const highest = peak(samples);
        const average = rms(samples);

        return textResult({
          duration: Number(duration(samples).toFixed(3)),
          readable: formatTime(duration(samples)),
          sampleRate: samples.sampleRate,
          channels: samples.channels.length,
          frames: frameCount(samples),
          peakDbfs: highest > 0 ? Number(gainToDecibels(highest).toFixed(1)) : null,
          averageDbfs: average > 0 ? Number(gainToDecibels(average).toFixed(1)) : null,
          soundStartsAt: Number(bounds.start.toFixed(3)),
          soundEndsAt: Number(bounds.end.toFixed(3)),
          silent: highest === 0,
        });
      },
    },
    {
      name: 'cadence_edit_audio',
      description:
        'Trim, fade, level, reverse, resample or change the speed of an audio file, and get a WAV back. Every step is optional and they are applied in the order listed here: trim, remove the silence at the ends, change speed, resample, fade in, fade out, then normalise. Changing speed moves the pitch with it, which is what happens without a pitch shifter.',
      inputSchema: {
        type: 'object',
        properties: {
          audio: { type: 'string' },
          start: { type: 'number', description: 'Trim from this many seconds in.' },
          end: { type: 'number', description: 'Trim to this many seconds.' },
          removeSilence: { type: 'boolean', description: 'Cut the quiet at both ends.' },
          silenceThresholdDb: { type: 'number', description: 'What counts as quiet. -50 by default.' },
          speed: { type: 'number', description: '2 is twice as fast. The pitch moves with it.' },
          sampleRate: { type: 'number', description: 'Resample to this many hertz.' },
          fadeInSeconds: { type: 'number' },
          fadeOutSeconds: { type: 'number' },
          normalise: { type: 'string', enum: ['none', 'peak', 'loudness'], description: '"peak" lifts the loudest moment to the target; "loudness" matches the average and then guards against clipping.' },
          targetDb: { type: 'number', description: 'Where to normalise to. -1 for peak, -18 for loudness.' },
          gainDb: { type: 'number', description: 'A plain change in level, in decibels.' },
          channels: { type: 'string', enum: ['keep', 'mono', 'stereo'] },
          reverse: { type: 'boolean' },
          bitDepth: { type: 'number', enum: [16, 24, 32], description: '16 by default. 32 is float.' },
        },
        required: ['audio'],
      },
      execute: async (input) => {
        let samples = await load(requireString(input, 'audio'));
        const original = duration(samples);
        const steps: string[] = [];

        const start = readNumber(input, 'start', 0);
        const end = readNumber(input, 'end', original);
        if (start > 0 || end < original) {
          if (end <= start) return errorResult('The end must come after the start.');
          samples = trim(samples, start, end);
          steps.push(`trimmed to ${formatTime(start)} through ${formatTime(end)}`);
        }

        if (readBoolean(input, 'removeSilence', false)) {
          const before = duration(samples);
          samples = trimSilence(samples, readNumber(input, 'silenceThresholdDb', -50), 0.05);
          steps.push(`cut ${(before - duration(samples)).toFixed(2)}s of silence`);
        }

        const speed = readNumber(input, 'speed', 1);
        if (speed !== 1) {
          samples = changeSpeed(samples, speed);
          steps.push(`speed set to ${speed}x`);
        }

        const rate = Math.round(readNumber(input, 'sampleRate', samples.sampleRate));
        if (rate !== samples.sampleRate) {
          if (rate < 4000 || rate > 384000) return errorResult('Pick a sample rate between 4000 and 384000.');
          samples = resample(samples, rate);
          steps.push(`resampled to ${rate} Hz`);
        }

        const channels = readEnum(input, 'channels', ['keep', 'mono', 'stereo'] as const, 'keep');
        if (channels === 'mono') { samples = toMono(samples); steps.push('mixed to mono'); }
        if (channels === 'stereo') { samples = toStereo(samples); steps.push('spread to stereo'); }

        if (readBoolean(input, 'reverse', false)) { samples = reverse(samples); steps.push('reversed'); }

        const fadeIntoIt = readNumber(input, 'fadeInSeconds', 0);
        if (fadeIntoIt > 0) { samples = fadeIn(samples, fadeIntoIt); steps.push(`faded in over ${fadeIntoIt}s`); }
        const fadeOutOf = readNumber(input, 'fadeOutSeconds', 0);
        if (fadeOutOf > 0) { samples = fadeOut(samples, fadeOutOf); steps.push(`faded out over ${fadeOutOf}s`); }

        const gainDb = readNumber(input, 'gainDb', 0);
        if (gainDb !== 0) { samples = gain(samples, 10 ** (gainDb / 20)); steps.push(`level changed by ${gainDb} dB`); }

        const normalise = readEnum(input, 'normalise', ['none', 'peak', 'loudness'] as const, 'none');
        if (normalise === 'peak') {
          samples = normalisePeak(samples, readNumber(input, 'targetDb', -1));
          steps.push('normalised to peak');
        } else if (normalise === 'loudness') {
          samples = normaliseRms(samples, readNumber(input, 'targetDb', -18));
          steps.push('matched for loudness');
        }

        if (frameCount(samples) === 0) return errorResult('Those settings would leave nothing behind.');

        const depth = readEnum(input, 'bitDepth', DEPTHS.map(String) as ['16', '24', '32'], '16');
        const bytes = encodeWav(samples, Number(depth) as 16 | 24 | 32);

        return fileResult('edited.wav', bytes, 'audio/wav', {
          applied: steps.length ? steps : ['nothing, so this is a straight conversion to WAV'],
          duration: Number(duration(samples).toFixed(3)),
          sampleRate: samples.sampleRate,
          channels: samples.channels.length,
          peakDbfs: peak(samples) > 0 ? Number(gainToDecibels(peak(samples)).toFixed(1)) : null,
        });
      },
    },
    {
      name: 'cadence_join_audio',
      description:
        'Put several audio files end to end and return one WAV. Everything is brought up to the highest sample rate and widest channel count present, so a mono voice memo can sit next to a stereo recording without one playing at the wrong speed. An optional crossfade blends the joins.',
      inputSchema: {
        type: 'object',
        properties: {
          audio: { type: 'array', items: { type: 'string' }, description: 'Data URIs or URLs, in order.' },
          crossfadeSeconds: { type: 'number', description: 'How much the clips overlap. Zero by default.' },
          bitDepth: { type: 'number', enum: [16, 24, 32] },
        },
        required: ['audio'],
      },
      execute: async (input) => {
        const sources = readStringArray(input, 'audio');
        if (sources.length < 2) throw new Error('"audio" needs at least two files to join.');

        const clips: Samples[] = [];
        for (const source of sources) clips.push(await load(source));

        const crossfade = Math.max(0, readNumber(input, 'crossfadeSeconds', 0));
        const joined = join(clips, crossfade);
        const depth = readEnum(input, 'bitDepth', ['16', '24', '32'] as const, '16');

        return fileResult('joined.wav', encodeWav(joined, Number(depth) as 16 | 24 | 32), 'audio/wav', {
          clips: clips.length,
          lengths: clips.map((clip) => Number(duration(clip).toFixed(2))),
          crossfadeSeconds: crossfade,
          duration: Number(duration(joined).toFixed(3)),
          sampleRate: joined.sampleRate,
          channels: joined.channels.length,
        });
      },
    },
    {
      name: 'cadence_cut_section',
      description:
        'Remove a section from the middle of an audio file and join what is left. Use it to take out a stumble or a pause without splitting the file into pieces first.',
      inputSchema: {
        type: 'object',
        properties: {
          audio: { type: 'string' },
          start: { type: 'number', description: 'Seconds. Where the cut begins.' },
          end: { type: 'number', description: 'Seconds. Where the cut ends.' },
          bitDepth: { type: 'number', enum: [16, 24, 32] },
        },
        required: ['audio', 'start', 'end'],
      },
      execute: async (input) => {
        const samples = await load(requireString(input, 'audio'));
        const start = readNumber(input, 'start', 0);
        const end = readNumber(input, 'end', 0);
        if (end <= start) return errorResult('The end of the cut must come after its start.');

        const result = cut(samples, start, end);
        if (frameCount(result) === 0) return errorResult('That would remove the whole recording.');

        const depth = readEnum(input, 'bitDepth', ['16', '24', '32'] as const, '16');
        return fileResult('cut.wav', encodeWav(result, Number(depth) as 16 | 24 | 32), 'audio/wav', {
          removed: Number((end - start).toFixed(3)),
          was: Number(duration(samples).toFixed(3)),
          now: Number(duration(result).toFixed(3)),
        });
      },
    },
  ];
}

async function load(source: string): Promise<Samples> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`That audio could not be fetched (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  return decode(bytes, response.headers.get('content-type') ?? '');
}
