import { fullFrame, isConvex, orderCorners, polygonArea, type Point } from './geometry';

/**
 * Finding the page in a photograph.
 *
 * The approach is deliberately simple and predictable rather than clever: blur,
 * take a gradient, threshold it, then find the outermost strong edge along
 * every row and column and fit four lines to those points. It handles a page on
 * a contrasting surface, which is the case that matters, and when it fails it
 * says so instead of returning a wrong quadrilateral.
 */

export type Gray = { width: number; height: number; data: Float32Array };

export function toGray(image: ImageData): Gray {
  const data = new Float32Array(image.width * image.height);
  for (let index = 0; index < data.length; index += 1) {
    const at = index * 4;
    // Rec. 601 luma, which tracks perceived brightness closely enough here.
    data[index] = (image.data[at] * 0.299 + image.data[at + 1] * 0.587 + image.data[at + 2] * 0.114) / 255;
  }
  return { width: image.width, height: image.height, data };
}

export function fromGray(gray: Gray): ImageData {
  const output = new ImageData(gray.width, gray.height);
  for (let index = 0; index < gray.data.length; index += 1) {
    const value = Math.round(Math.max(0, Math.min(1, gray.data[index])) * 255);
    const at = index * 4;
    output.data[at] = value;
    output.data[at + 1] = value;
    output.data[at + 2] = value;
    output.data[at + 3] = 255;
  }
  return output;
}

/**
 * Separable box blur, run a few times, which approximates a Gaussian cheaply.
 *
 * The window is carried along as a running sum rather than re-added at every
 * pixel, so the cost does not depend on the radius. That matters because
 * flattening the lighting on a phone photo wants a radius of a hundred pixels,
 * and re-adding the window each time would take minutes.
 */
export function blur(gray: Gray, radius: number, passes = 2): Gray {
  if (radius < 1 || passes < 1) return gray;
  const { width, height } = gray;

  // Two buffers, swapped between passes, so nothing is allocated in the loop.
  let read = Float32Array.from(gray.data);
  let write = new Float32Array(read.length);

  for (let pass = 0; pass < passes; pass += 1) {
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let sum = 0;
      let count = 0;
      for (let x = 0; x <= Math.min(radius, width - 1); x += 1) {
        sum += read[row + x];
        count += 1;
      }
      for (let x = 0; x < width; x += 1) {
        write[row + x] = sum / count;
        const leaving = x - radius;
        const entering = x + radius + 1;
        if (leaving >= 0) { sum -= read[row + leaving]; count -= 1; }
        if (entering < width) { sum += read[row + entering]; count += 1; }
      }
    }
    [read, write] = [write, read];

    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let y = 0; y <= Math.min(radius, height - 1); y += 1) {
        sum += read[y * width + x];
        count += 1;
      }
      for (let y = 0; y < height; y += 1) {
        write[y * width + x] = sum / count;
        const leaving = y - radius;
        const entering = y + radius + 1;
        if (leaving >= 0) { sum -= read[leaving * width + x]; count -= 1; }
        if (entering < height) { sum += read[entering * width + x]; count += 1; }
      }
    }
    [read, write] = [write, read];
  }

  return { width, height, data: read };
}

/** Sobel gradient magnitude, normalised so the strongest edge is 1. */
export function edges(gray: Gray): Gray {
  const { width, height } = gray;
  const output = new Float32Array(width * height);
  let strongest = 0;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = (dx: number, dy: number) => gray.data[(y + dy) * width + (x + dx)];
      const gx =
        -at(-1, -1) - 2 * at(-1, 0) - at(-1, 1) + at(1, -1) + 2 * at(1, 0) + at(1, 1);
      const gy =
        -at(-1, -1) - 2 * at(0, -1) - at(1, -1) + at(-1, 1) + 2 * at(0, 1) + at(1, 1);
      const magnitude = Math.hypot(gx, gy);
      output[y * width + x] = magnitude;
      if (magnitude > strongest) strongest = magnitude;
    }
  }

  if (strongest > 0) {
    for (let index = 0; index < output.length; index += 1) output[index] /= strongest;
  }
  return { width, height, data: output };
}

/**
 * Otsu's method: picks the brightness that best separates the histogram into
 * two groups. Used both for thresholding edges and for the final black and
 * white output.
 */
export function otsuThreshold(gray: Gray, bins = 64): number {
  const histogram = new Float64Array(bins);
  for (const value of gray.data) {
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(value * bins)));
    histogram[bin] += 1;
  }

  const total = gray.data.length;
  if (total === 0) return 0.5;

  let sum = 0;
  for (let bin = 0; bin < bins; bin += 1) sum += bin * histogram[bin];

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  // When the two groups are well separated, every threshold between them scores
  // identically. Tracking the whole plateau and taking its middle puts the cut
  // in the gap rather than hard against one of the groups.
  let firstBest = bins / 2;
  let lastBest = bins / 2;

  for (let bin = 0; bin < bins; bin += 1) {
    weightBackground += histogram[bin];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += bin * histogram[bin];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const between = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

    if (between > best * (1 + 1e-9)) {
      best = between;
      firstBest = bin;
      lastBest = bin;
    } else if (between >= best * (1 - 1e-9)) {
      lastBest = bin;
    }
  }

  return ((firstBest + lastBest) / 2 + 0.5) / bins;
}

export type Detection = { corners: Point[]; confident: boolean };

/**
 * Looks for the page outline. Returns the whole frame with confident set to
 * false when nothing convincing is found, so the caller can say "drag the
 * corners yourself" rather than silently cropping the wrong thing.
 */
export function detectPage(image: ImageData): Detection {
  const frame = fullFrame(image.width, image.height);
  if (image.width < 16 || image.height < 16) return { corners: frame, confident: false };

  const gray = toGray(image);
  const smoothed = blur(gray, Math.max(1, Math.round(Math.min(image.width, image.height) / 200)));
  const gradient = edges(smoothed);
  const threshold = Math.max(0.12, otsuThreshold(gradient));

  const { width, height } = gradient;
  // Ignore a border strip, since the frame edge itself often reads as a strong
  // gradient and would be mistaken for the page.
  const margin = Math.max(1, Math.round(Math.min(width, height) * 0.01));

  const top: Point[] = [];
  const bottom: Point[] = [];
  const left: Point[] = [];
  const right: Point[] = [];

  const strong = (x: number, y: number) => gradient.data[y * width + x] >= threshold;

  for (let x = margin; x < width - margin; x += 1) {
    for (let y = margin; y < height - margin; y += 1) {
      if (strong(x, y)) { top.push({ x, y }); break; }
    }
    for (let y = height - margin - 1; y >= margin; y -= 1) {
      if (strong(x, y)) { bottom.push({ x, y }); break; }
    }
  }
  for (let y = margin; y < height - margin; y += 1) {
    for (let x = margin; x < width - margin; x += 1) {
      if (strong(x, y)) { left.push({ x, y }); break; }
    }
    for (let x = width - margin - 1; x >= margin; x -= 1) {
      if (strong(x, y)) { right.push({ x, y }); break; }
    }
  }

  const coverage = Math.min(top.length / width, left.length / height);
  if (coverage < 0.5) return { corners: frame, confident: false };

  // Fit a line to each side, throwing away the outer fifth of each run where a
  // shadow or a thumb tends to sit.
  const horizontalTop = fitLine(trimEnds(top), 'horizontal');
  const horizontalBottom = fitLine(trimEnds(bottom), 'horizontal');
  const verticalLeft = fitLine(trimEnds(left), 'vertical');
  const verticalRight = fitLine(trimEnds(right), 'vertical');

  if (!horizontalTop || !horizontalBottom || !verticalLeft || !verticalRight) {
    return { corners: frame, confident: false };
  }

  const candidates = [
    intersect(horizontalTop, verticalLeft),
    intersect(horizontalTop, verticalRight),
    intersect(horizontalBottom, verticalRight),
    intersect(horizontalBottom, verticalLeft),
  ];

  if (candidates.some((point) => point === null)) return { corners: frame, confident: false };
  const corners = orderCorners(candidates as Point[]);

  // A result that is not convex, or that covers almost none of the frame, is
  // not a page. Nor is one that fills the searched region entirely: that is
  // what noise or an edge-to-edge texture produces, and in that case the whole
  // frame is the right answer anyway.
  const area = polygonArea(corners);
  const frameArea = width * height;
  const searchArea = Math.max(1, (width - margin * 2) * (height - margin * 2));
  const inside = corners.every((point) => point.x >= -width * 0.05 && point.x <= width * 1.05 && point.y >= -height * 0.05 && point.y <= height * 1.05);

  if (!isConvex(corners) || !inside || area < frameArea * 0.08 || area > searchArea * 0.97) {
    return { corners: frame, confident: false };
  }

  // The last question is the one a person would ask: is there actually a page
  // edge here? Four fitted lines can be drawn through anything, but only a real
  // boundary has the paper bright on one side and the surface dark on the
  // other. Noise and texture fail this; a page on a desk passes it easily.
  if (edgeContrast(smoothed, corners) < 0.06) {
    return { corners: frame, confident: false };
  }

  return { corners, confident: true };
}

/**
 * Mean brightness step across the four edges, sampled a little way in and a
 * little way out along each edge's normal.
 */
export function edgeContrast(gray: Gray, corners: Point[], samples = 24): number {
  const reach = Math.max(2, Math.round(Math.min(gray.width, gray.height) * 0.02));

  const at = (x: number, y: number): number | null => {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= gray.width || py >= gray.height) return null;
    return gray.data[py * gray.width + px];
  };

  let total = 0;
  let counted = 0;

  for (let edge = 0; edge < 4; edge += 1) {
    const from = corners[edge];
    const to = corners[(edge + 1) % 4];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length < 1) continue;

    // The outward normal, given corners wound in reading order.
    const nx = (to.y - from.y) / length;
    const ny = -(to.x - from.x) / length;

    for (let step = 1; step < samples; step += 1) {
      const position = step / samples;
      const x = from.x + (to.x - from.x) * position;
      const y = from.y + (to.y - from.y) * position;
      const outer = at(x + nx * reach, y + ny * reach);
      const inner = at(x - nx * reach, y - ny * reach);
      if (outer === null || inner === null) continue;
      total += Math.abs(inner - outer);
      counted += 1;
    }
  }

  return counted === 0 ? 0 : total / counted;
}

function trimEnds(points: Point[]): Point[] {
  if (points.length < 10) return points;
  const cut = Math.floor(points.length * 0.2);
  return points.slice(cut, points.length - cut);
}

export type Line = { a: number; b: number; c: number };

/**
 * Least squares fit. A horizontal edge is fitted as y = mx + k and a vertical
 * one as x = my + k, so neither ever needs an infinite slope.
 */
export function fitLine(points: Point[], orientation: 'horizontal' | 'vertical'): Line | null {
  if (points.length < 2) return null;

  const xs = orientation === 'horizontal' ? points.map((point) => point.x) : points.map((point) => point.y);
  const ys = orientation === 'horizontal' ? points.map((point) => point.y) : points.map((point) => point.x);

  const n = xs.length;
  const meanX = xs.reduce((sum, value) => sum + value, 0) / n;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY);
    denominator += (xs[index] - meanX) ** 2;
  }
  if (denominator === 0) {
    // Every point shares one coordinate, so the line is exactly axis aligned.
    return orientation === 'horizontal' ? { a: 0, b: 1, c: -meanY } : { a: 1, b: 0, c: -meanX };
  }

  const slope = numerator / denominator;
  const intercept = meanY - slope * meanX;

  // ax + by + c = 0
  return orientation === 'horizontal'
    ? { a: slope, b: -1, c: intercept }
    : { a: -1, b: slope, c: intercept };
}

export function intersect(first: Line, second: Line): Point | null {
  const determinant = first.a * second.b - second.a * first.b;
  if (Math.abs(determinant) < 1e-9) return null;
  return {
    x: (first.b * second.c - second.b * first.c) / determinant,
    y: (second.a * first.c - first.a * second.c) / determinant,
  };
}

export type Finish = 'colour' | 'grayscale' | 'contrast' | 'blackAndWhite';

/**
 * Turns a warped page into something worth reading. The black and white pass
 * uses a local threshold rather than a global one, because a photograph of a
 * page is almost never lit evenly and a single cutoff loses a whole corner.
 */
export function finish(image: ImageData, mode: Finish, strength = 1): ImageData {
  if (mode === 'colour') return image;

  const gray = toGray(image);

  if (mode === 'grayscale') return fromGray(gray);

  if (mode === 'contrast') {
    // Divide by a heavily blurred copy to flatten the lighting, then stretch.
    const background = blur(gray, Math.max(4, Math.round(Math.min(gray.width, gray.height) / 24)), 2);
    const output = new Float32Array(gray.data.length);
    for (let index = 0; index < output.length; index += 1) {
      const base = Math.max(0.05, background.data[index]);
      const flattened = gray.data[index] / base;
      output[index] = clamp01((flattened - 1) * (1.4 * strength) + 0.92);
    }
    return fromGray({ width: gray.width, height: gray.height, data: output });
  }

  // Adaptive threshold, comparing each pixel with the local average.
  const window = Math.max(8, Math.round(Math.min(gray.width, gray.height) / 20));
  const local = blur(gray, window, 1);
  const bias = 0.02 * strength;
  const output = new Float32Array(gray.data.length);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = gray.data[index] < local.data[index] - bias ? 0 : 1;
  }
  return fromGray({ width: gray.width, height: gray.height, data: output });
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** How much of the image is ink, which is a useful sanity check on a threshold. */
export function inkFraction(image: ImageData): number {
  let dark = 0;
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index] < 128) dark += 1;
  }
  return dark / (image.data.length / 4);
}
