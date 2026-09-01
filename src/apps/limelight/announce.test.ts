import { describe, expect, it } from 'vitest';
import {
  asPercent, emptyMemory, isRepeat, mountSpeaker, progressWorthSaying,
} from './announce';

describe('isRepeat', () => {
  it('catches the same words arriving twice from two renders', () => {
    const memory = { text: 'Zoom added', at: 1000, ratio: -1 };
    expect(isRepeat('Zoom added', memory, 1100)).toBe(true);
  });

  it('lets the same words through once enough time has passed', () => {
    // Adding two zooms in a row is two events, and both should be heard.
    const memory = { text: 'Zoom added', at: 1000, ratio: -1 };
    expect(isRepeat('Zoom added', memory, 3000)).toBe(false);
  });

  it('never suppresses different words', () => {
    const memory = { text: 'Zoom added', at: 1000, ratio: -1 };
    expect(isRepeat('Zoom removed', memory, 1001)).toBe(false);
  });
});

describe('progressWorthSaying', () => {
  it('says the first figure it is given', () => {
    expect(progressWorthSaying(0.1, emptyMemory(), 0)).toBe(true);
  });

  it('stays quiet until a quarter more has been done', () => {
    const memory = { text: '', at: 0, ratio: 0.25 };
    expect(progressWorthSaying(0.3, memory, 100)).toBe(false);
    expect(progressWorthSaying(0.49, memory, 100)).toBe(false);
    expect(progressWorthSaying(0.5, memory, 100)).toBe(true);
  });

  it('always says the end, however close the last figure was', () => {
    const memory = { text: '', at: 0, ratio: 0.99 };
    expect(progressWorthSaying(1, memory, 10)).toBe(true);
  });

  it('does not say the end twice', () => {
    const memory = { text: '', at: 0, ratio: 1 };
    expect(progressWorthSaying(1, memory, 10)).toBe(false);
  });

  it('falls back to the clock when a stage reports no figure', () => {
    // Fetching a model reports nothing for a while. Silence reads as a hang.
    const memory = { text: 'Fetching the model', at: 0, ratio: -1 };
    expect(progressWorthSaying(null, memory, 1000)).toBe(false);
    expect(progressWorthSaying(null, memory, 6000)).toBe(true);
  });
});

describe('asPercent', () => {
  it('rounds to whole percent', () => {
    expect(asPercent(0.256)).toBe('26%');
  });

  it('clamps rather than saying a hundred and four percent', () => {
    expect(asPercent(1.04)).toBe('100%');
    expect(asPercent(-0.2)).toBe('0%');
  });
});

describe('mountSpeaker', () => {
  const region = () => ({ textContent: '' }) as HTMLElement;

  it('writes what happened into the region', () => {
    const element = region();
    let now = 0;
    mountSpeaker(element, () => now).say('Zoom added at 4 seconds');
    expect(element.textContent).toBe('Zoom added at 4 seconds');
  });

  it('ignores a blank message rather than clearing the region', () => {
    const element = region();
    const speaker = mountSpeaker(element, () => 0);
    speaker.say('Recording started');
    speaker.say('   ');
    expect(element.textContent).toBe('Recording started');
  });

  it('does not write the same thing twice in a row', () => {
    const element = region();
    let now = 0;
    const speaker = mountSpeaker(element, () => now);
    speaker.say('Caption added');
    element.textContent = 'tampered';
    now = 100;
    speaker.say('Caption added');
    expect(element.textContent).toBe('tampered');
  });

  it('lets a quarter of progress through and swallows the rest', () => {
    const element = region();
    let now = 0;
    const speaker = mountSpeaker(element, () => now);
    const said: string[] = [];
    for (const ratio of [0, 0.05, 0.1, 0.26, 0.3, 0.51, 0.8, 1]) {
      now += 100;
      const before = element.textContent;
      speaker.progress('Exporting', ratio);
      if (element.textContent !== before) said.push(element.textContent!);
    }
    expect(said).toEqual([
      'Exporting, 0%', 'Exporting, 26%', 'Exporting, 51%', 'Exporting, 80%', 'Exporting, 100%',
    ]);
  });

  it('starts again after a stage settles', () => {
    const element = region();
    let now = 0;
    const speaker = mountSpeaker(element, () => now);
    speaker.progress('Exporting', 0.9);
    speaker.settle();
    now = 10;
    speaker.progress('Writing the file', 0.1);
    expect(element.textContent).toBe('Writing the file, 10%');
  });
});
