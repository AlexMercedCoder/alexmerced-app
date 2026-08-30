import { applyMatrix, homography, type Point } from '../../lib/homography';
import { decodeMatrix, DecodeError, type DecodeResult, type Modules } from './decode';

/**
 * Finding a QR code in a picture and reading it.
 *
 * The three big squares in the corners are the whole trick. They are built so
 * that a line through any of them, at any angle, crosses dark and light in the
 * ratio 1:1:3:1:1. Nothing else in a normal photograph does that, so scanning
 * every row for that ratio finds them, and three known points are enough to
 * work out where the rest of the grid must be.
 */

export type Binary = { width: number; height: number; data: Uint8Array };

export type ScanResult = DecodeResult & {
  /** The four corners of the symbol in the source image, for drawing over it. */
  corners: Point[];
  /** True when the code was light on dark and had to be inverted. */
  inverted: boolean;
};

export class ScanError extends Error {}

// --------------------------------------------------------------------- binarising

export function toLuma(image: ImageData): Uint8Array {
  const data = new Uint8Array(image.width * image.height);
  for (let index = 0; index < data.length; index += 1) {
    const at = index * 4;
    data[index] = (image.data[at] * 77 + image.data[at + 1] * 150 + image.data[at + 2] * 29) >> 8;
  }
  return data;
}

/**
 * Local thresholding on a grid of blocks. A photograph of a code on a screen or
 * a curved label is never lit evenly, and one global cutoff loses a corner.
 */
export function binarise(luma: Uint8Array, width: number, height: number, blockSize = 16): Binary {
  const data = new Uint8Array(width * height);
  const columns = Math.max(1, Math.ceil(width / blockSize));
  const rows = Math.max(1, Math.ceil(height / blockSize));
  const averages = new Float32Array(columns * rows);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      let sum = 0;
      let count = 0;
      let low = 255;
      let high = 0;
      const x0 = column * blockSize;
      const y0 = row * blockSize;
      for (let y = y0; y < Math.min(height, y0 + blockSize); y += 1) {
        for (let x = x0; x < Math.min(width, x0 + blockSize); x += 1) {
          const value = luma[y * width + x];
          sum += value;
          count += 1;
          if (value < low) low = value;
          if (value > high) high = value;
        }
      }
      const average = count ? sum / count : 128;
      // A block with almost no contrast is all paper or all ink. Judging it on
      // its own average would turn flat white into checkerboard noise, so it
      // takes its cue from the block above and to the left instead.
      averages[row * columns + column] =
        high - low > 24
          ? average
          : row > 0 && column > 0
            ? (averages[(row - 1) * columns + column] + averages[row * columns + column - 1]) / 2
            : average;
    }
  }

  // Smooth across neighbouring blocks so the threshold does not step visibly.
  for (let y = 0; y < height; y += 1) {
    const row = Math.min(rows - 1, Math.floor(y / blockSize));
    for (let x = 0; x < width; x += 1) {
      const column = Math.min(columns - 1, Math.floor(x / blockSize));
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const r = row + dy;
          const c = column + dx;
          if (r < 0 || c < 0 || r >= rows || c >= columns) continue;
          sum += averages[r * columns + c];
          count += 1;
        }
      }
      data[y * width + x] = luma[y * width + x] < sum / count - 3 ? 1 : 0;
    }
  }

  return { width, height, data };
}

export function invert(binary: Binary): Binary {
  const data = new Uint8Array(binary.data.length);
  for (let index = 0; index < data.length; index += 1) data[index] = binary.data[index] ? 0 : 1;
  return { width: binary.width, height: binary.height, data };
}

// --------------------------------------------------------------------- finders

export type Finder = { x: number; y: number; moduleSize: number };

/** True when five consecutive runs are close enough to 1:1:3:1:1. */
export function isFinderRatio(runs: number[]): boolean {
  if (runs.length !== 5) return false;
  const total = runs.reduce((sum, run) => sum + run, 0);
  if (total < 7) return false;

  const unit = total / 7;
  // Half a module of slack per module of width, which is what survives blur
  // without letting a plain even stripe through.
  const expected = [1, 1, 3, 1, 1];
  for (let index = 0; index < 5; index += 1) {
    if (Math.abs(runs[index] - expected[index] * unit) >= expected[index] * unit * 0.5) return false;
  }
  return true;
}

/**
 * Scans one line for the finder ratio, returning the centre of each match.
 *
 * The window holds the last five completed runs. A finder ends on a dark run,
 * so the check happens the moment a dark run finishes, with the five runs
 * before the current position sitting in the window.
 */
function scanLine(
  read: (position: number) => number,
  length: number,
): { centre: number; unit: number }[] {
  const hits: { centre: number; unit: number }[] = [];
  if (length < 7) return hits;

  const runs = [0, 0, 0, 0, 0];
  let current = read(0);
  let runLength = 0;
  let completed = 0;

  const consider = (endsAt: number) => {
    if (completed < 5 || !isFinderRatio(runs)) return;
    const total = runs.reduce((sum, run) => sum + run, 0);
    // The middle of the third run, counting back from where the fifth ended.
    hits.push({ centre: endsAt - runs[4] - runs[3] - runs[2] / 2, unit: total / 7 });
  };

  for (let position = 0; position < length; position += 1) {
    const value = read(position);
    if (value === current) {
      runLength += 1;
      continue;
    }
    runs.shift();
    runs.push(runLength);
    completed += 1;
    // The run that just ended was dark exactly when current is still dark.
    if (current === 1) consider(position);
    current = value;
    runLength = 1;
  }

  // The line can end part way through the final dark run.
  if (current === 1) {
    runs.shift();
    runs.push(runLength);
    completed += 1;
    consider(length);
  }

  return hits;
}

/**
 * Finds the three big corner squares. A candidate has to show the ratio both
 * across and down, which rules out the stray horizontal bands that text and
 * barcodes produce.
 */
export function findFinders(binary: Binary): Finder[] {
  const { width, height, data } = binary;
  const candidates: Finder[] = [];

  // Every third row is enough: a finder is seven modules tall, and a code worth
  // reading is at least two pixels per module.
  const step = Math.max(1, Math.floor(Math.min(width, height) / 300));

  for (let y = 0; y < height; y += step) {
    for (const hit of scanLine((x) => data[y * width + x], width)) {
      const x = Math.round(hit.centre);
      if (x < 0 || x >= width) continue;

      const vertical = scanLine((position) => data[position * width + x], height)
        .find((entry) => Math.abs(entry.centre - y) <= hit.unit * 2.5
          && entry.unit > hit.unit * 0.6 && entry.unit < hit.unit * 1.7);
      if (!vertical) continue;

      candidates.push({ x: hit.centre, y: vertical.centre, moduleSize: (hit.unit + vertical.unit) / 2 });
    }
  }

  return clusterFinders(candidates);
}

/** Merges the many hits each finder produces into one point apiece. */
export function clusterFinders(candidates: Finder[]): Finder[] {
  const clusters: { sumX: number; sumY: number; sumModule: number; count: number }[] = [];

  for (const candidate of candidates) {
    const existing = clusters.find((cluster) => {
      const x = cluster.sumX / cluster.count;
      const y = cluster.sumY / cluster.count;
      const module = cluster.sumModule / cluster.count;
      return Math.hypot(x - candidate.x, y - candidate.y) < module * 3.5;
    });

    if (existing) {
      existing.sumX += candidate.x;
      existing.sumY += candidate.y;
      existing.sumModule += candidate.moduleSize;
      existing.count += 1;
    } else {
      clusters.push({ sumX: candidate.x, sumY: candidate.y, sumModule: candidate.moduleSize, count: 1 });
    }
  }

  return clusters
    // A single stray hit is noise. A real finder is seen on many rows.
    .filter((cluster) => cluster.count >= 2)
    .sort((a, b) => b.count - a.count)
    .map((cluster) => ({
      x: cluster.sumX / cluster.count,
      y: cluster.sumY / cluster.count,
      moduleSize: cluster.sumModule / cluster.count,
    }));
}

/**
 * Works out which finder is which. The corner between the two longest sides of
 * the triangle is the top left, and the cross product of the other two decides
 * which of them is the top right.
 */
export function orientFinders(finders: Finder[]): { topLeft: Finder; topRight: Finder; bottomLeft: Finder } {
  if (finders.length < 3) throw new ScanError('Only found part of a QR code. Try a straighter, closer picture.');
  const [a, b, c] = finders.slice(0, 3);

  const sides: [number, Finder, Finder, Finder][] = [
    [Math.hypot(b.x - c.x, b.y - c.y), a, b, c],
    [Math.hypot(a.x - c.x, a.y - c.y), b, a, c],
    [Math.hypot(a.x - b.x, a.y - b.y), c, a, b],
  ];
  // The corner opposite the longest side is the top left.
  sides.sort((first, second) => second[0] - first[0]);
  const [, topLeft, first, second] = sides[0];

  // Positive cross product means the second point is clockwise from the first.
  const cross =
    (first.x - topLeft.x) * (second.y - topLeft.y) - (first.y - topLeft.y) * (second.x - topLeft.x);

  return cross < 0
    ? { topLeft, topRight: second, bottomLeft: first }
    : { topLeft, topRight: first, bottomLeft: second };
}

/** Guesses the version from how far apart the finders sit. */
export function estimateVersion(topLeft: Finder, topRight: Finder, bottomLeft: Finder): number {
  const across = Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y);
  const down = Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y);
  const module = (topLeft.moduleSize + topRight.moduleSize + bottomLeft.moduleSize) / 3;
  if (module <= 0) throw new ScanError('The code is too small in this picture to measure.');

  // Finder centres sit 3.5 modules in from each edge, so their spacing is the
  // full width less seven modules.
  const modules = (across + down) / 2 / module + 7;
  const version = Math.round((modules - 17) / 4);
  return Math.max(1, Math.min(40, version));
}

// --------------------------------------------------------------------- sampling

/**
 * Samples the grid. The four corners of the symbol are known from the finder
 * centres, so a homography maps module coordinates onto image pixels directly.
 */
export function sampleGrid(binary: Binary, corners: Point[], size: number): Modules {
  const matrix = homography(
    [{ x: 0, y: 0 }, { x: size, y: 0 }, { x: size, y: size }, { x: 0, y: size }],
    corners,
  );

  const modules: Modules = [];
  for (let y = 0; y < size; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x += 1) {
      // Three samples across the module, so one stray pixel cannot flip it.
      let dark = 0;
      let total = 0;
      for (const [dx, dy] of [[0.5, 0.5], [0.35, 0.5], [0.65, 0.5], [0.5, 0.35], [0.5, 0.65]]) {
        const point = applyMatrix(matrix, { x: x + dx, y: y + dy });
        const px = Math.round(point.x);
        const py = Math.round(point.y);
        if (px < 0 || py < 0 || px >= binary.width || py >= binary.height) continue;
        dark += binary.data[py * binary.width + px];
        total += 1;
      }
      row.push(total === 0 ? false : dark * 2 > total);
    }
    modules.push(row);
  }
  return modules;
}

/**
 * Works out the four outer corners of the symbol from three finder centres.
 * The fourth corner is the parallelogram completion, which is exact for a code
 * that is merely rotated and close enough for a mild perspective.
 */
export function symbolCorners(
  topLeft: Finder, topRight: Finder, bottomLeft: Finder, size: number,
): Point[] {
  // Each finder centre is 3.5 modules in from two edges. Working in the frame
  // the finders define lets that offset be expressed without trigonometry.
  const acrossX = (topRight.x - topLeft.x) / (size - 7);
  const acrossY = (topRight.y - topLeft.y) / (size - 7);
  const downX = (bottomLeft.x - topLeft.x) / (size - 7);
  const downY = (bottomLeft.y - topLeft.y) / (size - 7);

  const at = (column: number, row: number): Point => ({
    x: topLeft.x + acrossX * (column - 3.5) + downX * (row - 3.5),
    y: topLeft.y + acrossY * (column - 3.5) + downY * (row - 3.5),
  });

  return [at(0, 0), at(size, 0), at(size, size), at(0, size)];
}

// --------------------------------------------------------------------- entry point

/**
 * Reads whatever QR code is in the image. Both polarities are tried, and a few
 * nearby versions, because the estimate from finder spacing can be one out on a
 * blurred picture and being wrong by one is cheap to check.
 */
export function scanImage(image: ImageData): ScanResult {
  const luma = toLuma(image);
  const upright = binarise(luma, image.width, image.height);

  const attempts: { binary: Binary; inverted: boolean }[] = [
    { binary: upright, inverted: false },
    { binary: invert(upright), inverted: true },
  ];

  let lastError: Error | null = null;

  for (const attempt of attempts) {
    let finders: Finder[];
    try {
      finders = findFinders(attempt.binary);
      const oriented = orientFinders(finders);
      const estimate = estimateVersion(oriented.topLeft, oriented.topRight, oriented.bottomLeft);

      for (const version of nearbyVersions(estimate)) {
        const size = version * 4 + 17;
        const corners = symbolCorners(oriented.topLeft, oriented.topRight, oriented.bottomLeft, size);
        try {
          const modules = sampleGrid(attempt.binary, corners, size);
          const result = decodeMatrix(modules);
          return { ...result, corners, inverted: attempt.inverted };
        } catch (error) {
          lastError = error as Error;
        }
      }
    } catch (error) {
      lastError = error as Error;
    }
  }

  if (lastError instanceof DecodeError) throw new ScanError(lastError.message);
  throw new ScanError(
    lastError?.message ?? 'No QR code was found in this image. Try a closer, straighter picture.',
  );
}

/** The estimate first, then its neighbours, since blur can shift it by one. */
export function nearbyVersions(estimate: number): number[] {
  const versions = [estimate, estimate - 1, estimate + 1, estimate - 2, estimate + 2];
  return versions.filter((version, index) => version >= 1 && version <= 40 && versions.indexOf(version) === index);
}

/**
 * Renders a matrix as an image, at a given scale. Used by the tests to make a
 * picture the scanner then has to read back, which is the only way to exercise
 * the whole path without a camera.
 */
export function matrixToImage(modules: Modules, scale: number, quiet = 4): ImageData {
  const size = modules.length;
  const side = (size + quiet * 2) * scale;
  const image = new ImageData(side, side);

  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const column = Math.floor(x / scale) - quiet;
      const row = Math.floor(y / scale) - quiet;
      const dark = row >= 0 && column >= 0 && row < size && column < size && modules[row][column];
      const value = dark ? 0 : 255;
      const at = (y * side + x) * 4;
      image.data[at] = value;
      image.data[at + 1] = value;
      image.data[at + 2] = value;
      image.data[at + 3] = 255;
    }
  }
  return image;
}
