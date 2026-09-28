// Surfaces for the buildings.
//
// Untextured boxes are what make an interior read as voxel: a flat colour has
// no scale, so a 6m wall and a 0.6m desk look like the same object at different
// zoom levels. What fixes that is not more polygons but a surface -- once a
// wall has grain and a floor has grout lines, your eye can size the room.
//
// Every map here is generated once into a canvas and shared by every wall in
// every building, so the whole set costs a handful of textures rather than one
// per surface. Nothing runs at module scope, so the headless tests can import
// anything that imports this.

import * as THREE from '../../vendor/three.module.js';

const CACHE = new Map();
const S = 256;

function canRender() {
  return typeof document !== 'undefined' && !!document.createElement;
}

function canvas() {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  return c;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Value noise smoothed by averaging neighbours -- cheap and tileable. */
function noiseField(seed, scale) {
  const rand = rng(seed);
  const n = Math.max(2, Math.floor(S / scale));
  const grid = new Float32Array(n * n);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();

  return (x, y) => {
    const fx = (x / S) * n, fy = (y / S) * n;
    const i = Math.floor(fx), j = Math.floor(fy);
    const u = fx - i, v = fy - j;
    const at = (a, b) => grid[((b % n) + n) % n * n + (((a % n) + n) % n)];
    const s0 = at(i, j) * (1 - u) + at(i + 1, j) * u;
    const s1 = at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u;
    return s0 * (1 - v) + s1 * v;
  };
}

/** Grey aggregate with blotching and the odd dark pit. */
function drawConcrete(ctx, seed, base = [154, 148, 144]) {
  const coarse = noiseField(seed, 42);
  const fine = noiseField(seed + 1, 5);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = 0.72 + coarse(x, y) * 0.24 + fine(x, y) * 0.14;
      const i = (y * S + x) * 4;
      d[i] = base[0] * v; d[i + 1] = base[1] * v; d[i + 2] = base[2] * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Pitting, which is what stops concrete looking like grey paint.
  const rand = rng(seed + 7);
  for (let i = 0; i < 260; i++) {
    const r = 0.6 + rand() * 1.8;
    ctx.fillStyle = `rgba(0,0,0,${0.05 + rand() * 0.12})`;
    ctx.beginPath();
    ctx.arc(rand() * S, rand() * S, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Painted plaster: flatter than concrete, with scuffs along the bottom. */
function drawPlaster(ctx, seed, base = [200, 194, 184]) {
  const blotch = noiseField(seed, 60);
  const grain = noiseField(seed + 2, 3);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = 0.88 + blotch(x, y) * 0.1 + grain(x, y) * 0.05;
      const i = (y * S + x) * 4;
      d[i] = base[0] * v; d[i + 1] = base[1] * v; d[i + 2] = base[2] * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const rand = rng(seed + 11);
  for (let i = 0; i < 40; i++) {
    // Scuffs concentrate low, where furniture and boots reach.
    const y = S * (0.55 + rand() * 0.45);
    ctx.strokeStyle = `rgba(90,80,70,${0.05 + rand() * 0.1})`;
    ctx.lineWidth = 0.6 + rand() * 1.6;
    ctx.beginPath();
    ctx.moveTo(rand() * S, y);
    ctx.lineTo(rand() * S, y + (rand() - 0.5) * 8);
    ctx.stroke();
  }
}

/** Boards with visible joints and a bit of figure. */
function drawWood(ctx, seed, base = [140, 104, 64]) {
  const rand = rng(seed);
  const grain = noiseField(seed + 3, 2);
  const boards = 6;
  const bh = S / boards;

  for (let b = 0; b < boards; b++) {
    const tone = 0.82 + rand() * 0.3;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < S; x++) {
        // Long streaks along the board, not blobs.
        const g = 0.9 + Math.sin(x * 0.06 + b * 3.1) * 0.05 + grain(x, y + b * bh) * 0.12;
        ctx.fillStyle = `rgb(${base[0] * tone * g | 0},${base[1] * tone * g | 0},${base[2] * tone * g | 0})`;
        ctx.fillRect(x, b * bh + y, 1, 1);
      }
    }
    // Joint line between boards.
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, b * bh, S, 1);
  }
}

/** Brushed painted metal. */
function drawMetal(ctx, seed, base = [120, 128, 136]) {
  const blotch = noiseField(seed, 30);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = 0.85 + blotch(x, y) * 0.2;
      const i = (y * S + x) * 4;
      d[i] = base[0] * v; d[i + 1] = base[1] * v; d[i + 2] = base[2] * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const rand = rng(seed + 5);
  ctx.globalAlpha = 0.06;
  ctx.strokeStyle = '#ffffff';
  for (let i = 0; i < 200; i++) {
    const y = rand() * S;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(S, y + (rand() - 0.5) * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Mortar and grout are generated into both the albedo and derived normal map.
function drawMasonry(ctx, seed, base, stagger) {
  drawConcrete(ctx, seed, base);
  const row=S/8, column=S/4;
  ctx.strokeStyle='rgba(32,29,26,.65)';ctx.lineWidth=3;
  for(let j=0;j<8;j++) {
    ctx.beginPath();ctx.moveTo(0,j*row);ctx.lineTo(S,j*row);ctx.stroke();
    const offset=stagger && j%2 ? column/2 : 0;
    for(let x=offset;x<=S;x+=column){
      ctx.beginPath();ctx.moveTo(x,j*row);ctx.lineTo(x,(j+1)*row);ctx.stroke();
    }
  }
}

/** One 4.2m facade bay: stained concrete, two recessed steel windows,
 * sill shadows and formwork joints. Opaque baked detail needs no extra pass. */
function drawFacade(ctx,seed,base) {
  drawConcrete(ctx,seed,base);
  const rand=rng(seed+37);
  // Uneven water runoff rather than uniformly noisy, clean painted walls.
  for(let i=0;i<65;i++) {
    const x=rand()*S,w=1+rand()*7;
    const g=ctx.createLinearGradient(0,12,0,S);
    g.addColorStop(0,'rgba(42,48,29,.24)');
    g.addColorStop(.75,'rgba(42,48,29,.04)');g.addColorStop(1,'rgba(42,48,29,0)');
    ctx.fillStyle=g;ctx.fillRect(x,0,w,S);
  }
  ctx.fillStyle='rgba(38,37,31,.3)';ctx.fillRect(0,0,S,2);
  ctx.fillRect(0,0,1,S);
  for(const x of [28,153]) {
    ctx.fillStyle='rgba(29,29,25,.34)';ctx.fillRect(x-4,62,65,113);
    ctx.fillStyle='#343b38';ctx.fillRect(x,66,57,101);
    const glass=ctx.createLinearGradient(0,68,0,161);
    glass.addColorStop(0,'#58635e');glass.addColorStop(.45,'#39433f');
    glass.addColorStop(.5,'#2b3530');glass.addColorStop(1,'#303a32');
    ctx.fillStyle=glass;ctx.fillRect(x+4,70,49,93);
    ctx.fillStyle='#232923';ctx.fillRect(x+27,70,3,94);ctx.fillRect(x+4,118,49,3);
    ctx.fillStyle='rgba(180,183,162,.22)';ctx.fillRect(x+5,72,2,43);
    ctx.fillStyle='rgba(204,198,176,.6)';ctx.fillRect(x-3,168,64,3);
    ctx.fillStyle='rgba(27,27,22,.22)';ctx.fillRect(x-3,171,64,4);
  }
}

const DRAW = {
  facade: drawFacade,
  brick: (ctx,seed,base)=>drawMasonry(ctx,seed,base,true),
  tile: (ctx,seed,base)=>drawMasonry(ctx,seed,base,false),
  concrete: drawConcrete,
  plaster: drawPlaster,
  wood: drawWood,
  metal: drawMetal,
};

/**
 * A normal map derived from an albedo's luminance.
 *
 * Sobel over brightness is not physically the same thing as real height, but
 * for aggregate, grain and board joints it is close enough that the eye reads
 * relief -- and it costs one pass over a canvas instead of an authored map.
 */
function normalFrom(src, strength = 2.2) {
  const out = canvas();
  const octx = out.getContext('2d');
  const sctx = src.getContext('2d');
  const s = sctx.getImageData(0, 0, S, S).data;
  const img = octx.createImageData(S, S);
  const d = img.data;

  const lum = (x, y) => {
    const i = ((((y % S) + S) % S) * S + (((x % S) + S) % S)) * 4;
    return (s[i] * 0.299 + s[i + 1] * 0.587 + s[i + 2] * 0.114) / 255;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (lum(x + 1, y) - lum(x - 1, y)) * strength;
      const dy = (lum(x, y + 1) - lum(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      d[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      d[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/**
 * Albedo + normal for one surface kind, cached forever.
 *
 * @returns {{map, normalMap}} or null with no DOM
 */
export function surface(kind, { seed = 1, tint, repeat = 1, strength } = {}) {
  if (!canRender() || !DRAW[kind]) return null;

  const key = `${kind}|${seed}|${tint ?? ''}|${repeat}`;
  if (CACHE.has(key)) return CACHE.get(key);

  const c = canvas();
  DRAW[kind](c.getContext('2d'), seed, tint);
  const n = normalFrom(c, strength ?? 2.2);

  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = new THREE.CanvasTexture(n);
  for (const t of [map, normalMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = 4;
  }

  const made = { map, normalMap };
  CACHE.set(key, made);
  return made;
}

export function disposeSurfaces() {
  for (const s of CACHE.values()) {
    s.map.dispose();
    s.normalMap.dispose();
  }
  CACHE.clear();
}
