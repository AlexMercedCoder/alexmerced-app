import { describe, expect, it, vi } from 'vitest';
import { limelightTools } from './mcp';
import type { Clip } from './reel';

const clips = (): Clip[] => [
  { id: 'a', source: 'take-1', in: 0, out: 4 },
  { id: 'b', source: 'take-2', in: 0, out: 6 },
];

function harness(reel: Clip[] = clips()) {
  const edit = vi.fn();
  const state = {
    recording: { duration: 10, width: 1280, height: 720, blob: new Blob(), hasAudio: true, pointer: [], clicks: [], camera: null },
    points: [], interestSource: 'none',
    settings: {
      composition: { width: 1280, height: 720 }, zoom: {}, frameRate: 30,
      showClicks: true, showCursor: true,
      tilt: { x: 0, y: 0, rotate: 0, depth: 0.35 },
      motion: { entrance: 'none', exit: 'none', seconds: 0.6 },
    },
    track: [], crop: { x: 0, y: 0, width: 1, height: 1 }, trim: { start: 0, end: 10 },
    texts: [], zooms: [], cuts: [], loudness: null, looks: [], previewTime: 2, playing: false,
    clips: reel, sourceDurations: { 'take-1': 4, 'take-2': 6 },
  };
  const tools = limelightTools(() => state as never, edit);
  const call = async (name: string, input: Record<string, unknown>) => {
    const tool = tools.find((entry) => entry.name === name)!;
    return tool.execute(input);
  };
  return { edit, call };
}

describe('limelight_edit_reel', () => {
  it('moves a clip through the same reel edit channel as the UI', async () => {
    const { edit, call } = harness();
    await call('limelight_edit_reel', { action: 'move', id: 'b', index: 0 });
    expect(edit).toHaveBeenCalledWith({
      reel: { clips: [expect.objectContaining({ id: 'b' }), expect.objectContaining({ id: 'a' })], message: 'Moved the clip.' },
    });
  });

  it('updates clip trim and sound with source-duration bounds', async () => {
    const { edit, call } = harness();
    await call('limelight_edit_reel', {
      action: 'update', id: 'b', name: 'Close', in: 1, out: 99, gain: 1.5, muted: true, fadeIn: 0.5,
    });
    const reel = edit.mock.calls[0][0].reel;
    expect(reel.clips[1]).toMatchObject({ name: 'Close', in: 1, out: 6, gain: 1.5, muted: true, fadeIn: 0.5 });
  });

  it('splits without remapping timeline edits', async () => {
    const { edit, call } = harness();
    await call('limelight_edit_reel', { action: 'split', at: 2 });
    expect(edit.mock.calls[0][0].reel).toMatchObject({ preserveTimeline: true });
    expect(edit.mock.calls[0][0].reel.clips).toHaveLength(3);
  });

  it('refuses to remove the only remaining clip', async () => {
    const one = harness([clips()[0]]);
    await one.call('limelight_edit_reel', { action: 'remove', id: 'a' });
    expect(one.edit).not.toHaveBeenCalled();
  });
});
