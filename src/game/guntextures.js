// Procedural weapon finishes: camo, weave, hex, damascus, splinter.
//
// The first pass at skins repainted parts a flat colour, which reads as plastic
// at the distance a viewmodel actually sits from the camera -- roughly 30cm.
// Real gun finishes have pattern *and* a varying surface: a camo is printed
// over metal, so the paint is matte where the pattern is and the bare metal
// underneath still catches light. So every finish here bakes two maps, albedo
// and roughness, from the same underlying pattern field.
//
// Everything is generated into a canvas on demand and cached forever. Nothing
// runs at module scope, which is what keeps this file importable by the
// headless tests -- they read the catalogue without ever touching a canvas.

const CACHE = new Map();
const SIZE = 256;

/** True in a browser with a usable 2D canvas. */
function canRender() {
  return typeof document !== 'undefined' && !!document.createElement;
}

function makeCanvas() {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  return c;
}

const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0');

/**
 * Deterministic value noise.
 *
 * Seeded so a given skin looks the same on every launch -- a camo that
 * reshuffled per session would read as a rendering bug.
 */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Blobby camo, the classic. Overlapping soft-edged islands, drawn darkest
 * first so later colours read as sitting on top rather than beside.
 */
function drawCamo(ctx, colors, seed, blobs = 34, scale = 1) {
  const rand = rng(seed);
  ctx.fillStyle = hex(colors[0]);
  ctx.fillRect(0, 0, SIZE, SIZE);

  for (let layer = 1; layer < colors.length; layer++) {
    ctx.fillStyle = hex(colors[layer]);
    for (let i = 0; i < blobs; i++) {
      const cx = rand() * SIZE;
      const cy = rand() * SIZE;
      const r = (14 + rand() * 34) * scale;

      // A blob is a ring of wobbled points, not a circle: circles read as
      // polka dots, and camo is defined by its irregular edge.
      ctx.beginPath();
      const steps = 9;
      for (let s = 0; s <= steps; s++) {
        const a = (s / steps) * Math.PI * 2;
        const rr = r * (0.62 + rand() * 0.7);
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();

      // Wrap across the seam so the pattern tiles without a visible edge.
      for (const [dx, dy] of [[-SIZE, 0], [SIZE, 0], [0, -SIZE], [0, SIZE]]) {
        ctx.save();
        ctx.translate(dx, dy);
        ctx.fill();
        ctx.restore();
      }
    }
  }
}

/** Pixelated digital camo -- same islands, quantised to a grid. */
function drawDigital(ctx, colors, seed, cell = 8) {
  const rand = rng(seed);
  const cells = SIZE / cell;
  // Start from a low-res blob field, then snap it to the grid.
  const field = [];
  const centres = [];
  for (let i = 0; i < 26; i++) {
    centres.push({ x: rand() * cells, y: rand() * cells, r: 2 + rand() * 5,
      c: 1 + Math.floor(rand() * (colors.length - 1)) });
  }
  for (let y = 0; y < cells; y++) {
    field[y] = [];
    for (let x = 0; x < cells; x++) {
      let pick = 0;
      let best = Infinity;
      for (const c of centres) {
        // Toroidal distance, so the grid tiles.
        const dx = Math.min(Math.abs(x - c.x), cells - Math.abs(x - c.x));
        const dy = Math.min(Math.abs(y - c.y), cells - Math.abs(y - c.y));
        const d = Math.hypot(dx, dy) - c.r;
        if (d < 0 && d < best) { best = d; pick = c.c; }
      }
      field[y][x] = pick;
    }
  }
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = hex(colors[field[y][x]]);
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
}

/** Tiger stripe: torn horizontal bands. */
function drawTiger(ctx, colors, seed) {
  const rand = rng(seed);
  ctx.fillStyle = hex(colors[0]);
  ctx.fillRect(0, 0, SIZE, SIZE);

  for (let layer = 1; layer < colors.length; layer++) {
    ctx.fillStyle = hex(colors[layer]);
    const bands = 7 + layer * 3;
    for (let i = 0; i < bands; i++) {
      const y = rand() * SIZE;
      const h = 4 + rand() * 11;
      ctx.beginPath();
      ctx.moveTo(0, y);
      // A ragged upper edge and a ragged lower edge, drawn as one closed path.
      for (let x = 0; x <= SIZE; x += 16) ctx.lineTo(x, y + (rand() - 0.5) * 9);
      for (let x = SIZE; x >= 0; x -= 16) ctx.lineTo(x, y + h + (rand() - 0.5) * 9);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/** Carbon-fibre twill: a 2x2 basket weave. */
function drawWeave(ctx, colors) {
  const [dark, light] = colors;
  const cell = 16;
  ctx.fillStyle = hex(dark);
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let y = 0; y < SIZE; y += cell) {
    for (let x = 0; x < SIZE; x += cell) {
      const over = ((x / cell) + (y / cell)) % 2 === 0;
      const g = ctx.createLinearGradient(x, y, x + cell, y + cell);
      // The highlight runs along the tow, so alternating tiles catch light
      // from opposite directions -- that flip is what reads as woven.
      g.addColorStop(0, hex(over ? light : dark));
      g.addColorStop(0.5, hex(over ? dark : light));
      g.addColorStop(1, hex(over ? light : dark));
      ctx.fillStyle = g;
      ctx.fillRect(x, y, cell, cell);
    }
  }
}

/** Hex tech plating. */
function drawHex(ctx, colors) {
  const [base, line, glow] = colors;
  ctx.fillStyle = hex(base);
  ctx.fillRect(0, 0, SIZE, SIZE);

  const r = 22;
  const w = Math.sqrt(3) * r;
  ctx.lineWidth = 2;
  ctx.strokeStyle = hex(line);
  for (let row = -1; row * r * 1.5 < SIZE + r; row++) {
    for (let col = -1; col * w < SIZE + w; col++) {
      const cx = col * w + (row % 2 ? w / 2 : 0);
      const cy = row * r * 1.5;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 180 * (60 * i - 30);
        const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  if (glow !== undefined) {
    ctx.strokeStyle = hex(glow);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** Damascus / folded steel: layered contour bands. */
function drawDamascus(ctx, colors, seed) {
  const rand = rng(seed);
  const [dark, light] = colors;
  const img = ctx.createImageData(SIZE, SIZE);
  const d = new Uint8ClampedArray(img.data.buffer);

  // A few sine fields at different angles, folded through abs() -- the same
  // trick that makes contour lines, which is what pattern-welded steel is.
  const waves = [];
  for (let i = 0; i < 5; i++) {
    waves.push({
      a: rand() * Math.PI, f: 0.02 + rand() * 0.06, p: rand() * 6.28,
      amp: 0.5 + rand(),
    });
  }
  const c0 = { r: (dark >> 16) & 255, g: (dark >> 8) & 255, b: dark & 255 };
  const c1 = { r: (light >> 16) & 255, g: (light >> 8) & 255, b: light & 255 };

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let v = 0;
      for (const w of waves) {
        v += Math.sin((x * Math.cos(w.a) + y * Math.sin(w.a)) * w.f + w.p) * w.amp;
      }
      // Sharpen into bands.
      const t = Math.abs(Math.sin(v * 1.7));
      const k = t * t;
      const i = (y * SIZE + x) * 4;
      d[i] = c0.r + (c1.r - c0.r) * k;
      d[i + 1] = c0.g + (c1.g - c0.g) * k;
      d[i + 2] = c0.b + (c1.b - c0.b) * k;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Angular splinter camo. */
function drawSplinter(ctx, colors, seed) {
  const rand = rng(seed);
  ctx.fillStyle = hex(colors[0]);
  ctx.fillRect(0, 0, SIZE, SIZE);
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = hex(colors[1 + Math.floor(rand() * (colors.length - 1))]);
    const x = rand() * SIZE, y = rand() * SIZE;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const n = 3 + Math.floor(rand() * 3);
    for (let k = 0; k < n; k++) {
      ctx.lineTo(x + (rand() - 0.5) * 90, y + (rand() - 0.5) * 90);
    }
    ctx.closePath();
    ctx.fill();
  }
}

const TAU = Math.PI * 2;

/**
 * Tileable value noise.
 *
 * Built from sinusoids whose frequencies are whole numbers of cycles across the
 * canvas, which is the cheap way to guarantee the field is periodic:
 * `f(x + SIZE) === f(x)` exactly, so anything drawn from it wraps without a
 * seam. `drawDamascus` predates this and picks arbitrary frequencies, which is
 * why its banding shows a join if you go looking for one -- everything added
 * since goes through here instead.
 *
 * @returns f(x, y) in roughly [-1, 1]
 */
function noiseField(seed, octaves = 4) {
  const rand = rng(seed);
  const waves = [];
  for (let o = 0; o < octaves; o++) {
    const f = 1 << o;
    waves.push({
      fx: f * (1 + Math.floor(rand() * 2)),
      fy: f * (1 + Math.floor(rand() * 2)),
      px: rand() * TAU,
      py: rand() * TAU,
      amp: 1 / (o + 1),
    });
  }
  const norm = waves.reduce((s, w) => s + w.amp, 0);
  return (x, y) => {
    let v = 0;
    for (const w of waves) {
      v += Math.sin((x / SIZE) * TAU * w.fx + w.px)
        * Math.cos((y / SIZE) * TAU * w.fy + w.py) * w.amp;
    }
    return v / norm;
  };
}

const chan = (c) => ({ r: (c >> 16) & 255, g: (c >> 8) & 255, b: c & 255 });

/** Write one lerped pixel. Callers own the bounds check; this is a hot path. */
function blend(d, i, a, b, t) {
  d[i] = a.r + (b.r - a.r) * t;
  d[i + 1] = a.g + (b.g - a.g) * t;
  d[i + 2] = a.b + (b.b - a.b) * t;
  d[i + 3] = 255;
}

/** The nine translations that make a wrapped draw cover every seam. */
function wrapped(ctx, draw) {
  for (let ox = -1; ox <= 1; ox++) {
    for (let oy = -1; oy <= 1; oy++) draw(ox * SIZE, oy * SIZE);
  }
}

/**
 * Pointy-top hexagon. Half-width and half-height are independent because the
 * lattice below is stretched slightly to make a whole number of cells fit the
 * canvas -- a hex that is 8% tall is indistinguishable at viewmodel size, and a
 * lattice that does not divide the canvas is a visible seam down the receiver.
 */
function hexPath(ctx, cx, cy, hw, r) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + hw, cy - r / 2);
  ctx.lineTo(cx + hw, cy + r / 2);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - hw, cy + r / 2);
  ctx.lineTo(cx - hw, cy - r / 2);
  ctx.closePath();
}

/**
 * Hex camo: the blobby islands of a classic camo, quantised to a hex lattice
 * rather than a square one.
 *
 * `rows` must be even, or the half-column offset on odd rows does not line up
 * with itself across the vertical seam and the pattern tears.
 */
function drawHexCamo(ctx, colors, seed, cols = 8, rows = 12, line, islands = 18) {
  const rand = rng(seed);
  const w = SIZE / cols;
  const rowH = SIZE / rows;
  const hw = w / 2;
  const r = rowH * (2 / 3);   // vertical pitch of a pointy-top hex is 1.5r

  // Island centres live in cell space and are measured toroidally, so the
  // islands wrap with the lattice instead of being clipped at the edge.
  const centres = [];
  for (let i = 0; i < islands; i++) {
    centres.push({
      x: rand() * cols, y: rand() * rows, rad: 1.3 + rand() * 3.2,
      c: 1 + Math.floor(rand() * (colors.length - 1)),
    });
  }
  const aspect = rowH / w;   // keeps islands round in pixels, not in cells
  const pick = (col, row) => {
    let best = Infinity, out = 0;
    for (const c of centres) {
      const dx = Math.min(Math.abs(col - c.x), cols - Math.abs(col - c.x));
      const dy = Math.min(Math.abs(row - c.y), rows - Math.abs(row - c.y));
      const d = Math.hypot(dx, dy * aspect) - c.rad;
      if (d < 0 && d < best) { best = d; out = c.c; }
    }
    return out;
  };

  ctx.fillStyle = hex(colors[0]);
  ctx.fillRect(0, 0, SIZE, SIZE);
  if (line !== undefined) {
    ctx.strokeStyle = hex(line);
    ctx.lineWidth = 1;
  }
  for (let row = -1; row <= rows; row++) {
    for (let col = -1; col <= cols; col++) {
      const cx = col * w + ((((row % 2) + 2) % 2) ? hw : 0);
      const cy = row * rowH;
      const c = pick(((col % cols) + cols) % cols, ((row % rows) + rows) % rows);
      ctx.fillStyle = hex(colors[c]);
      hexPath(ctx, cx, cy, hw, r);
      ctx.fill();
      if (line !== undefined) ctx.stroke();
    }
  }
}

/**
 * Marble / pattern-welded steel: turbulent veining.
 *
 * The classic recipe -- a sine ramp whose coordinate is displaced by noise, so
 * the bands fold and pinch instead of running straight. The vein colour is
 * raised to a high power of the band value so it stays a hairline: a wide vein
 * reads as a third camo colour rather than as a crack in stone.
 */
function drawMarble(ctx, colors, seed, veinPower = 14, cycles = 3) {
  const [dark, light, vein] = colors;
  const turb = noiseField(seed, 5);
  const warp = noiseField(seed + 977, 3);
  const c0 = chan(dark), c1 = chan(light), cv = chan(vein ?? light);

  const img = ctx.createImageData(SIZE, SIZE);
  const d = img.data;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const v = Math.sin(TAU * cycles * (x / SIZE) + turb(x, y) * 5.5
        + warp(y, x) * 2.2);
      const t = Math.abs(v);
      const i = (y * SIZE + x) * 4;
      blend(d, i, c0, c1, t * t);
      if (vein !== undefined) {
        const k = Math.pow(t, veinPower);
        blend(d, i, { r: d[i], g: d[i + 1], b: d[i + 2] }, cv, k);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Oxidised copper: bare metal under creeping verdigris.
 *
 * Two noise fields rather than one. A single field thresholded gives patches
 * with a smooth edge, which reads as paint; corrosion spreads unevenly, so the
 * threshold itself is perturbed by the second field and the patch edge comes
 * out ragged. The pale bloom sits in the narrow band either side of the
 * threshold, which is where the powdery growth actually is.
 */
function drawOxide(ctx, colors, seed, coverage = 0.1) {
  const [copper, patina, deep, bloom] = colors;
  const nA = noiseField(seed, 4);
  const nB = noiseField(seed + 313, 5);
  const cCu = chan(copper), cPa = chan(patina);
  const cDe = chan(deep ?? patina), cBl = chan(bloom ?? patina);

  const img = ctx.createImageData(SIZE, SIZE);
  const d = img.data;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const a = nA(x, y);
      const b = nB(x, y);
      const f = a + b * 0.45 - coverage;
      const i = (y * SIZE + x) * 4;
      if (f > 0) {
        // Deeper inside the patch the growth thickens and darkens.
        blend(d, i, cPa, cDe, Math.min(1, f * 2.4));
      } else {
        // Bare metal keeps the noise as a tarnish gradient, never flat.
        blend(d, i, cCu, cPa, Math.max(0, 0.35 + a * 0.4));
      }
      const edge = 1 - Math.min(1, Math.abs(f) * 14);
      if (edge > 0) {
        blend(d, i, { r: d[i], g: d[i + 1], b: d[i + 2] }, cBl, edge * 0.75);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Arctic fracture: shattered ice.
 *
 * A Voronoi diagram over a jittered grid, wrapped toroidally so it tiles, with
 * the crack drawn where the nearest and second-nearest sites are equidistant.
 * That distance difference is the standard way to get cell *borders* out of a
 * Voronoi -- filling cells and stroking their outlines separately would need
 * the polygons, which is far more work for the same picture.
 */
function drawFracture(ctx, colors, seed, cells = 6, crackWidth = 2.6) {
  const rand = rng(seed);
  const step = SIZE / cells;
  const sites = [];
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      sites.push({
        x: (gx + 0.15 + rand() * 0.7) * step,
        y: (gy + 0.15 + rand() * 0.7) * step,
        gx, gy,
        c: 1 + Math.floor(rand() * Math.max(1, colors.length - 2)),
      });
    }
  }
  const at = (gx, gy) => sites[(((gy % cells) + cells) % cells) * cells
    + (((gx % cells) + cells) % cells)];
  const crack = chan(colors[colors.length - 1]);
  const base = chan(colors[0]);
  const shard = colors.map(chan);

  const img = ctx.createImageData(SIZE, SIZE);
  const d = img.data;
  for (let y = 0; y < SIZE; y++) {
    const gy = Math.floor(y / step);
    for (let x = 0; x < SIZE; x++) {
      const gx = Math.floor(x / step);
      let d1 = Infinity, d2 = Infinity, win = null;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const s = at(gx + ox, gy + oy);
          // The site's own grid cell may be a wrap away, so measure to the
          // copy of it that sits next to this pixel rather than to the original.
          const sx = s.x + (gx + ox - s.gx) * step;
          const sy = s.y + (gy + oy - s.gy) * step;
          const dist = Math.hypot(x - sx, y - sy);
          if (dist < d1) { d2 = d1; d1 = dist; win = s; } else if (dist < d2) d2 = dist;
        }
      }
      const i = (y * SIZE + x) * 4;
      // Shading across the shard sells it as a facet catching light rather
      // than a flat sticker.
      blend(d, i, base, shard[win.c], 0.35 + Math.min(0.65, d1 / step));
      const edge = 1 - Math.min(1, (d2 - d1) / crackWidth);
      if (edge > 0) {
        blend(d, i, { r: d[i], g: d[i + 1], b: d[i + 2] }, crack, edge);
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * Circuit etch: traces on a board.
 *
 * The walks are allowed to wander off the canvas and the whole run is then
 * stroked at all nine wrap offsets. Clipping a walk at the edge instead would
 * leave every trace terminating in mid-air along the seam, which is the one
 * thing that gives a tiled texture away.
 */
function drawCircuit(ctx, colors, seed, grid = 16, runs = 26) {
  const rand = rng(seed);
  const [board, trace, pad, lit] = colors;
  ctx.fillStyle = hex(board);
  ctx.fillRect(0, 0, SIZE, SIZE);

  const step = SIZE / grid;
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const paths = [];
  for (let i = 0; i < runs; i++) {
    let x = Math.floor(rand() * grid), y = Math.floor(rand() * grid);
    let dir = Math.floor(rand() * 4);
    const pts = [[x, y]];
    const len = 4 + Math.floor(rand() * 8);
    for (let k = 0; k < len; k++) {
      if (rand() < 0.34) dir = (dir + (rand() < 0.5 ? 1 : 3)) % 4;
      const run = 1 + Math.floor(rand() * 2);
      x += DX[dir] * run;
      y += DY[dir] * run;
      pts.push([x, y]);
    }
    paths.push({ pts, lit: lit !== undefined && rand() < 0.22 });
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const p of paths) {
    ctx.strokeStyle = hex(p.lit ? lit : trace);
    ctx.lineWidth = p.lit ? 3 : 2;
    wrapped(ctx, (dx, dy) => {
      ctx.beginPath();
      p.pts.forEach(([px, py], i) => {
        const X = px * step + dx, Y = py * step + dy;
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      });
      ctx.stroke();
    });
  }

  ctx.fillStyle = hex(pad);
  for (const p of paths) {
    for (const [px, py] of [p.pts[0], p.pts[p.pts.length - 1]]) {
      wrapped(ctx, (dx, dy) => {
        ctx.beginPath();
        ctx.arc(px * step + dx, py * step + dy, 3.2, 0, TAU);
        ctx.fill();
      });
    }
  }
}

/** Fine machining marks, laid over everything so bare metal is never flat. */
function overlayGrain(ctx, strength = 0.05, seed = 7) {
  const rand = rng(seed);
  ctx.globalAlpha = strength;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  for (let i = 0; i < 220; i++) {
    const y = rand() * SIZE;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(SIZE, y + (rand() - 0.5) * 3);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

const DRAW = {
  camo: (ctx, p) => drawCamo(ctx, p.colors, p.seed ?? 1, p.blobs, p.scale ?? 1),
  digital: (ctx, p) => drawDigital(ctx, p.colors, p.seed ?? 1, p.cell ?? 8),
  tiger: (ctx, p) => drawTiger(ctx, p.colors, p.seed ?? 1),
  weave: (ctx, p) => drawWeave(ctx, p.colors),
  hex: (ctx, p) => drawHex(ctx, p.colors),
  damascus: (ctx, p) => drawDamascus(ctx, p.colors, p.seed ?? 1),
  splinter: (ctx, p) => drawSplinter(ctx, p.colors, p.seed ?? 1),
  hexcamo: (ctx, p) => drawHexCamo(ctx, p.colors, p.seed ?? 1, p.cols ?? 8,
    p.rows ?? 12, p.line, p.islands ?? 18),
  marble: (ctx, p) => drawMarble(ctx, p.colors, p.seed ?? 1, p.veinPower ?? 14,
    p.cycles ?? 3),
  oxide: (ctx, p) => drawOxide(ctx, p.colors, p.seed ?? 1, p.coverage ?? 0.1),
  fracture: (ctx, p) => drawFracture(ctx, p.colors, p.seed ?? 1, p.cells ?? 6,
    p.crackWidth ?? 2.6),
  circuit: (ctx, p) => drawCircuit(ctx, p.colors, p.seed ?? 1, p.grid ?? 16,
    p.runs ?? 26),
};

/** Pattern types this module knows how to draw -- the catalogues validate against it. */
export const PATTERN_TYPES = Object.keys(DRAW);

/**
 * Draw a pattern onto a canvas and hand it back.
 * @returns an HTMLCanvasElement, or null when there is no DOM
 */
export function patternCanvas(pattern) {
  if (!canRender() || !pattern || !DRAW[pattern.type]) return null;

  const key = JSON.stringify(pattern);
  if (CACHE.has(key)) return CACHE.get(key);

  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  DRAW[pattern.type](ctx, pattern);
  if (pattern.grain !== false) overlayGrain(ctx, pattern.grain ?? 0.05, pattern.seed ?? 7);

  CACHE.set(key, canvas);
  return canvas;
}

/**
 * A roughness map derived from the albedo.
 *
 * Painted areas are matte and bare metal is polished, so luminance maps almost
 * directly onto roughness -- inverted, because the darker paint is the rougher
 * surface. This is what stops a camo looking like a decal on plastic.
 */
export function roughnessCanvas(pattern, lo = 0.3, hi = 0.85) {
  if (!canRender() || !pattern) return null;

  const key = 'rough:' + JSON.stringify(pattern) + lo + hi;
  if (CACHE.has(key)) return CACHE.get(key);

  const src = patternCanvas(pattern);
  if (!src) return null;

  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0);

  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
    const r = Math.round((hi - (hi - lo) * lum) * 255);
    d[i] = d[i + 1] = d[i + 2] = r;
  }
  ctx.putImageData(img, 0, 0);

  CACHE.set(key, canvas);
  return canvas;
}

/**
 * A tangent-space normal map derived from the albedo.
 *
 * There is no height information anywhere in this system, so the pattern's own
 * luminance stands in for one: on every finish here the dark areas are the
 * printed or corroded layer and the light areas are the raised, polished metal
 * under it, which is exactly the relationship a height map encodes. A Sobel
 * gradient over that gives a normal good enough to catch the viewmodel's key
 * light along a hex edge or a circuit trace -- which is the whole point, since
 * at 30cm from the camera a flat map reads as a printed sticker.
 *
 * The gradient is sampled with wrap, so the normal map tiles wherever its
 * source does.
 *
 * @param strength 0 gives a flat map; ~1 is a firm etch. Above about 2 the
 *   pattern starts to look embossed rather than finished.
 */
export function normalCanvas(pattern, strength = 1) {
  if (!canRender() || !pattern) return null;

  const key = `normal:${JSON.stringify(pattern)}|${strength}`;
  if (CACHE.has(key)) return CACHE.get(key);

  const src = patternCanvas(pattern);
  if (!src) return null;

  const scratch = makeCanvas();
  const sctx = scratch.getContext('2d');
  sctx.drawImage(src, 0, 0);
  const s = sctx.getImageData(0, 0, SIZE, SIZE).data;

  // Luminance once up front: the Sobel below reads nine neighbours per pixel,
  // and recomputing the weighted sum inside that loop is nine times the work.
  const h = new Float32Array(SIZE * SIZE);
  for (let i = 0, p = 0; i < s.length; i += 4, p++) {
    h[p] = (s[i] * 0.299 + s[i + 1] * 0.587 + s[i + 2] * 0.114) / 255;
  }

  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(SIZE, SIZE);
  const d = img.data;
  const at = (x, y) => h[(((y % SIZE) + SIZE) % SIZE) * SIZE + (((x % SIZE) + SIZE) % SIZE)];

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);

      // Canvas rows run downward but a CanvasTexture is uploaded with flipY, so
      // +v runs *up* the canvas: dh/dv is -gy, and the two sign flips (surface
      // normal is the negated gradient, then the v axis) cancel on green.
      let nx = -gx * strength, ny = gy * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;

      const i = (y * SIZE + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  CACHE.set(key, canvas);
  return canvas;
}

export function disposePatternCache() { CACHE.clear(); }
