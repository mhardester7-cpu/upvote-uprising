// Physically-based sky: single-scattering atmosphere + layered clouds.
//
// The expensive part -- Rayleigh/Mie single scattering through a spherical
// atmosphere -- is integrated once on the CPU into two small lookup tables and
// uploaded as half-float textures. Because the sun direction is fixed for a
// session, the sky radiance is a function of only two angles (view elevation,
// and azimuth measured from the sun), so a 96x48 table reproduces it exactly.
//
// The phase functions are *not* baked into the table. They are the only part of
// the integral that varies sharply with view angle (the Mie lobe around the sun
// is ~72x brighter than its backscatter), so baking them would band. Instead
// the table stores the Rayleigh and Mie in-scattering integrals separately and
// the shader applies the analytic phase per pixel. The result is smooth right
// through the solar aureole while costing two texture fetches.
//
// Everything else in the frame reads the same model:
//   - `skyRadiance()` is exported as a GLSL chunk so the terrain and props can
//     use the real sky as their aerial-perspective colour, which is what stops
//     distant geometry looking pasted onto the backdrop.
//   - ATMOSPHERE carries CPU-side colours (fog, ambient) so the scene fog can
//     be kept in agreement with the horizon.

import * as THREE from '../../vendor/three.module.js';
import { runFrameHooks } from './framehooks.js';

// ---------------------------------------------------------------- constants

const Re = 6360e3;          // earth radius, m
const Ra = 6420e3;          // top of atmosphere, m
const Hr = 8000;            // Rayleigh scale height
const Hm = 1200;            // Mie scale height
const BETA_R = [5.802e-6, 13.558e-6, 33.100e-6];   // Bruneton scattering
// Aerosol load is deliberately well above Bruneton's clear-sky figure. Pure
// single scattering with clean air leaves the horizon dark and green, because
// all the whitening there comes from multiple scattering we are not
// integrating; a hazier atmosphere reproduces the same pale horizon for free
// and doubles as the scene's aerial perspective.
const BETA_M_S = 14.0e-6;   // Mie scattering
const BETA_M_E = 15.5e-6;   // Mie extinction (scattering + absorption)
const MIE_G = 0.70;

const LUT_W = 96;           // view elevation samples
const LUT_H = 48;           // azimuth-from-sun samples
const VIEW_STEPS = 20;
const LIGHT_STEPS = 6;

// Orders 3+ of multiple scattering, folded into the single second-order pass as
// the sum of a geometric series. Without it the horizon stays too dark.
const MS_TAIL = 1.4;

// Phase prefactors, folded into the table so the shader only applies the
// angle-dependent part.
const PHASE_R_K = 3 / (16 * Math.PI);
const PHASE_M_K = (3 / (8 * Math.PI)) * (1 - MIE_G * MIE_G) / (2 + MIE_G * MIE_G);

// The table is normalised so the zenith lands here in linear working space.
// Everything downstream (fog, ambient, cloud lighting) scales off the same
// number, so the sky can be made brighter or dimmer from one place.
// Chosen against the renderer's 1.05 exposure and the bloom pass's 0.90
// threshold: the zenith sits comfortably under it while the horizon and the
// sunward sky push just past, so the atmosphere glows without the whole frame
// smearing.
const ZENITH_TARGET = 0.34;

const DEFAULT_SUN = [0.42, 0.78, 0.28];

// Shader noise is measured in whole cells, so feeding elapsed seconds directly
// made a cloud mass cross the sky in only a few seconds. At this scale the low
// deck takes roughly a minute and a half to drift one noise cell.
export const CLOUD_DRIFT_TIME_SCALE = 0.02;

// ------------------------------------------------------------ CPU integrator

/**
 * Far intersection of a ray with a sphere centred on the origin.
 * @returns t, or -1 if the ray misses.
 */
function exitSphere(px, py, pz, dx, dy, dz, R) {
  const b = px * dx + py * dy + pz * dz;
  const c = px * px + py * py + pz * pz - R * R;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b + Math.sqrt(disc);
}

/** True when the planet blocks the ray before it leaves the atmosphere. */
function hitsGround(px, py, pz, dx, dy, dz) {
  const b = px * dx + py * dy + pz * dz;
  const c = px * px + py * py + pz * pz - Re * Re;
  const disc = b * b - c;
  if (disc < 0) return false;
  return -b - Math.sqrt(disc) > 0;
}

/**
 * Integrate single scattering along one view ray, in 3D. The atmosphere is
 * spherically symmetric so only the angle between the view and the sun matters,
 * but the light rays still have to be marched as genuine unit directions --
 * squashing them into a 2D frame silently shortens them and turns the horizon
 * grey.
 *
 * @returns {{r:number[], m:number[]}} per-channel Rayleigh / Mie integrals.
 */
function scatter(dx, dy, dz, sx, sy, sz, ambient) {
  const oy = Re + 2;
  const r = [0, 0, 0];
  const m = [0, 0, 0];

  let tEnd = exitSphere(0, oy, 0, dx, dy, dz, Ra);
  if (tEnd <= 0) return { r, m };

  // A view ray that dives into the planet stops at the surface.
  const bg = oy * dy, cg = oy * oy - Re * Re;
  const dg = bg * bg - cg;
  if (dg >= 0) {
    const t0 = -bg - Math.sqrt(dg);
    if (t0 > 0) tEnd = Math.min(tEnd, t0);
  }

  const seg = tEnd / VIEW_STEPS;
  let odR = 0, odM = 0;

  for (let i = 0; i < VIEW_STEPS; i++) {
    const t = (i + 0.5) * seg;
    const px = dx * t, py = oy + dy * t, pz = dz * t;
    const h = Math.hypot(px, py, pz) - Re;
    if (h < 0) break;

    const hr = Math.exp(-h / Hr) * seg;
    const hm = Math.exp(-h / Hm) * seg;
    odR += hr;
    odM += hm;

    // Second-order term: light that has already been scattered once elsewhere
    // in the sky and is scattered again toward the eye. It is close enough to
    // isotropic to model as the average sky radiance, and it is what stops the
    // horizon coming out dark and green -- along a long path the accumulated
    // grey contribution is what real air looks like.
    if (ambient) {
      let tv = 0;
      for (let c = 0; c < 3; c++) {
        tv = Math.exp(-(BETA_R[c] * odR + BETA_M_E * odM));
        const inScat = (BETA_R[c] * hr + BETA_M_S * hm) * ambient[c] * tv;
        // Divided back out of the Rayleigh slot's phase prefactor, since the
        // shader will multiply by it again.
        r[c] += inScat / (BETA_R[c] * PHASE_R_K * (4 / 3));
      }
    }

    if (hitsGround(px, py, pz, sx, sy, sz)) continue;
    const tl = exitSphere(px, py, pz, sx, sy, sz, Ra);
    if (tl <= 0) continue;

    const segL = tl / LIGHT_STEPS;
    let odLR = 0, odLM = 0;
    for (let j = 0; j < LIGHT_STEPS; j++) {
      const tj = (j + 0.5) * segL;
      const lh = Math.hypot(px + sx * tj, py + sy * tj, pz + sz * tj) - Re;
      odLR += Math.exp(-lh / Hr) * segL;
      odLM += Math.exp(-lh / Hm) * segL;
    }

    for (let c = 0; c < 3; c++) {
      const tau = BETA_R[c] * (odR + odLR) + BETA_M_E * (odM + odLM);
      const att = Math.exp(-tau);
      r[c] += hr * att;
      m[c] += hm * att;
    }
  }

  for (let c = 0; c < 3; c++) {
    r[c] *= BETA_R[c] * PHASE_R_K;
    m[c] *= BETA_M_S * PHASE_M_K;
  }
  return { r, m };
}

/** Transmittance from the ground along a view ray to the top of the atmosphere. */
function transmittance(dirY, dirS) {
  const oy = Re + 2;
  const tMax = exitSphere(0, oy, 0, dirS, dirY, 0, Ra);
  if (tMax <= 0) return [0, 0, 0];
  const seg = tMax / 16;
  let odR = 0, odM = 0;
  for (let i = 0; i < 16; i++) {
    const t = (i + 0.5) * seg;
    const h = Math.hypot(dirS * t, oy + dirY * t) - Re;
    if (h < 0) return [0, 0, 0];
    odR += Math.exp(-h / Hr) * seg;
    odM += Math.exp(-h / Hm) * seg;
  }
  return [0, 1, 2].map((c) => Math.exp(-(BETA_R[c] * odR + BETA_M_E * odM)));
}

// The table's elevation axis is warped so half of it covers the ten degrees
// either side of the horizon, where all the interesting gradient lives.
const muToU = (mu) => 0.5 + 0.5 * Math.sign(mu) * Math.sqrt(Math.abs(mu));

// --------------------------------------------------------------- LUT upload

function halfTexture(floats, w, h) {
  const data = new Uint16Array(floats.length);
  for (let i = 0; i < floats.length; i++) {
    data[i] = THREE.DataUtils.toHalfFloat(Math.min(65000, floats[i]));
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Colours and light directions derived from the atmosphere model. Populated by
 * ensureAtmosphere(); read by the terrain, props and (via the sky's frame hook)
 * the scene fog.
 */
export const ATMOSPHERE = {
  ready: false,
  sunDir: new THREE.Vector3(...DEFAULT_SUN).normalize(),
  /** Linear-space colour of the sky at the horizon -- the right fog colour. */
  fog: new THREE.Color(0.6, 0.72, 0.85),
  horizon: new THREE.Color(0.6, 0.72, 0.85),
  zenith: new THREE.Color(0.18, 0.32, 0.62),
  /** Colour of the sun after atmospheric extinction, normalised to luma 1. */
  sunTint: new THREE.Color(1, 0.95, 0.86),
  /** Radiance scale applied to the tables, exposed for cloud lighting. */
  intensity: 1,
};

const uniforms = {
  tSkyR: { value: null },
  tSkyM: { value: null },
  tSunT: { value: null },
  uSunDir: { value: new THREE.Vector3(...DEFAULT_SUN).normalize() },
  uCloudTime: { value: 0 },
  uCloudCover: { value: 0.46 },
  uCloudOctaves: { value: 5 },
  uSkyGain: { value: 1 },
};

let built = false;

/**
 * Build (once) the scattering tables for a sun direction.
 * Idempotent; safe to call from any module before it needs the uniforms.
 */
export function ensureAtmosphere(sunDirection) {
  if (built) return uniforms;
  built = true;

  const sun = sunDirection
    ? new THREE.Vector3().copy(sunDirection).normalize()
    : new THREE.Vector3(...DEFAULT_SUN).normalize();
  ATMOSPHERE.sunDir.copy(sun);
  uniforms.uSunDir.value.copy(sun);

  const sunY = sun.y;
  const sunS = Math.sqrt(Math.max(0, 1 - sunY * sunY));

  const rBuf = new Float32Array(LUT_W * LUT_H * 4);
  const mBuf = new Float32Array(LUT_W * LUT_H * 4);

  // Local frame: +Y up, +X along the sun's horizontal bearing.
  const pass = (ambient) => {
    for (let j = 0; j < LUT_H; j++) {
      // Azimuth measured from the sun: 0 = looking at it, PI = away.
      const phi = (j / (LUT_H - 1)) * Math.PI;
      const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
      for (let i = 0; i < LUT_W; i++) {
        const u = i / (LUT_W - 1);
        const t = u * 2 - 1;
        const mu = Math.sign(t) * t * t;
        const hor = Math.sqrt(Math.max(0, 1 - mu * mu));

        const { r, m } = scatter(hor * cosPhi, mu, hor * sinPhi, sunS, sunY, 0, ambient);

        const o = (j * LUT_W + i) * 4;
        rBuf[o] = r[0]; rBuf[o + 1] = r[1]; rBuf[o + 2] = r[2]; rBuf[o + 3] = 1;
        mBuf[o] = m[0]; mBuf[o + 1] = m[1]; mBuf[o + 2] = m[2]; mBuf[o + 3] = 1;
      }
    }
  };

  // First order only, then average it over the sky and run again with that as
  // the ambient field. One extra pass buys most of the multiple-scattering look.
  pass(null);
  const ambient = [0, 0, 0];
  let n = 0;
  for (let j = 0; j < LUT_H; j++) {
    for (let i = LUT_W >> 1; i < LUT_W; i++) {     // upper hemisphere only
      const o = (j * LUT_W + i) * 4;
      // Phase functions average to 4/3 (Rayleigh) and 1 (normalised Mie).
      for (let c = 0; c < 3; c++) ambient[c] += rBuf[o + c] * (4 / 3) + mBuf[o + c];
      n++;
    }
  }
  for (let c = 0; c < 3; c++) ambient[c] = (ambient[c] / n) * MS_TAIL;
  pass(ambient);

  // Normalise: the integral is in physical units the renderer has no notion
  // of, so scale it so the zenith lands at a sensible linear value against the
  // scene's exposure. Everything else keeps its physical ratio to that.
  const zi = (0 * LUT_W + (LUT_W - 1)) * 4;   // mu = 1, phi = 0
  const zpr = 1 + sunY * sunY;
  const zpm = zpr / Math.pow(Math.max(1e-4, 1 + MIE_G * MIE_G - 2 * MIE_G * sunY), 1.5);
  const luma = (a, o, k) => (a[o] * 0.2126 + a[o + 1] * 0.7152 + a[o + 2] * 0.0722) * k;
  const zenithLuma = luma(rBuf, zi, zpr) + luma(mBuf, zi, zpm);
  const gain = ZENITH_TARGET / Math.max(1e-9, zenithLuma);
  ATMOSPHERE.intensity = gain;

  for (let k = 0; k < rBuf.length; k++) { rBuf[k] *= gain; mBuf[k] *= gain; }

  uniforms.tSkyR.value = halfTexture(rBuf, LUT_W, LUT_H);
  uniforms.tSkyM.value = halfTexture(mBuf, LUT_W, LUT_H);

  // Sun transmittance, 1D over view elevation.
  const TW = 64;
  const tBuf = new Float32Array(TW * 4);
  for (let i = 0; i < TW; i++) {
    const t = (i / (TW - 1)) * 2 - 1;
    const mu = Math.sign(t) * t * t;
    const tr = transmittance(mu, Math.sqrt(Math.max(0, 1 - mu * mu)));
    tBuf[i * 4] = tr[0]; tBuf[i * 4 + 1] = tr[1]; tBuf[i * 4 + 2] = tr[2]; tBuf[i * 4 + 3] = 1;
  }
  uniforms.tSunT.value = halfTexture(tBuf, TW, 1);

  // ---- CPU-side colours, sampled straight out of the tables.

  const sampleSky = (mu, cosPhi) => {
    const u = Math.round(muToU(mu) * (LUT_W - 1));
    const v = Math.round((Math.acos(Math.max(-1, Math.min(1, cosPhi))) / Math.PI) * (LUT_H - 1));
    const o = (v * LUT_W + u) * 4;
    // Approximate the phase terms at a representative scattering angle.
    const cs = mu * sunY + Math.sqrt(Math.max(0, 1 - mu * mu)) * sunS * cosPhi;
    const pr = 1 + cs * cs;
    const g = MIE_G;
    const pm = pr / Math.pow(Math.max(1e-4, 1 + g * g - 2 * g * cs), 1.5);
    return new THREE.Color(
      rBuf[o] * pr + mBuf[o] * pm,
      rBuf[o + 1] * pr + mBuf[o + 1] * pm,
      rBuf[o + 2] * pr + mBuf[o + 2] * pm,
    );
  };

  // Fog colour: the horizon averaged over azimuth, so it is right whichever way
  // the player faces. Slightly biased away from the sun, where most of the
  // visible landscape sits.
  const h0 = sampleSky(0.015, 1);
  const h1 = sampleSky(0.015, 0);
  const h2 = sampleSky(0.015, -1);
  ATMOSPHERE.horizon.setRGB(
    (h0.r + 2 * h1.r + h2.r) / 4,
    (h0.g + 2 * h1.g + h2.g) / 4,
    (h0.b + 2 * h1.b + h2.b) / 4,
  );
  ATMOSPHERE.fog.copy(ATMOSPHERE.horizon);
  ATMOSPHERE.zenith.copy(sampleSky(1, 0));

  const st = transmittance(sunY, sunS);
  const stl = Math.max(1e-4, st[0] * 0.2126 + st[1] * 0.7152 + st[2] * 0.0722);
  ATMOSPHERE.sunTint.setRGB(st[0] / stl, st[1] / stl, st[2] / stl);
  ATMOSPHERE.ready = true;

  return uniforms;
}

/**
 * Shared uniform objects for the atmosphere.
 *
 * The same objects are handed to every material, so anything that mutates
 * `uSunDir` or `uCloudTime` moves the whole scene at once.
 */
export function getAtmosphereUniforms(sunDirection) {
  ensureAtmosphere(sunDirection);
  return uniforms;
}

// ------------------------------------------------------------------- shaders

/**
 * GLSL for evaluating the scattering tables. Include this, declare the
 * uniforms with ATMOSPHERE_PARS, and call `skyRadiance(dir)`.
 */
export const ATMOSPHERE_PARS = /* glsl */`
  uniform sampler2D tSkyR;
  uniform sampler2D tSkyM;
  uniform sampler2D tSunT;
  uniform vec3 uSunDir;
  uniform float uSkyGain;

  const float SKY_MIE_G = ${MIE_G.toFixed(4)};

  vec2 skyLutUv(vec3 d) {
    float mu = clamp(d.y, -1.0, 1.0);
    // Inverse of the CPU-side warp: u = 0.5 + 0.5 * sign(mu) * sqrt(|mu|).
    float u = 0.5 + 0.5 * sign(mu) * sqrt(abs(mu));
    vec2 dh = d.xz;
    vec2 sh = uSunDir.xz;
    float lh = length(dh) * length(sh);
    float cosPhi = lh > 1e-5 ? clamp(dot(dh, sh) / lh, -1.0, 1.0) : 1.0;
    float v = acos(cosPhi) * 0.3183098862;
    // Half-texel inset so linear filtering never reaches past the table.
    u = clamp(u, ${(0.5 / LUT_W).toFixed(6)}, ${(1 - 0.5 / LUT_W).toFixed(6)});
    v = clamp(v, ${(0.5 / LUT_H).toFixed(6)}, ${(1 - 0.5 / LUT_H).toFixed(6)});
    return vec2(u, v);
  }

  /** Single-scattered sky radiance in the given direction. No sun disc. */
  vec3 skyRadiance(vec3 d) {
    vec2 uv = skyLutUv(d);
    float cs = clamp(dot(d, uSunDir), -1.0, 1.0);
    float pr = 1.0 + cs * cs;
    float g = SKY_MIE_G;
    float denom = pow(max(1e-4, 1.0 + g * g - 2.0 * g * cs), 1.5);
    vec3 R = texture2D(tSkyR, uv).rgb * pr;
    vec3 M = texture2D(tSkyM, uv).rgb * (pr / denom);
    return (R + M) * uSkyGain;
  }

  /** Extinction of the solar beam along a view ray -- used for the disc. */
  vec3 sunTransmittance(vec3 d) {
    float u = 0.5 + 0.5 * sign(d.y) * sqrt(abs(d.y));
    return texture2D(tSunT, vec2(clamp(u, 0.008, 0.992), 0.5)).rgb;
  }
`;

/**
 * Drop-in replacement for three's <fog_fragment>.
 *
 * Rather than fading to a single flat fog colour, distant surfaces fade to the
 * actual sky radiance in their own view direction -- brighter and warmer toward
 * the sun, cooler away from it, and matching the horizon exactly where the
 * terrain meets it. A constant fog colour cannot do that, and the mismatch is
 * precisely what makes distant geometry look pasted onto the backdrop.
 *
 * Requires ATMOSPHERE_PARS and a `varying vec3 vWPos` in world space.
 */
export const AERIAL_FOG_FRAGMENT = /* glsl */`
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(- fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.rgb = mix(gl_FragColor.rgb,
                           skyRadiance(normalize(vWPos - cameraPosition)),
                           fogFactor);
  #endif
`;

const CLOUD_PARS = /* glsl */`
  uniform float uCloudTime;
  uniform float uCloudCover;

  float chash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float cnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(chash(i), chash(i + vec2(1.0, 0.0)), f.x),
               mix(chash(i + vec2(0.0, 1.0)), chash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // Rotated octaves: without the rotation the axis-aligned lattice of the value
  // noise shows through as a plaid weave at cloud scale.
  const mat2 CROT = mat2(0.8, 0.6, -0.6, 0.8);
  float cfbm(vec2 p, int oct) {
    float v = 0.0, a = 0.5, n = 0.0;
    for (int i = 0; i < 6; i++) {
      if (i >= oct) break;
      v += a * cnoise(p);
      n += a;
      p = CROT * p * 2.07;
      a *= 0.55;
    }
    return v / n;
  }

  /** Distance to a spherical shell at the given altitude, or -1 looking down. */
  float shellDist(vec3 d, float alt) {
    if (d.y <= 0.001) return -1.0;
    float ro = 6360002.0;
    float R = 6360000.0 + alt;
    float b = ro * d.y;
    float c = ro * ro - R * R;
    float disc = b * b - c;
    if (disc < 0.0) return -1.0;
    return -b + sqrt(disc);
  }
`;

const CLOUD_BODY = /* glsl */`
  /**
   * One cloud deck. Returns rgb premultiplied by coverage in .rgb and the
   * coverage itself in .a.
   *
   * Depth comes from two things: the deck is intersected against a curved
   * shell, so it converges toward the horizon the way a real deck does; and the
   * lighting term samples the density again a kilometre toward the sun, so the
   * sunward faces of each mass brighten and the far sides fall into shadow.
   */
  vec4 cloudDeck(vec3 d, float alt, float scale, float cover, vec2 drift,
                 int oct, vec3 sunCol, vec3 ambCol, float density) {
    // Below a degree or so the shell intersection runs off to the horizon and
    // the deck is faded out anyway; bailing here skips the whole evaluation for
    // the lower half of the frame.
    if (d.y < 0.014) return vec4(0.0);
    float t = shellDist(d, alt);
    if (t < 0.0) return vec4(0.0);

    vec3 p = vec3(0.0, 6360002.0, 0.0) + d * t;
    vec2 q = p.xz * scale + drift * uCloudTime;

    float n = cfbm(q, oct);
    float a = smoothstep(cover, cover + 0.26, n);
    if (a <= 0.001) return vec4(0.0);

    // Second sample toward the sun, at coarser detail: cheap self-shadowing.
    vec2 qs = q + uSunDir.xz * (900.0 * scale);
    float ns = cfbm(qs, max(2, oct - 2));
    float shadow = smoothstep(cover, cover + 0.26, ns);

    // Beer-Powder: dark cores, bright silver rims.
    float depth = a * density;
    float light = exp(-depth * 1.6 * (0.35 + shadow)) * (1.0 - exp(-depth * 2.4));
    vec3 col = ambCol * (0.55 + 0.45 * (1.0 - a)) + sunCol * light * 1.35;

    // Forward scattering: clouds in front of the sun glow around their edges.
    float fs = max(0.0, dot(d, uSunDir));
    col += sunCol * pow(fs, 8.0) * (1.0 - a) * 0.8;

    // Aerial perspective, and a fade through the last few degrees of horizon
    // where the shell intersection stretches to infinity.
    float far = 1.0 - exp(-t * 2.2e-5);
    col = mix(col, skyRadiance(d), far * 0.85);
    a *= smoothstep(0.0, 0.09, d.y) * (1.0 - far * 0.35);

    return vec4(col * a, a);
  }
`;

const VERT = /* glsl */`
  varying vec3 vDir;
  void main() {
    vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  varying vec3 vDir;
  uniform float time;
  uniform int uCloudOctaves;

  ${ATMOSPHERE_PARS}
  ${CLOUD_PARS}
  ${CLOUD_BODY}

  void main() {
    vec3 d = normalize(vDir);

    vec3 col = skyRadiance(d);

    // Ground half: fade to a dark haze rather than mirroring the sky, so the
    // dome never shows a bright band under the terrain silhouette.
    float below = smoothstep(0.0, -0.09, d.y);
    col = mix(col, col * 0.42, below);

    // Reference colours for lighting the decks.
    vec3 sunCol = sunTransmittance(uSunDir) * 1.30 * uSkyGain;
    vec3 ambCol = skyRadiance(vec3(0.0, 1.0, 0.0)) * 1.15;

    // Two decks: cumulus low and dense, cirrus high and stretched. Drawing the
    // high deck first and compositing the low deck over it is what gives the
    // sky a sense of layers instead of one flat noise field.
    vec4 hi = cloudDeck(d, 7000.0, 0.00028, uCloudCover + 0.16, vec2(0.9, 0.35),
                        max(2, uCloudOctaves - 2), sunCol, ambCol, 0.55);
    col = col * (1.0 - hi.a) + hi.rgb;

    // The low deck is scaled so a single mass spans roughly a kilometre: much
    // larger and the whole sky is one cloud, much smaller and it granulates
    // into noise instead of reading as weather.
    vec4 lo = cloudDeck(d, 1900.0, 0.00115, uCloudCover + 0.04, vec2(0.55, 0.2),
                        uCloudOctaves, sunCol, ambCol, 1.6);
    col = col * (1.0 - lo.a) + lo.rgb;

    // Sun disc with limb darkening, occluded by whatever cloud is in front.
    float cs = dot(d, uSunDir);
    const float DISC = 0.9999;                 // cos of ~0.8 degrees
    float r = clamp((1.0 - cs) / (1.0 - DISC), 0.0, 1.0);
    float limb = 1.0 - 0.62 * (1.0 - sqrt(max(0.0, 1.0 - r * r)));
    float disc = smoothstep(1.0, 0.965, r) * limb;
    col += sunTransmittance(d) * disc * 90.0 * uSkyGain * (1.0 - lo.a) * (1.0 - hi.a * 0.6);

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

// ------------------------------------------------------------------ assembly

/**
 * Build the sky dome.
 *
 * @param {THREE.Vector3} sunDirection normalised direction *toward* the sun.
 * @returns {THREE.Mesh} add it to the scene; keep it centred on the camera.
 *
 * The returned material exposes a `time` uniform (seconds) which main.js
 * already drives. The mesh also fans a per-frame tick out to framehooks.js and
 * keeps `scene.fog.color` locked to the horizon colour, so nothing else needs
 * wiring for the atmosphere to stay coherent.
 */
export function createSky(sunDirection) {
  const u = ensureAtmosphere(sunDirection);

  const geo = new THREE.SphereGeometry(1, 40, 24);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      time: { value: 0 },
      tSkyR: u.tSkyR,
      tSkyM: u.tSkyM,
      tSunT: u.tSunT,
      uSunDir: u.uSunDir,
      uSkyGain: u.uSkyGain,
      uCloudTime: u.uCloudTime,
      uCloudCover: u.uCloudCover,
      uCloudOctaves: u.uCloudOctaves,
    },
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(600);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;

  let fogSynced = false;
  mesh.onBeforeRender = (renderer, scene, camera) => {
    const t = mat.uniforms.time.value;
    u.uCloudTime.value = t * CLOUD_DRIFT_TIME_SCALE;

    if (!fogSynced && scene && scene.fog) {
      // The fog is the ground-level continuation of the horizon: if they
      // disagree, distant terrain reads as a decal on the backdrop.
      scene.fog.color.copy(ATMOSPHERE.fog);
      fogSynced = true;
    }

    runFrameHooks(renderer, scene, camera, t);
  };

  return mesh;
}

/**
 * Cloud detail level. 5 is the default; 3 roughly halves the sky's pixel cost
 * and is the first thing to drop on a weak GPU.
 */
export function setCloudQuality(octaves) {
  uniforms.uCloudOctaves.value = Math.max(2, Math.min(6, octaves | 0));
}

/** Overall sky brightness multiplier, for matching a different exposure. */
export function setSkyGain(gain) {
  uniforms.uSkyGain.value = gain;
}
