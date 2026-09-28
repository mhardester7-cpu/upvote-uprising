// Procedural zombie skin: albedo / normal / roughness atlas built from noise.
//
// There is no asset pipeline in this project, so every texel here is generated
// at runtime into a CanvasTexture. The whole horde shares exactly one atlas --
// three 512px maps, built once, lazily, on the first spawn -- because texture
// memory and (more importantly) texture *binds* are what a large horde cannot
// afford.
//
// Layout (canvas pixels, 512x512):
//
//   +-----------------+-----------------+
//   |  FLESH (tiling) |  CLOTH (tiling) |
//   |   0,0  256x256  |  256,0 256x256  |
//   +-----------------+--------+--------+
//   |  HEAD (unique)  |  BONE  | WOUND  |
//   |  0,256 256x256  |        |        |
//   |                 +--------+--------+
//   |                 |   GORE (tiling) |
//   +-----------------+-----------------+
//
// Each body part maps its own [0..1]^2 parameter space into one region, so no
// UV tiling (and therefore no wrapped-UV seams) is ever needed: a thigh gets
// the whole 256px flesh tile stretched over it, which works out to roughly
// 500 texels per metre -- plenty at combat range.

import * as THREE from '../../vendor/three.module.js';

export const TEX = 512;

/** Region rectangles in canvas pixels: [x, y, w, h]. */
export const REGION = {
  flesh: [0, 0, 256, 256],
  cloth: [256, 0, 256, 256],
  head: [0, 256, 256, 256],
  bone: [256, 256, 128, 128],
  wound: [384, 256, 128, 128],
  gore: [256, 384, 256, 128],
};

// Half a texel of inset stops bilinear filtering from dragging a neighbouring
// region across a UV island edge at coarse mip levels.
const INSET = 1.0;

/**
 * Map a part-local (s, t) in [0,1]^2 into an atlas region. t runs upward, which
 * matches the way limbs are lofted (t = 0 at the far end of the bone).
 */
export function regionUV(region, s, t, out) {
  const [rx, ry, rw, rh] = region;
  const px = rx + INSET + s * (rw - INSET * 2);
  const py = ry + INSET + (1 - t) * (rh - INSET * 2);
  out[0] = px / TEX;
  out[1] = 1 - py / TEX;
  return out;
}

// ------------------------------------------------------------------- noise

/** Integer hash -> [0,1). Cheap and good enough for value noise. */
function hashi(x, y, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Value noise on a lattice that wraps every `period` cells, which is what makes
 * the tiling regions seamless when a part's UVs run the full 0..1 of the tile.
 */
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const p = period | 0;
  const wrap = (a) => ((a % p) + p) % p;
  const x0 = wrap(xi), x1 = wrap(xi + 1), y0 = wrap(yi), y1 = wrap(yi + 1);
  const a = hashi(x0, y0, seed), b = hashi(x1, y0, seed);
  const c = hashi(x0, y1, seed), d = hashi(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/** Fractal sum. Period doubles with frequency so the wrap survives. */
function fbm(x, y, period, seed, oct = 3) {
  let amp = 0.5, sum = 0, norm = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, y * f, period * f, seed + i * 131);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Ridged noise -- the |1-2n| fold is what turns blobs into veins and cracks. */
function ridge(x, y, period, seed, oct = 3) {
  return 1 - Math.abs(fbm(x, y, period, seed, oct) * 2 - 1);
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------- canvas

function createCanvas(w, h) {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

/**
 * Per-pixel writer over one atlas region. `fn(u, v, out)` fills
 * out = [r, g, b, height, roughness] with everything in 0..1; height feeds the
 * normal map and roughness the roughness map, so all three maps come out of a
 * single pass over the region instead of three.
 */
function paintRegion(alb, hgt, rgh, region, fn) {
  const [rx, ry, rw, rh] = region;
  const a = alb.getImageData(rx, ry, rw, rh);
  const h = hgt.getImageData(rx, ry, rw, rh);
  const r = rgh.getImageData(rx, ry, rw, rh);
  const ad = a.data, hd = h.data, rd = r.data;
  const out = [0, 0, 0, 0.5, 0.85];
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      fn((x + 0.5) / rw, 1 - (y + 0.5) / rh, out);
      const i = (y * rw + x) * 4;
      ad[i] = clamp01(out[0]) * 255;
      ad[i + 1] = clamp01(out[1]) * 255;
      ad[i + 2] = clamp01(out[2]) * 255;
      ad[i + 3] = 255;
      const hv = clamp01(out[3]) * 255;
      hd[i] = hd[i + 1] = hd[i + 2] = hv;
      hd[i + 3] = 255;
      rd[i] = 128;
      rd[i + 1] = clamp01(out[4]) * 255;   // roughnessMap samples green
      rd[i + 2] = 0;                        // metalnessMap samples blue
      rd[i + 3] = 255;
    }
  }
  alb.putImageData(a, rx, ry);
  hgt.putImageData(h, rx, ry);
  rgh.putImageData(r, rx, ry);
}

// ---------------------------------------------------------------- painters

/**
 * Necrotic flesh. The read at distance comes from three overlapping scales:
 * broad livor-mortis blotching, mid-scale bruising, and thin dark veins. Blood
 * is deliberately dark and desaturated so it looks dried rather than fresh.
 */
function paintFlesh(out, u, v, seed) {
  const P = 6;
  const mottle = fbm(u * P, v * P, P, seed, 3);
  const fine = fbm(u * P * 5, v * P * 5, P * 5, seed + 7, 2);
  // Relief detail is generated an order of magnitude finer than the colour
  // variation. Driving the normal map off the broad mottling instead turns the
  // whole body into tree bark -- the noise reads at limb scale, not skin scale.
  const pore = fbm(u * P * 18, v * P * 18, P * 18, seed + 131, 2);
  const wrinkle = Math.pow(ridge(u * P * 7, v * P * 7, P * 7, seed + 155, 2), 3);
  const bruise = fbm(u * P * 2.1 + 3, v * P * 2.1, P * 2, seed + 21, 3);
  const necro = smooth(0.58, 0.80, fbm(u * P * 1.4, v * P * 1.4, P, seed + 41, 3));
  // High frequency and a hard power: capillaries, not cabling. At a lower
  // frequency this reads as a maze scrawled over the skin.
  const vein = Math.pow(ridge(u * P * 9, v * P * 9, P * 9, seed + 63, 2), 9);
  // Blood is kept sparse on purpose: a corpse that is red all over reads as raw
  // meat, and the eye stops seeing it as skin at all. Noise stretched along v
  // makes it run downward like a dried drip rather than ring the body in
  // contour lines, which is what a ridge function would do here.
  const blood = smooth(0.60, 0.86, fbm(u * P * 3, v * P * 0.8, P * 3, seed + 90, 3))
    * smooth(0.68, 0.92, fbm(u * 2.5, v * 2.5, 3, seed + 111, 2));

  // Base: drained, faintly olive corpse skin. All the tonal range lives in the
  // albedo; the height map above stays at pore scale so none of this turns
  // into relief.
  let r = 0.44 + mottle * 0.20 + fine * 0.07;
  let g = 0.42 + mottle * 0.18 + fine * 0.06;
  let b = 0.35 + mottle * 0.14 + fine * 0.06;

  // Bruised pooling under the skin -- livor mortis, so grey-violet not red.
  const bk = smooth(0.50, 0.86, bruise) * 0.60;
  r = mix(r, 0.28, bk); g = mix(g, 0.22, bk); b = mix(b, 0.30, bk);

  // Dead, drying tissue: darker, greener, rougher.
  r = mix(r, 0.22, necro * 0.70); g = mix(g, 0.25, necro * 0.70); b = mix(b, 0.16, necro * 0.70);

  // Veins read as thin dark lines, slightly blue.
  const vk = vein * 0.40;
  r = mix(r, 0.19, vk); g = mix(g, 0.21, vk); b = mix(b, 0.25, vk);

  // Dried blood.
  const bl = blood * 0.80;
  r = mix(r, 0.20, bl); g = mix(g, 0.045, bl); b = mix(b, 0.04, bl);

  out[0] = r; out[1] = g; out[2] = b;
  // Relief comes from pores, veins and the edges of necrotic patches -- not
  // from the broad mottling, which would turn the whole body into cauliflower.
  out[3] = 0.48 + pore * 0.30 + wrinkle * 0.16 - vein * 0.14 - necro * 0.08;
  // Dry necrotic patches are matte; blood and bruising keep a little sheen.
  out[4] = clamp01(0.80 + necro * 0.16 - bl * 0.42 - bk * 0.10 - pore * 0.08);
}

/** Filthy, sweat-and-blood-stained cloth with a visible weave. */
function paintCloth(out, u, v, seed, tint) {
  const P = 8;
  const weave = (Math.sin(u * 360) * 0.5 + 0.5) * 0.5 + (Math.sin(v * 360) * 0.5 + 0.5) * 0.5;
  const dirt = fbm(u * P, v * P, P, seed, 3);
  const wear = smooth(0.55, 0.85, fbm(u * P * 2, v * P * 2, P * 2, seed + 17, 3));
  const soak = smooth(0.5, 0.9, fbm(u * 3, v * 3 + 1, 3, seed + 33, 2)) * smooth(0.0, 0.45, 1 - v);

  let r = tint[0] * (0.62 + dirt * 0.5 + weave * 0.10);
  let g = tint[1] * (0.62 + dirt * 0.5 + weave * 0.10);
  let b = tint[2] * (0.62 + dirt * 0.5 + weave * 0.10);

  // Threadbare patches go pale and fuzzy.
  r = mix(r, r * 1.35 + 0.10, wear * 0.6);
  g = mix(g, g * 1.35 + 0.10, wear * 0.6);
  b = mix(b, b * 1.30 + 0.10, wear * 0.6);

  // Blood soaks upward from the hem.
  r = mix(r, 0.20, soak * 0.8); g = mix(g, 0.045, soak * 0.8); b = mix(b, 0.04, soak * 0.8);

  out[0] = r; out[1] = g; out[2] = b;
  out[3] = 0.45 + weave * 0.22 + dirt * 0.2 - wear * 0.12;
  out[4] = clamp01(0.92 - soak * 0.35 + wear * 0.05);
}

/** Dry bone: warm off-white with grain and hairline cracks. */
function paintBone(out, u, v, seed) {
  const P = 5;
  const grain = fbm(u * P * 4, v * P, P * 4, seed, 3);
  const crack = Math.pow(ridge(u * P * 2, v * P * 2, P * 2, seed + 9, 2), 9);
  const stain = smooth(0.5, 0.9, fbm(u * P, v * P, P, seed + 19, 2));
  let r = 0.86 - grain * 0.16, g = 0.83 - grain * 0.17, b = 0.72 - grain * 0.18;
  r = mix(r, 0.44, stain * 0.5); g = mix(g, 0.36, stain * 0.5); b = mix(b, 0.24, stain * 0.5);
  r = mix(r, 0.30, crack); g = mix(g, 0.26, crack); b = mix(b, 0.20, crack);
  out[0] = r; out[1] = g; out[2] = b;
  out[3] = 0.55 + grain * 0.2 - crack * 0.45;
  out[4] = clamp01(0.55 + grain * 0.2 + stain * 0.15);
}

/**
 * An open wound with exposed ribs. Painted as concentric torn flesh fading to
 * the surrounding skin tone at the border, because the patch geometry that
 * carries it is a plain rectangle laid on the torso -- the fade is what hides
 * the rectangle.
 */
function paintWound(out, u, v, seed) {
  const P = 5;
  const n = fbm(u * P * 2, v * P * 2, P * 2, seed, 3);
  // Distance from the patch centre, made irregular by noise: the wound outline.
  const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
  const d = Math.sqrt(dx * dx + dy * dy) * (0.78 + n * 0.5);
  const inside = 1 - smooth(0.52, 0.95, d);

  // Ribs: horizontal bars of bone crossing the cavity.
  const rib = Math.pow(Math.abs(Math.sin((v + n * 0.05) * Math.PI * 3.4)), 14);
  const ribMask = rib * smooth(0.28, 0.6, inside) * smooth(0.85, 0.55, Math.abs(dx));

  // Surrounding skin so the patch edge dissolves into the body.
  paintFlesh(out, u, v, seed + 5);
  let r = out[0], g = out[1], b = out[2], h = out[3], ro = out[4];

  // Torn, everted flesh ring.
  const rim = smooth(0.0, 0.35, inside) * (1 - smooth(0.35, 0.75, inside));
  r = mix(r, 0.42, rim * 0.9); g = mix(g, 0.10, rim * 0.9); b = mix(b, 0.10, rim * 0.9);
  h = mix(h, 0.85, rim * 0.7);
  ro = mix(ro, 0.35, rim);

  // Dark cavity.
  const cav = smooth(0.35, 0.8, inside);
  r = mix(r, 0.16 + n * 0.10, cav); g = mix(g, 0.028, cav); b = mix(b, 0.03, cav);
  h = mix(h, 0.10, cav);
  ro = mix(ro, 0.30, cav);

  // Ribs on top of the cavity.
  r = mix(r, 0.78 - n * 0.12, ribMask); g = mix(g, 0.72 - n * 0.12, ribMask); b = mix(b, 0.60 - n * 0.10, ribMask);
  h = mix(h, 0.95, ribMask);
  ro = mix(ro, 0.55, ribMask);

  out[0] = r; out[1] = g; out[2] = b; out[3] = h; out[4] = ro;
}

/** Wet viscera / soaked gore, used for tatters and the odd exposed patch. */
function paintGore(out, u, v, seed) {
  const P = 6;
  const n = fbm(u * P, v * P, P, seed, 3);
  const s = ridge(u * P * 2.5, v * P * 2.5, P * 2, seed + 11, 2);
  out[0] = 0.24 + n * 0.22 + s * 0.10;
  out[1] = 0.045 + n * 0.06;
  out[2] = 0.04 + n * 0.05;
  out[3] = 0.35 + n * 0.4;
  out[4] = clamp01(0.34 + n * 0.22);
}

/**
 * The head map is an equirectangular unwrap: s = 0.5 is dead centre of the
 * face, s = 0/1 is the back of the skull, t = 0 under the jaw and t = 1 at the
 * crown. Everything is painted in that space so the sculpted skull underneath
 * lines up with sockets, mouth and hairline.
 */
function paintHead(out, u, v, seed) {
  const th = (u - 0.5) * Math.PI * 2;          // 0 = facing the player
  const front = Math.cos(th);                   // 1 front, -1 back
  const ax = Math.abs(th);

  paintFlesh(out, u * 2, v * 2, seed + 3);
  let r = out[0], g = out[1], b = out[2], h = out[3], ro = out[4];

  // Sunken temples and cheeks read mostly as shadow, so darken them.
  const hollow = Math.exp(-Math.pow((ax - 0.48) / 0.30, 2)) * Math.exp(-Math.pow((v - 0.36) / 0.11, 2))
    + Math.exp(-Math.pow((ax - 1.2) / 0.3, 2)) * Math.exp(-Math.pow((v - 0.62) / 0.10, 2));
  const hk = clamp01(hollow) * 0.55;
  r = mix(r, r * 0.48, hk); g = mix(g, g * 0.48, hk); b = mix(b, b * 0.52, hk);

  // --- eyes ---------------------------------------------------------------
  // Socket shadow first, then the milky globe sitting inside it. The socket is
  // deliberately much larger and darker than the globe: at any real distance
  // it is the pit, not the eye, that says "skull".
  const sock = Math.exp(-Math.pow((ax - 0.40) / 0.30, 2)) * Math.exp(-Math.pow((v - 0.545) / 0.100, 2));
  const sk = clamp01(sock * 1.6) * 0.94;
  r = mix(r, 0.045, sk); g = mix(g, 0.034, sk); b = mix(b, 0.033, sk);
  h = mix(h, 0.08, sk * 0.85);

  // Heavy brow shadow directly above the sockets: the single strongest cue
  // that there is a skull under this and not a mask.
  const brow = Math.exp(-Math.pow((ax - 0.40) / 0.42, 2)) * Math.exp(-Math.pow((v - 0.635) / 0.045, 2));
  const bwk = clamp01(brow) * 0.5;
  r = mix(r, r * 0.42, bwk); g = mix(g, g * 0.42, bwk); b = mix(b, b * 0.45, bwk);

  // The globe itself is small, dull and sunk well inside the socket. Painting
  // it big and bright gives a cartoon "shocked" face; what you want is a dim
  // wet gleam somewhere back in the dark.
  const eyeD = Math.sqrt(Math.pow((ax - 0.40) / 0.115, 2) + Math.pow((v - 0.535) / 0.048, 2));
  const eye = (1 - smooth(0.60, 1.0, eyeD)) * 0.80;
  if (eye > 0) {
    const veins = Math.pow(ridge(u * 90, v * 90, 90, seed + 55, 2), 6);
    let er = 0.42 - veins * 0.16, eg = 0.41 - veins * 0.24, eb = 0.39 - veins * 0.24;
    // Clouded cornea: a pale disc with almost no iris left.
    const iris = 1 - smooth(0.25, 0.60, eyeD);
    er = mix(er, 0.30, iris * 0.8); eg = mix(eg, 0.32, iris * 0.8); eb = mix(eb, 0.29, iris * 0.8);
    const pupil = 1 - smooth(0.08, 0.26, eyeD);
    er = mix(er, 0.05, pupil); eg = mix(eg, 0.05, pupil); eb = mix(eb, 0.055, pupil);
    r = mix(r, er, eye); g = mix(g, eg, eye); b = mix(b, eb, eye);
    h = mix(h, 0.66, eye);
    ro = mix(ro, 0.14, eye);        // wet -- this is what catches a highlight
  }

  // --- nose ---------------------------------------------------------------
  // Cartilage is long gone: a dark triangular aperture, not a nose.
  const nd = Math.sqrt(Math.pow(th / 0.16, 2) + Math.pow((v - 0.455) / 0.055, 2));
  const nose = (1 - smooth(0.5, 1.05, nd)) * smooth(0.0, 0.3, front);
  r = mix(r, 0.10, nose * 0.9); g = mix(g, 0.055, nose * 0.9); b = mix(b, 0.05, nose * 0.9);
  h = mix(h, 0.08, nose * 0.8);

  // --- mouth --------------------------------------------------------------
  const md = Math.sqrt(Math.pow(th / 0.52, 2) + Math.pow((v - 0.285) / 0.075, 2));
  const mouth = (1 - smooth(0.55, 1.0, md)) * smooth(0.0, 0.25, front);
  // Teeth: a broken row along the top of the aperture.
  const tooth = Math.pow(Math.abs(Math.sin(th * 11.0)), 6)
    * smooth(0.35, 0.29, v) * smooth(0.23, 0.29, v)
    * (0.35 + 0.65 * hashi(Math.floor(th * 11), 3, seed));
  r = mix(r, 0.055, mouth * 0.95); g = mix(g, 0.02, mouth * 0.95); b = mix(b, 0.025, mouth * 0.95);
  h = mix(h, 0.05, mouth * 0.9);
  const tk = clamp01(tooth * mouth * 2.2);
  r = mix(r, 0.80, tk); g = mix(g, 0.76, tk); b = mix(b, 0.64, tk);
  h = mix(h, 0.9, tk);
  ro = mix(ro, 0.45, tk);

  // Blood running from the mouth down the chin.
  const drip = smooth(0.5, 0.95, ridge(u * 26, v * 9, 26, seed + 71, 2))
    * smooth(0.34, 0.20, v) * smooth(0.0, 0.35, front);
  r = mix(r, 0.24, drip * 0.85); g = mix(g, 0.04, drip * 0.85); b = mix(b, 0.035, drip * 0.85);
  ro = mix(ro, 0.42, drip * 0.7);

  // --- scalp --------------------------------------------------------------
  // Matted hair in clumps above the hairline, with bare skull showing through.
  const hairline = smooth(0.66, 0.80, v + Math.max(0, front) * 0.06);
  const clump = smooth(0.42, 0.72, fbm(u * 14, v * 14, 14, seed + 5, 3));
  const strand = Math.pow(ridge(u * 60, v * 18, 60, seed + 6, 2), 3);
  const hair = hairline * clump;
  r = mix(r, 0.10 + strand * 0.09, hair); g = mix(g, 0.085 + strand * 0.07, hair); b = mix(b, 0.075 + strand * 0.05, hair);
  h = mix(h, 0.35 + strand * 0.5, hair);
  ro = mix(ro, 0.95, hair);

  // Bare skull patch where the scalp has come away.
  const bare = hairline * (1 - clump) * smooth(0.45, 0.8, fbm(u * 6 + 5, v * 6, 6, seed + 8, 2));
  r = mix(r, 0.72, bare * 0.8); g = mix(g, 0.68, bare * 0.8); b = mix(b, 0.56, bare * 0.8);
  ro = mix(ro, 0.6, bare * 0.8);

  out[0] = r; out[1] = g; out[2] = b; out[3] = h; out[4] = ro;
}

// ------------------------------------------------------------- normal map

/** Sobel the height canvas into a tangent-space normal map. */
function heightToNormal(hgt, dst, strength) {
  const src = hgt.getImageData(0, 0, TEX, TEX).data;
  const img = dst.getImageData(0, 0, TEX, TEX);
  const d = img.data;
  const at = (x, y) => {
    const xi = x < 0 ? 0 : x >= TEX ? TEX - 1 : x;
    const yi = y < 0 ? 0 : y >= TEX ? TEX - 1 : y;
    return src[(yi * TEX + xi) * 4] / 255;
  };
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const l = at(x - 1, y), r = at(x + 1, y);
      const u = at(x, y - 1), v = at(x, y + 1);
      let nx = (l - r) * strength;
      let ny = (v - u) * strength;   // canvas +y is down, tangent +y is up
      const nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= inv; ny *= inv;
      const i = (y * TEX + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  dst.putImageData(img, 0, 0);
}

// ------------------------------------------------------------------ atlas

let ATLAS = null;

/**
 * Build (once) and return { map, normalMap, roughnessMap }. Returns null in a
 * non-browser context so the module stays importable under `node --test`.
 */
export function zombieAtlas() {
  if (ATLAS !== undefined && ATLAS !== null) return ATLAS;

  const albC = createCanvas(TEX, TEX);
  if (!albC) return null;
  const hgtC = createCanvas(TEX, TEX);
  const rghC = createCanvas(TEX, TEX);
  const nrmC = createCanvas(TEX, TEX);

  const alb = albC.getContext('2d', { willReadFrequently: true });
  const hgt = hgtC.getContext('2d', { willReadFrequently: true });
  const rgh = rghC.getContext('2d', { willReadFrequently: true });
  const nrm = nrmC.getContext('2d', { willReadFrequently: true });

  for (const ctx of [alb, hgt, rgh, nrm]) {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, TEX, TEX);
  }

  const S = 1337;
  paintRegion(alb, hgt, rgh, REGION.flesh, (u, v, o) => paintFlesh(o, u, v, S));
  paintRegion(alb, hgt, rgh, REGION.cloth, (u, v, o) => paintCloth(o, u, v, S + 200, [0.52, 0.50, 0.44]));
  paintRegion(alb, hgt, rgh, REGION.head, (u, v, o) => paintHead(o, u, v, S + 400));
  paintRegion(alb, hgt, rgh, REGION.bone, (u, v, o) => paintBone(o, u, v, S + 600));
  paintRegion(alb, hgt, rgh, REGION.wound, (u, v, o) => paintWound(o, u, v, S + 800));
  paintRegion(alb, hgt, rgh, REGION.gore, (u, v, o) => paintGore(o, u, v, S + 900));

  heightToNormal(hgt, nrm, 2.2);

  const map = new THREE.CanvasTexture(albC);
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = new THREE.CanvasTexture(nrmC);
  const roughnessMap = new THREE.CanvasTexture(rghC);

  for (const t of [map, normalMap, roughnessMap]) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 4;
    t.needsUpdate = true;
  }

  ATLAS = { map, normalMap, roughnessMap };
  return ATLAS;
}

// --------------------------------------------------------------- material

// Injected after the standard lighting pass. Dead flesh is still flesh: a
// little light bleeds through thin parts (ears, fingers, a slack jaw) and wraps
// past the terminator instead of falling off at exactly 90 degrees. This is a
// two-term cheat -- wrapped diffuse plus a back-facing transmission lobe --
// rather than real subsurface scattering, but it is what stops the model
// reading as painted plastic when the sun rakes across it.
const SSS_CHUNK = `
#if NUM_DIR_LIGHTS > 0
{
  vec3 sssDir = directionalLights[ 0 ].direction;
  float wrapped = max( 0.0, ( dot( normal, sssDir ) + 0.6 ) / 1.6 );
  float through = pow( max( 0.0, dot( -normal, sssDir ) * 0.5 + 0.5 ), 3.0 );
  vec3 sssTint = vec3( 1.0, 0.42, 0.34 );
  reflectedLight.indirectDiffuse += diffuseColor.rgb * sssTint * directionalLights[ 0 ].color
    * ( wrapped * 0.16 + through * 0.10 );
}
#endif
`;

const MARKER = '#include <lights_fragment_end>';

/**
 * One material per zombie. It is a clone in the sense that matters -- the maps
 * and (because the shader source is identical) the compiled program are shared
 * across the whole horde -- but the emissive slot is per instance, which is what
 * lets a single zombie flash red when hit.
 */
export function createZombieMaterial() {
  const atlas = zombieAtlas();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: atlas ? atlas.map : null,
    normalMap: atlas ? atlas.normalMap : null,
    roughnessMap: atlas ? atlas.roughnessMap : null,
    roughness: 1.0,
    metalness: 0.0,
    vertexColors: true,
    emissive: 0x000000,
  });
  if (atlas) mat.normalScale.set(1.0, 1.0);
  mat.onBeforeCompile = (shader) => {
    if (shader.fragmentShader.indexOf(MARKER) === -1) return;
    shader.fragmentShader = shader.fragmentShader.replace(MARKER, MARKER + SSS_CHUNK);
  };
  return mat;
}

// ------------------------------------------------------------------ skinning

/**
 * Reference colours the per-type models use for non-skin materials. Matched by
 * distance rather than equality, because each model file carries its own copy of
 * these constants and a few have drifted a shade apart.
 */
const CLASSIFY = [
  { region: 'bone', rgb: [0xd2 / 255, 0xc8 / 255, 0xa6 / 255] },
  { region: 'gore', rgb: [0x5e / 255, 0x1f / 255, 0x1c / 255] },
  { region: 'cloth', rgb: [0x3b / 255, 0x3d / 255, 0x30 / 255] },
];

/** Meshes that are light sources or hardware, not flesh. Never skinned. */
const NOT_FLESH = new Set(['eyeL', 'eyeR', 'core', 'sac', 'gun', 'shield']);

/**
 * Per-region rotation around the UV's u axis, applied before the region map.
 *
 * Only the head needs it, and it needs it badly: paintHead centres the face at
 * u = 0.5, while a three.js sphere puts its +Z front at u = 0.25. Without the
 * quarter turn the eyes, nose and teeth are painted onto the back of the skull
 * and every zombie is faceless from the front. The other regions are
 * direction-free noise, so a rotation would be invisible.
 */
const U_SPIN = { head: 0.25 };

function isBlack(c) { return c.r < 0.02 && c.g < 0.02 && c.b < 0.02; }

function classify(name, color) {
  if (name === 'head') return 'head';
  let best = 'flesh';
  let bestD = 0.13;                  // beyond this it is just skin in some tint
  for (const c of CLASSIFY) {
    const d = Math.hypot(color.r - c.rgb[0], color.g - c.rgb[1], color.b - c.rgb[2]);
    if (d < bestD) { bestD = d; best = c.region; }
  }
  return best;
}

/**
 * Keep the hue, drop the darkness, then pull most of the way to white. The atlas
 * supplies the value range; the vertex colour only has to say which way the
 * flesh leans, or the tint multiplies against the albedo twice and goes muddy.
 */
function normalizeTint(color) {
  const peak = Math.max(color.r, color.g, color.b, 1e-4);
  const k = 0.55;                     // how much of the hue survives
  return {
    r: 1 - (1 - color.r / peak) * k,
    g: 1 - (1 - color.g / peak) * k,
    b: 1 - (1 - color.b / peak) * k,
  };
}

/**
 * Give a finished zombie model real skin.
 *
 * The per-type models were authored as flat colours, which is why the horde read
 * as untextured plastic. This walks a built prototype and rewrites each fleshy
 * mesh to sample the shared atlas instead: the part's own UVs are remapped into
 * one atlas region, and the flat colour it used to carry moves into vertex
 * colours so the per-type tint survives -- a grunt stays green, a brute stays
 * pale, and both gain pores, blotching and wounds.
 *
 * Run once per prototype. Geometry is shared with every clone, so the UV rewrite
 * is paid for once per enemy type; the single returned material is cloned per
 * instance by buildEnemyMesh, which is what keeps the hit flash per zombie.
 *
 * Eyes, glowing cores, gas sacs and weapons are left exactly as they were --
 * they are not skin, and the glow is the gameplay tell.
 */
export function applyZombieSkin(group) {
  if (!zombieAtlas()) return null;    // no canvas (headless); leave it flat
  const skin = createZombieMaterial();

  const uv = [0, 0];
  let skinned = 0;

  group.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const m = o.material;
    if (!m || !m.color || !m.isMeshStandardMaterial) return;

    // Skip anything that is emitting rather than reflecting, plus hardware.
    if (NOT_FLESH.has(o.name) || o.name.startsWith('halo')) return;
    if ((m.emissiveIntensity ?? 0) > 0.3 && m.emissive && !isBlack(m.emissive)) return;
    if ((m.metalness ?? 0) > 0.3) return;

    const geo = o.geometry;
    const pos = geo.attributes.position;
    const src = geo.attributes.uv;
    if (!pos || !src) return;

    const region = classify(o.name, m.color);

    // Remap this part's UVs into its atlas region. In place: the prototype owns
    // this geometry and every clone shares it, so guard against a second pass.
    if (!geo.userData.zombieRegion) {
      const rect = REGION[region];
      const spin = U_SPIN[region] ?? 0;
      for (let i = 0; i < src.count; i++) {
        // Wrap rather than clamp: u is periodic around the body part.
        const u0 = (src.getX(i) + spin) % 1;
        regionUV(rect, u0 < 0 ? u0 + 1 : u0, src.getY(i), uv);
        src.setXY(i, uv[0], uv[1]);
      }
      src.needsUpdate = true;
      geo.userData.zombieRegion = region;
    }

    // Move the old flat colour into vertex colours. The atlas already carries
    // the right colour for cloth, bone and gore, so those pass through white.
    if (!geo.attributes.color) {
      const tint = (region === 'flesh' || region === 'head')
        ? normalizeTint(m.color)
        : { r: 1, g: 1, b: 1 };
      const arr = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        arr[i * 3] = tint.r;
        arr[i * 3 + 1] = tint.g;
        arr[i * 3 + 2] = tint.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }

    o.material = skin;
    skinned++;
  });

  return skinned > 0 ? skin : null;
}

// Building the atlas costs ~170ms of noise evaluation. Kicking it off as soon
// as this module is imported moves that off the first spawn (mid wave one) and
// into page load, where the world generator is already working. Guarded so the
// module stays importable under `node --test`; if the timer never runs, the
// first zombie builds it on demand instead.
if (typeof document !== 'undefined' && typeof setTimeout === 'function') {
  const idle = typeof requestIdleCallback === 'function'
    ? requestIdleCallback
    : (fn) => setTimeout(fn, 0);
  idle(() => { try { zombieAtlas(); } catch { /* built lazily instead */ } });
}
