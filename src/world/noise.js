// Deterministic value noise. Seeded integer hashing means the same seed always
// produces the same world, with no allocation and no permutation tables.

function hash2(x, y, seed) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

function hash3(x, y, z, seed) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 2147483647 + (seed | 0) * 1442695041;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

// Quintic fade -- smoother second derivative than smoothstep, so terrain
// silhouettes don't show grid-aligned creases.
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

export function value2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = fade(x - xi), yf = fade(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, xf), lerp(c, d, xf), yf);
}

export function value3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
  const c000 = hash3(xi, yi, zi, seed),     c100 = hash3(xi + 1, yi, zi, seed);
  const c010 = hash3(xi, yi + 1, zi, seed), c110 = hash3(xi + 1, yi + 1, zi, seed);
  const c001 = hash3(xi, yi, zi + 1, seed), c101 = hash3(xi + 1, yi, zi + 1, seed);
  const c011 = hash3(xi, yi + 1, zi + 1, seed), c111 = hash3(xi + 1, yi + 1, zi + 1, seed);
  const x00 = lerp(c000, c100, xf), x10 = lerp(c010, c110, xf);
  const x01 = lerp(c001, c101, xf), x11 = lerp(c011, c111, xf);
  return lerp(lerp(x00, x10, yf), lerp(x01, x11, yf), zf);
}

/** Fractal Brownian motion -- stacked octaves at halving amplitude. Returns 0..1 */
export function fbm2(x, y, seed, octaves = 4, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += value2(x * freq, y * freq, seed + i * 7919) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Deterministic 0..1 roll for "does a tree spawn here" style decisions. */
export function rand2(x, y, seed) { return hash2(x, y, seed); }
