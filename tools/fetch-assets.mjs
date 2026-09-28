// Pull every asset named in assets/manifest.json into the tree, and write the
// attribution rows that CC-BY obliges us to ship.
//
// Two halves, because the sources behave differently:
//
//   Poly Haven is open. Its API hands back a direct URL per file plus an
//   `include` map naming the sibling textures a glTF references, so a model is
//   one request for the manifest and one per file. Everything from here is CC0,
//   which is why it can be committed to the repo without a second thought.
//
//   Sketchfab requires an account. `GET /v3/models/<uid>/download` is a 401
//   without a token, so the guns, the characters and the military kit cannot be
//   fetched unattended. Run with SKETCHFAB_TOKEN set (Settings -> Password &
//   API on sketchfab.com) and they land in the same tree under the same rules.
//
// The game does not depend on any of this having run. Every consumer of these
// files treats a missing asset as "use the procedural version", so a fresh
// clone with an empty assets/ tree plays exactly as it did before. That is
// deliberate: an art pipeline that can break the game when a CDN is slow is a
// worse trade than one that quietly looks older.
//
//   node tools/fetch-assets.mjs                 # open assets only
//   SKETCHFAB_TOKEN=... node tools/fetch-assets.mjs --sketchfab
//   node tools/fetch-assets.mjs --only=terrain,env
//   node tools/fetch-assets.mjs --force         # re-download what is present

import { readFile, writeFile, mkdir, stat, rm, copyFile, rename } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'assets', 'manifest.json');
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

/** Where each manifest section lands, and which fetcher handles it. */
const SECTIONS = {
  audio:       { dir: 'assets/audio' },
  terrain:     { dir: 'assets/textures' },
  surfaces:    { dir: 'assets/textures' },
  photos:      { dir: 'assets/textures' },
  creatures:   { dir: 'assets/creatures' },
  env:         { dir: 'assets/env' },
  props:       { dir: 'assets/models' },
  weapons:     { dir: 'assets/weapons' },
  hands:       { dir: 'assets/weapons' },
  attachments: { dir: 'assets/weapons' },
  characters:  { dir: 'assets/characters' },
  kit:         { dir: 'assets/kit' },
  vehicles:    { dir: 'assets/kit' },
};

export function parseAssetArgs(args) {
  const allowed = new Set(['--force', '--sketchfab']);
  const unknown = args.filter((arg) => !allowed.has(arg) && !arg.startsWith('--only='));
  if (unknown.length) throw new Error(`unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  const onlyArgs = args.filter((arg) => arg.startsWith('--only='));
  if (onlyArgs.length > 1) throw new Error('--only may be specified once');
  const only = onlyArgs.length ? onlyArgs[0].slice(7).split(',').filter(Boolean) : [];
  if (onlyArgs.length && !only.length) throw new Error('--only needs at least one section');
  const invalid = only.filter((section) => !Object.hasOwn(SECTIONS, section));
  if (invalid.length) throw new Error(`unknown asset section${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`);
  return {
    force: args.includes('--force'),
    wantSketchfab: args.includes('--sketchfab'),
    only: [...new Set(only)],
  };
}

const parsedArgs = parseAssetArgs(invokedDirectly ? process.argv.slice(2) : []);
const FORCE = parsedArgs.force;
const WANT_SKETCHFAB = parsedArgs.wantSketchfab;
const ONLY = parsedArgs.only;

/**
 * Poly Haven's key for a map, in the order we prefer.
 *
 * The names are not stable across asset types -- a model calls its colour map
 * `Diffuse` while some textures use `Color` -- so every map is a list of
 * candidates and the first one present wins. `arm` is the useful one: Poly
 * Haven packs ambient occlusion, roughness and metalness into R, G and B, which
 * is exactly the channel order three.js samples aoMap, roughnessMap and
 * metalnessMap from. One file, three maps, no shader work.
 */
const MAPS = {
  diff: ['Diffuse', 'Color', 'diff', 'col'],
  nor:  ['nor_gl', 'nor', 'Normal'],
  arm:  ['arm', 'ARM'],
  disp: ['Displacement', 'disp', 'Height', 'height'],
  rough: ['Rough', 'rough', 'Roughness'],
  ao:   ['AO', 'ao'],
};

const log = (...a) => console.log(...a);
let fetched = 0, skipped = 0, failed = 0;

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function temporarySibling(dest) {
  const ext = path.extname(dest);
  const stem = ext ? dest.slice(0, -ext.length) : dest;
  return `${stem}.part-${process.pid}-${randomUUID()}${ext}`;
}

async function replaceDirectory(prepared, dest) {
  const backup = `${dest}.previous-${process.pid}-${randomUUID()}`;
  const hadPrevious = await exists(dest);
  if (hadPrevious) await rename(dest, backup);
  try {
    await rename(prepared, dest);
  } catch (err) {
    if (hadPrevious) await rename(backup, dest);
    throw err;
  }
  if (hadPrevious) await rm(backup, { recursive: true, force: true });
}

/** Resolve a manifest-provided path without allowing it to leave its asset root. */
export function resolveInside(base, ...parts) {
  const root = path.resolve(base);
  const target = path.resolve(root, ...parts);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`asset path escapes its output directory: ${parts.join('/')}`);
  }
  return target;
}

export function assertSafeArchiveEntries(entries) {
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/');
    const parts = normalized.split('/');
    if (normalized.includes('\0') || normalized.startsWith('/')
        || /^[a-z]:\//i.test(normalized) || parts.includes('..')) {
      throw new Error(`archive entry escapes its extraction directory: ${entry}`);
    }
  }
}

async function inspectArchive(archive) {
  const options = { maxBuffer: 16 * 1024 * 1024 };
  const { stdout } = await exec('bsdtar', ['-tf', archive], options);
  assertSafeArchiveEntries(stdout.split(/\r?\n/).filter(Boolean));
  const { stdout: verbose } = await exec('bsdtar', ['-tvf', archive], options);
  if (verbose.split(/\r?\n/).some((line) => /^[lh]/.test(line))) {
    throw new Error('archive contains a symbolic or hard link');
  }
}

/** Download beside the destination, then atomically replace it only on success. */
export async function download(url, dest, { force = FORCE, fetchImpl = fetch } = {}) {
  if (!force && await exists(dest)) { skipped++; return true; }
  await mkdir(path.dirname(dest), { recursive: true });
  const temporary = temporarySibling(dest);
  try {
    const res = await fetchImpl(url, { headers: { 'user-agent': 'upvote-uprising-asset-fetch' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('response had no body');
    await pipeline(res.body, createWriteStream(temporary, { flags: 'wx' }));
    await rename(temporary, dest);
    fetched++;
    return true;
  } catch (err) {
    // A half-written file is worse than none. Keep it beside the destination
    // until the transfer succeeds so --force cannot erase a known-good copy.
    await rm(temporary, { force: true });
    log(`    ! ${path.basename(dest)}: ${err.message}`);
    failed++;
    return false;
  }
}

const phCache = new Map();
async function phFiles(slug) {
  if (!phCache.has(slug)) {
    const res = await fetch(`https://api.polyhaven.com/files/${slug}`);
    if (!res.ok) throw new Error(`polyhaven ${slug}: HTTP ${res.status}`);
    phCache.set(slug, await res.json());
  }
  return phCache.get(slug);
}

/** First present candidate key, at the requested resolution. */
export function pickMap(files, names, res) {
  for (const n of names) {
    const node = files[n]?.[res];
    if (!node) continue;
    const file = node.jpg || node.png || Object.values(node)[0];
    if (file?.url) return file.url;
  }
  return null;
}

async function fetchPolyhavenTexture(entry, outDir) {
  const files = await phFiles(entry.slug);
  const res = entry.res || '1k';
  const dir = resolveInside(path.join(ROOT, outDir), entry.slug);
  const got = [];
  for (const [kind, names] of Object.entries(MAPS)) {
    const url = pickMap(files, names, res);
    if (!url) continue;
    const ext = path.extname(new URL(url).pathname) || '.jpg';
    if (await download(url, path.join(dir, `${kind}${ext}`))) got.push(kind);
  }
  if (!got.includes('diff')) throw new Error(`${entry.slug}: no colour map at ${res}`);
  return { path: path.relative(ROOT, dir), maps: got };
}

async function fetchPolyhavenHdri(entry, outDir) {
  const files = await phFiles(entry.slug);
  const res = entry.res || '1k';
  const url = files.hdri?.[res]?.hdr?.url;
  if (!url) throw new Error(`${entry.slug}: no ${res} hdr`);
  const dest = resolveInside(path.join(ROOT, outDir), `${entry.slug}.hdr`);
  if (!await download(url, dest)) throw new Error('HDR download failed');
  return { path: path.relative(ROOT, dest) };
}

async function fetchPolyhavenModel(entry, outDir) {
  const files = await phFiles(entry.slug);
  const res = entry.res || '1k';
  const node = files.gltf?.[res]?.gltf;
  if (!node?.url) throw new Error(`${entry.slug}: no ${res} gltf`);
  const dir = resolveInside(path.join(ROOT, outDir), entry.slug);
  if (!await download(node.url, path.join(dir, 'scene.gltf'))) {
    throw new Error('model download failed');
  }
  // The glTF references these by relative path, so they must keep their names.
  for (const [rel, file] of Object.entries(node.include || {})) {
    if (!file?.url) throw new Error(`${entry.slug}: included file ${rel} has no URL`);
    if (!await download(file.url, resolveInside(dir, rel))) {
      throw new Error(`${entry.slug}: included file ${rel} failed`);
    }
  }
  return { path: path.relative(ROOT, path.join(dir, 'scene.gltf')) };
}

/**
 * Fetch a single openly hosted file.
 *
 * Most of the art pipeline talks to source APIs or unpacks archives. A small
 * number of assets -- currently the photographed food card on the nugget
 * dispenser -- are already published as a stable, redistribution-safe file.
 * Keeping that case in the manifest makes the shipped copy reproducible and
 * keeps its credit in the same generated ledger as every model and texture.
 */
async function fetchDirect(entry, outDir) {
  if (!entry.url || !entry.path) throw new Error('direct asset needs url and path');
  const dest = resolveInside(path.join(ROOT, outDir), entry.path);
  const stagedDest = entry.encoding && (FORCE || !await exists(dest)) ? temporarySibling(dest) : dest;
  const localSource = entry.url.startsWith('local:')
    ? resolveInside(ROOT, entry.url.slice('local:'.length))
    : null;
  const transfer = async target => {
    if (!localSource) return download(entry.url, target, { force: true });
    if (path.resolve(localSource) === path.resolve(target)) return true;
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(localSource, target);
    return true;
  };
  if (!entry.encoding) {
    if (!await transfer(dest)) throw new Error('asset copy/download failed');
  } else if (stagedDest !== dest) {
    if (!await transfer(stagedDest)) throw new Error('asset copy/download failed');
  }
  if (entry.encoding === 'p3d') {
    // p3d.in's viewer payload is byte-for-byte a GLB except for its four-byte
    // magic. The CC0 banana was uploaded there by its author as the public 3D
    // preview for the OpenGameArt source; restoring the standard glTF magic is
    // a lossless container conversion and keeps the browser from needing a
    // site-specific runtime parser.
    const bytes = await readFile(stagedDest);
    const magic = bytes.toString('ascii', 0, 4);
    if (bytes.length < 20 || !['P3D ', 'glTF'].includes(magic) || bytes.readUInt32LE(4) !== 2) {
      await rm(stagedDest, { force: true });
      throw new Error('download was not a P3D v2/GLB-compatible payload');
    }
    if (magic === 'P3D ') {
      bytes.write('glTF', 0, 4, 'ascii');
      await writeFile(stagedDest, bytes);
    }
  }
  if (stagedDest !== dest) await rename(stagedDest, dest);
  return { path: path.relative(ROOT, dest) };
}

/**
 * Extract and master a compact browser set from a large openly licensed archive.
 *
 * Firearm libraries are distributed as multigigabyte-quality WAV collections;
 * shipping those originals in a browser game would be wasteful. The manifest
 * keeps every source filename and edit boundary, so the small MP3 reports in
 * assets/audio remain reproducible rather than becoming anonymous hand edits.
 */
async function fetchAudioArchive(entry, outDir) {
  if (!entry.url || !entry.id || !entry.path || !Array.isArray(entry.clips) || !entry.clips.length) {
    throw new Error('audio archive needs url, id, path and clips');
  }
  const dir = resolveInside(path.join(ROOT, outDir), entry.path);
  const outputs = entry.clips.map((clip) => resolveInside(dir, clip.path));
  if (!FORCE && (await Promise.all(outputs.map(exists))).every(Boolean)) {
    skipped += outputs.length;
    return { path: path.relative(ROOT, dir) };
  }

  const tmp = path.join(ROOT, 'assets', '.tmp');
  const stage = resolveInside(tmp, `${entry.id}-audio`);
  const ext = path.extname(new URL(entry.url).pathname) || '.archive';
  const archive = resolveInside(tmp, `${entry.id}${ext}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  if (!await download(entry.url, archive)) throw new Error('archive download failed');
  await inspectArchive(archive);
  await exec('bsdtar', ['-xf', archive, '-C', stage, ...entry.clips.map((clip) => clip.pick)]);
  await mkdir(dir, { recursive: true });

  for (const clip of entry.clips) {
    const source = resolveInside(stage, clip.pick);
    const dest = resolveInside(dir, clip.path);
    const temporary = temporarySibling(dest);
    await mkdir(path.dirname(dest), { recursive: true });
    try {
      if (!clip.start && !clip.duration && path.extname(source) === path.extname(dest)) {
        await copyFile(source, temporary);
      } else {
        const args = ['-hide_banner', '-loglevel', 'error', '-y'];
        if (clip.start !== undefined) args.push('-ss', String(clip.start));
        args.push('-i', source);
        if (clip.duration !== undefined) args.push('-t', String(clip.duration));
        const filters = ['highpass=f=32', 'alimiter=limit=0.93:level=false'];
        if (clip.duration && clip.duration > 0.12) {
          filters.push(`afade=t=out:st=${Math.max(0, clip.duration - 0.08).toFixed(3)}:d=0.08`);
        }
        args.push('-af', filters.join(','), '-ac', '1', '-ar', '48000', '-b:a', '96k', temporary);
        await exec('ffmpeg', args);
      }
      await rename(temporary, dest);
    } catch (err) {
      await rm(temporary, { force: true });
      throw err;
    }
  }

  await rm(stage, { recursive: true, force: true });
  await rm(archive, { force: true });
  fetched += outputs.length;
  return { path: path.relative(ROOT, dir) };
}

/** Parse one numeric array from the deliberately simple ASCII FBX 6.x syntax. */
function fbxNumbersBetween(source, label, nextLabel) {
  const start = source.indexOf(label);
  const end = source.indexOf(nextLabel, start + label.length);
  if (start < 0 || end < 0) throw new Error(`legacy FBX is missing ${label.trim()}`);
  return [...source.slice(start + label.length, end)
    .matchAll(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)].map((m) => Number(m[0]));
}

/**
 * Convert the static mesh subset used by Blender's old ASCII FBX exporter.
 *
 * Three.js intentionally rejects FBX versions below 7, while the TinyWorlds
 * photogrammetry archive predates that format. This converter keeps the exact
 * positions, polygon-corner normals and indexed UVs and writes a universally
 * supported OBJ. The game applies the supplied PBR maps itself, avoiding the
 * browser loader's fire-and-forget MTL texture path. It is narrow on purpose:
 * if a future archive contains
 * animation or a different mapping mode, these validations fail instead of
 * silently producing a mangled model.
 */
export async function convertAsciiFbxToObj(sourcePath, outputPath) {
  const source = await readFile(sourcePath, 'utf8');
  if (!/^; FBX 6\.[^\n]*project file/m.test(source)) {
    throw new Error('ascii-fbx-obj conversion expects a Blender FBX 6.x text export');
  }
  if (!source.includes('MappingInformationType: "ByPolygonVertex"')
      || !source.includes('ReferenceInformationType: "IndexToDirect"')) {
    throw new Error('legacy FBX uses an unsupported normal or UV mapping mode');
  }

  const vertices = fbxNumbersBetween(source, '\n\t\tVertices:', '\n\t\tPolygonVertexIndex:');
  const corners = fbxNumbersBetween(source, '\n\t\tPolygonVertexIndex:', '\n\t\tGeometryVersion:');
  const normals = fbxNumbersBetween(source, '\n\t\t\tNormals:', '\n\t\t}\n\t\tLayerElementSmoothing:');
  const uvs = fbxNumbersBetween(source, '\n\t\t\tUV:', '\n\t\t\tUVIndex:');
  const uvIndices = fbxNumbersBetween(source, '\n\t\t\tUVIndex:', '\n\t\t}\n\t\tLayerElementTexture:');
  if (vertices.length % 3 || normals.length !== corners.length * 3
      || uvs.length % 2 || uvIndices.length !== corners.length) {
    throw new Error('legacy FBX mesh arrays are inconsistent');
  }

  const lines = [`# Derived from ${path.basename(sourcePath)} by tools/fetch-assets.mjs`,
    'o Inevitable_Snail_Shell'];
  for (let i = 0; i < vertices.length; i += 3) {
    lines.push(`v ${vertices[i]} ${vertices[i + 1]} ${vertices[i + 2]}`);
  }
  for (let i = 0; i < uvs.length; i += 2) lines.push(`vt ${uvs[i]} ${uvs[i + 1]}`);
  for (let i = 0; i < normals.length; i += 3) {
    lines.push(`vn ${normals[i]} ${normals[i + 1]} ${normals[i + 2]}`);
  }

  let face = [];
  for (let i = 0; i < corners.length; i++) {
    const encoded = corners[i];
    const vertex = encoded < 0 ? -encoded : encoded + 1;
    face.push(`${vertex}/${uvIndices[i] + 1}/${i + 1}`);
    if (encoded < 0) {
      if (face.length < 3) throw new Error('legacy FBX contains a degenerate polygon');
      lines.push(`f ${face.join(' ')}`);
      face = [];
    }
  }
  if (face.length) throw new Error('legacy FBX ends inside a polygon');

  await writeFile(outputPath, `${lines.join('\n')}\n`);
  await rm(path.join(path.dirname(outputPath),
    `${path.basename(outputPath, path.extname(outputPath))}.mtl`), { force: true });
}

/**
 * Pull one model out of an OpenGameArt archive.
 *
 * OpenGameArt serves files directly with no account, which is the whole reason
 * these entries exist -- they are the guns and the kit that can be installed
 * unattended. The cost is that everything arrives as a zip of somebody's working
 * directory: three formats, a .blend, a preview render, and textures in a folder
 * called whatever they felt like.
 *
 * So the manifest names the one file to use (`pick`), and this flattens that
 * file and every texture beside it into one directory. Flattening is what makes
 * the sibling references resolve: an .obj names its .mtl and an .mtl names its
 * textures by bare filename, so they have to end up in the same folder no matter
 * how the author nested them.
 */
export function selectOgaFiles(entry, staged) {
  const wanted = path.posix.basename(entry.pick.replaceAll('\\', '/'));
  const selectedModels = new Set([
    wanted,
    ...(entry.clips || []).map((name) => path.posix.basename(name.replaceAll('\\', '/'))),
  ]);
  const sidecar = /\.(mtl|bin|png|jpg|jpeg|tga)$/i;
  const model = /\.(obj|fbx|gltf|glb)$/i;
  return staged.filter((name) => selectedModels.has(name)
    || sidecar.test(name) || (entry.includeModels && model.test(name)));
}

async function fetchOga(entry, outDir) {
  const dir = resolveInside(path.join(ROOT, outDir), entry.id);
  const wanted = path.posix.basename(entry.pick.replaceAll('\\', '/'));
  const marker = resolveInside(dir, entry.convertedPath || wanted);
  if (!FORCE && await exists(marker)) { skipped++; return { path: path.relative(ROOT, marker) }; }

  const archiveExt = /\.7z$/i.test(new URL(entry.url).pathname) ? '.7z' : '.zip';
  const archiveKey = createHash('sha256').update(entry.url).digest('hex').slice(0, 16);
  const zip = path.join(ROOT, 'assets', '.tmp', `oga-${archiveKey}${archiveExt}`);
  // One archive often provides several slots. Keep it until main's final .tmp
  // cleanup so a fresh install does not download the same pack twelve times.
  if (!await download(entry.url, zip, { force: false })) throw new Error('archive download failed');
  await inspectArchive(zip);

  const stage = resolveInside(path.join(ROOT, 'assets', '.tmp'), entry.id);
  const prepared = resolveInside(path.join(ROOT, 'assets', '.tmp'), `prepared-${entry.id}-${randomUUID()}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  if (archiveExt === '.7z') {
    // bsdtar, which is what `tar` is on macOS and most BSDs, reads 7-Zip through
    // libarchive. Using it avoids making p7zip a prerequisite for one archive --
    // and the best free zombie on OpenGameArt happens to ship as a .7z.
    await exec('tar', ['-xf', zip, '-C', stage]);
    // tar keeps the archive's directory structure; the loaders need siblings in
    // one folder, so flatten what came out.
    const { readdir: rd, rename } = await import('node:fs/promises');
    const walk = async (dir) => {
      for (const name of await rd(dir)) {
        const full = path.join(dir, name);
        const st = await stat(full);
        if (st.isDirectory()) { await walk(full); continue; }
        if (dir !== stage) await rename(full, path.join(stage, name)).catch(() => {});
      }
    };
    await walk(stage);
  } else {
    await exec('unzip', ['-o', '-q', '-j', zip, '-d', stage]);   // -j: flatten
  }

  const { readdir, copyFile } = await import('node:fs/promises');
  const staged = await readdir(stage);
  if (!staged.includes(wanted)) {
    await rm(stage, { recursive: true, force: true });
    throw new Error(`"${wanted}" not in the archive (found: ${staged.slice(0, 5).join(', ')})`);
  }

  await mkdir(prepared, { recursive: true });
  // The model, its material file, and the textures. Not the .blend or the
  // preview render: those are somebody's source, and shipping them would put
  // tens of megabytes of things the game cannot read into the tree.
  for (const name of selectOgaFiles(entry, staged)) {
    await copyFile(path.join(stage, name), path.join(prepared, name));
  }
  const preparedMarker = resolveInside(prepared, entry.convertedPath || wanted);
  if (entry.conversion === 'ascii-fbx-obj') {
    await convertAsciiFbxToObj(path.join(prepared, wanted), preparedMarker);
  }
  if (!await exists(preparedMarker)) throw new Error(`prepared asset is missing ${path.basename(marker)}`);
  await mkdir(path.dirname(dir), { recursive: true });
  await replaceDirectory(prepared, dir);
  await rm(stage, { recursive: true, force: true });
  return { path: path.relative(ROOT, marker) };
}

async function fetchSketchfab(entry, outDir, token) {
  const dir = resolveInside(path.join(ROOT, outDir), entry.uid);
  const marker = path.join(dir, 'scene.gltf');
  if (!FORCE && await exists(marker)) { skipped++; return { path: path.relative(ROOT, marker) }; }

  const res = await fetch(`https://api.sketchfab.com/v3/models/${entry.uid}/download`, {
    headers: { Authorization: `Token ${token}` },
  });
  if (res.status === 401) throw new Error('token rejected (401) -- check SKETCHFAB_TOKEN');
  if (res.status === 403) throw new Error('403 -- this model is not downloadable by your account');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const links = await res.json();
  const url = links.gltf?.url || links.glb?.url;
  if (!url) throw new Error('no glTF download offered');

  const zip = path.join(ROOT, 'assets', '.tmp', `${entry.uid}.zip`);
  if (!await download(url, zip)) throw new Error('archive download failed');
  await inspectArchive(zip);
  const prepared = resolveInside(path.join(ROOT, 'assets', '.tmp'), `prepared-${entry.uid}-${randomUUID()}`);
  await mkdir(prepared, { recursive: true });
  await exec('unzip', ['-o', '-q', zip, '-d', prepared]);
  await rm(zip, { force: true });
  if (!await exists(path.join(prepared, 'scene.gltf'))) {
    throw new Error('download archive did not contain scene.gltf');
  }
  await mkdir(path.dirname(dir), { recursive: true });
  await replaceDirectory(prepared, dir);
  return { path: path.relative(ROOT, marker) };
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const token = process.env.SKETCHFAB_TOKEN;
  if (WANT_SKETCHFAB && !token) {
    throw new Error('--sketchfab requires SKETCHFAB_TOKEN');
  }
  const credits = [];
  const pending = [];
  const retiredPaths = new Set();

  for (const [section, cfg] of Object.entries(SECTIONS)) {
    const entries = manifest[section];
    if (!Array.isArray(entries)) continue;
    if (ONLY.length && !ONLY.includes(section)) continue;

    log(`\n== ${section} (${entries.length})`);
    for (const entry of entries) {
      const label = entry.slug || entry.id || entry.title;
      for (const retired of entry.replaces || []) retiredPaths.add(retired);
      if (entry.source === 'sketchfab' && (!WANT_SKETCHFAB || !token)) {
        pending.push({ section, ...entry });
        continue;
      }
      try {
        let out;
        if (entry.source === 'polyhaven') {
          out = entry.kind === 'hdri' ? await fetchPolyhavenHdri(entry, cfg.dir)
              : entry.kind === 'model' ? await fetchPolyhavenModel(entry, cfg.dir)
              : await fetchPolyhavenTexture(entry, cfg.dir);
        } else if (entry.source === 'oga') {
          out = await fetchOga(entry, cfg.dir);
        } else if (entry.source === 'sketchfab') {
          out = await fetchSketchfab(entry, cfg.dir, token);
        } else if (entry.source === 'direct') {
          out = await fetchDirect(entry, cfg.dir);
        } else if (entry.source === 'audio-archive') {
          out = await fetchAudioArchive(entry, cfg.dir);
        } else {
          throw new Error(`unknown source "${entry.source}"`);
        }
        credits.push({
          section,
          title: entry.title || label,
          author: entry.author,
          license: entry.license,
          page: entry.page,
          path: out.path,
          modified: entry.modified
            ?? (entry.license === 'CC-BY' ? 'scaled and re-materialled for the game' : undefined),
        });
        log(`  + ${label}`);
      } catch (err) {
        failed++;
        log(`  ! ${label}: ${err.message}`);
      }
    }
  }

  await rm(path.join(ROOT, 'assets', '.tmp'), { recursive: true, force: true });

  // Merge rather than overwrite: a run with --only must not drop the rows for
  // everything it did not touch.
  const creditsPath = path.join(ROOT, 'assets', 'CREDITS.json');
  let existing = [];
  if (await exists(creditsPath)) {
    try { existing = JSON.parse(await readFile(creditsPath, 'utf8')); } catch { existing = []; }
  }
  const merged = [...existing.filter((e) => !retiredPaths.has(e.path)
    && !credits.some((c) => c.path === e.path
    || (c.section === e.section && c.title === e.title && c.page === e.page))), ...credits]
    .sort((a, b) => (a.section + a.title).localeCompare(b.section + b.title));
  await writeFile(creditsPath, JSON.stringify(merged, null, 2) + '\n');
  await writeFile(path.join(ROOT, 'ATTRIBUTIONS.md'), renderAttributions(merged));

  log(`\n${fetched} downloaded, ${skipped} already present, ${failed} failed.`);
  log(`${merged.length} attribution rows -> assets/CREDITS.json, ATTRIBUTIONS.md`);
  if (pending.length) {
    log(`\n${pending.length} assets need a Sketchfab account:`);
    log('  1. sign in at sketchfab.com (free)');
    log('  2. copy your token from sketchfab.com/settings/password');
    log('  3. SKETCHFAB_TOKEN=<token> node tools/fetch-assets.mjs --sketchfab');
    const bySection = {};
    for (const p of pending) (bySection[p.section] ||= []).push(p.title);
    for (const [s, list] of Object.entries(bySection)) log(`     ${s}: ${list.length}`);
  }
  if (failed) process.exitCode = 1;
}

export function renderAttributions(rows) {
  const byLicense = { 'CC-BY': [], CC0: [] };
  for (const r of rows) (byLicense[r.license] ||= []).push(r);
  const lines = [
    '# Attributions',
    '',
    'Third-party art shipped with Upvote Uprising. Generated by `tools/fetch-assets.mjs`;',
    'do not edit by hand. The in-game list is the same data, read from',
    '`assets/CREDITS.json` by `src/ui/credits.js`.',
    '',
  ];
  if (byLicense['CC-BY'].length) {
    lines.push('## CC BY 4.0 — attribution required', '');
    lines.push('Licence: <https://creativecommons.org/licenses/by/4.0/>', '');
    for (const r of byLicense['CC-BY']) {
      lines.push(`- **${r.title}** by ${r.author} — <${r.page}>`);
      lines.push(`  CC BY 4.0${r.modified ? ` — ${r.modified}` : ''}`);
    }
    lines.push('');
  }
  if (byLicense.CC0.length) {
    lines.push('## CC0 — public domain, credited anyway', '');
    for (const r of byLicense.CC0) {
      lines.push(`- **${r.title}** by ${r.author} — <${r.page}>`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// Only fetch when run as a script. The pure helpers above are imported by
// test/assets.test.mjs, and importing a module must never start downloading
// the art bundle as a side effect.
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
