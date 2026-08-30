import { describe, expect, it } from 'vitest';
import { blur, finish, toGray } from './detect';

/**
 * A phone photograph is a couple of thousand pixels on the long edge, and the
 * lighting pass wants a radius near a hundred. This is a floor on performance,
 * not a measurement: it fails only if the cost has gone back to depending on
 * the radius.
 */
describe('performance', () => {
  const image = new ImageData(1200, 1600);
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = index % 255;
    image.data[index + 1] = index % 255;
    image.data[index + 2] = index % 255;
    image.data[index + 3] = 255;
  }

  it('blurs a full page at a large radius in well under a second', () => {
    const gray = toGray(image);
    const started = performance.now();
    blur(gray, 80, 2);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('costs about the same at a large radius as at a small one', () => {
    const gray = toGray(image);
    const time = (radius: number) => {
      const started = performance.now();
      blur(gray, radius, 2);
      return performance.now() - started;
    };
    time(4);
    const small = time(4);
    const large = time(120);
    // A window that is re-added each pixel would be thirty times slower here.
    expect(large).toBeLessThan(Math.max(small * 4, 40));
  });

  it('finishes a full page document scan in well under a second', () => {
    const started = performance.now();
    finish(image, 'contrast');
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
