// Prop rendering: trees, rocks, ruins, crates, and the ground scatter.
//
// Every prop type is a handful of InstancedMeshes, so a thousand trees cost a
// few draw calls instead of a thousand. All placement is deterministic from
// the prop data and the world seed, so every client in a co-op room sees the
// identical forest.
//
// What "realistic" means at this art level
// ----------------------------------------
// Four things carry it, and they divide by surface type:
//
//   texture      hard surfaces are textured out of texturelab.js -- bark on the
//                trunks, weathered concrete on the ruins, sawn plank on the
//                crates, pitted stone on the rock -- each with a packed
//                normal/roughness/AO map. This is what separates a weathered
//                surface from a tinted one, and it is the single biggest step
//                away from "coloured geometry".
//   silhouette   nothing organic is round. Canopies are ragged unions of
//                perturbed blobs, rock is faceted, walls are broken along the
//                top edge. The perfect sphere is what reads as a lollipop.
//   palette      nature is desaturated. The greens here are olive and sage,
//                matched to the terrain, with species variation -- a bright
//                saturated green is the single fastest way back to toytown.
//   density      a real field is not empty. Near-field ground cover comes from
//                clutter.js (streamed, wind-animated, alpha-cut cards); the
//                static scatter here adds the stones and bushes that sit
//                outside that ring.
//
// Foliage is alpha-cut cards, not tinted volumes. The earlier pass here built
// crowns from flat-shaded icosahedra and cones on the theory that faceted solids
// read better than a leaf texture stretched over a blob -- and the blob part was
// right, but the conclusion was not. A solid crown has a closed silhouette, and
// a closed silhouette is the single strongest "this is geometry" tell there is:
// no amount of facet shading stops a green icosahedron looking like a green
// icosahedron. Cards cut against a leaf mask break the outline, let sky through
// the canopy edge, and cost *fewer* triangles than the solids they replaced.
//
// The proof was already in the frame: the grass from clutter.js, alpha-cut cards
// out of the same pipeline, read as more natural than any canopy above it.
//
// Per-tree tint survives the change -- it moved from the lobe instance colour to
// the card instance colour, multiplied by a per-card term for crown depth, so a
// hillside is still a population rather than copies.
//
// Two UV strategies, because instancing rules out one of them on its own:
//
//   geometry UV  trunks and branches, where the grain has to run *along* the
//                cylinder. A lathe/cylinder already carries the right UVs.
//   triplanar    rocks, ruins, crates. These are unit geometries scaled
//                per-instance, so geometry UVs would stretch by the instance
//                scale -- a long wall would smear. Projecting from position
//                instead gives constant texel density at any scale, and for
//                world-space projection it also means no two rocks sample the
//                same patch of texture.
//
// The visual meshes are intentionally a little larger than the colliders in
// world.js: foliage does not block shots, so a canopy that looks generous while
// only the trunk is solid reads as forgiving rather than buggy.

import * as THREE from '../../vendor/three.module.js';
import {
  PROP_TREE, PROP_ROCK, PROP_RUIN, PROP_CRATE, PROP_WALL, PROP_ROOF,
} from '../world/world.js';
import { BIOME_GRASS, CELL, N } from '../world/heightfield.js';
import { rand2 } from '../world/noise.js';
import {
  barkTextures, concreteTextures, plankTextures, rockTextures,
  leafCard, needleCard,
  SQRT_MAP_FRAGMENT, SURFACE_PARS, SURFACE_ROUGH, SURFACE_NORMAL, SURFACE_AO,
} from './texturelab.js';
import { foliageMaterial } from './clutter.js';
import { onFrame } from './framehooks.js';
import { getAtmosphereUniforms, ATMOSPHERE_PARS, AERIAL_FOG_FRAGMENT } from './sky.js';

const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// Scratch for the foliage card orientation maths, which runs a few thousand
// times per world build and has no business allocating.
const UNIT_Y = new THREE.Vector3(0, 1, 0);
const UNIT_Z = new THREE.Vector3(0, 0, 1);
const TMP_D = new THREE.Vector3();
const TMP_Q = new THREE.Quaternion();
const TMP_Q2 = new THREE.Quaternion();

// ------------------------------------------------------------------ materials

// World position of the fragment. Instancing has to be folded in by hand:
// three applies instanceMatrix in <project_vertex>, which runs after the hook
// below, so `transformed` is still in object space here.
const WPOS_VERTEX = /* glsl */`
  vec4 wpTmp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wpTmp = instanceMatrix * wpTmp;
  #endif
  vWPos = (modelMatrix * wpTmp).xyz;
`;

/**
 * Shared plumbing for every textured prop material: the atmosphere uniforms, a
 * world-position varying, and aerial-perspective fog in place of linear fog.
 *
 * vWPos is not optional. AERIAL_FOG_FRAGMENT fades a fragment toward the sky
 * radiance along its own view ray, which it looks up from vWPos -- so a
 * material that swaps the fog in without declaring it does not compile. That is
 * a link-time failure in a chunk nobody edited, reported against a line number
 * inside three's fog code, which is a miserable thing to debug; declaring it
 * here means no caller can forget.
 */
function atmosphericMaterial(mat, opts, patch) {
  const atm = getAtmosphereUniforms();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.tSkyR = atm.tSkyR;
    shader.uniforms.tSkyM = atm.tSkyM;
    shader.uniforms.tSunT = atm.tSunT;
    shader.uniforms.uSunDir = atm.uSunDir;
    shader.uniforms.uSkyGain = atm.uSkyGain;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>\nvarying vec3 vWPos;\n${opts.vertPars ?? ''}`)
      // <begin_vertex> defines `transformed`, and <beginnormal_vertex> has
      // already defined `objectNormal` by this point, so both are in scope.
      .replace('#include <begin_vertex>',
        `#include <begin_vertex>\n${WPOS_VERTEX}\n${opts.vertBody ?? ''}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>\nvarying vec3 vWPos;\n${opts.fragPars ?? ''}\n${ATMOSPHERE_PARS}`);

    patch(shader);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_fragment>', AERIAL_FOG_FRAGMENT);
  };
  // Every variant below patches the shader differently, so each needs its own
  // program cache entry or three would hand back the first one compiled.
  mat.customProgramCacheKey = () => `prop-${opts.key}`;
  return mat;
}

/**
 * A textured surface driven by the geometry's own UVs.
 *
 * Albedo is sqrt(linear) and the "normal map" is really the packed
 * normal/roughness/AO map, so both need reinterpreting -- hence the chunk
 * swaps rather than a plain material. Binding it as `normalMap` is what gets
 * three to build the tangent frame and UV varying for us.
 */
function surfaceMaterial(tex, opts = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: srgb(opts.color ?? 0xffffff),
    map: tex.albedo,
    normalMap: tex.surface,
    normalScale: new THREE.Vector2(opts.bump ?? 1, opts.bump ?? 1),
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? 0,
    vertexColors: !!opts.vertexColors,
    dithering: true,
  });

  return atmosphericMaterial(mat, { key: opts.key, fragPars: SURFACE_PARS }, (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', `${SQRT_MAP_FRAGMENT}\n${opts.frag ?? ''}`)
      .replace('#include <roughnessmap_fragment>', SURFACE_ROUGH)
      .replace('#include <normal_fragment_maps>', SURFACE_NORMAL)
      .replace('#include <aomap_fragment>', SURFACE_AO);
  });
}

// Dirt washed up the bottom of a trunk. The trunk UVs run v = 0 at the base, so
// the gradient is free -- and a trunk that darkens where it meets the ground is
// most of what stops it reading as a cylinder standing on a lawn.
const TRUNK_FRAG = /* glsl */`
  float footing = smoothstep(0.28, 0.0, vMapUv.y);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.60, 0.56, 0.48), footing);
`;

// Triplanar projection. No `map`/`normalMap` is bound at all: the textures come
// in as plain uniforms, which is what lets this run on geometry carrying no UV
// attribute and skip three's tangent-frame setup entirely. The normal is built
// the same way the terrain builds its rock normal -- perturb the geometric
// normal per projection axis and blend -- rather than through a TBN that a
// projected UV cannot supply.
const TRIPLANAR_VARYINGS = /* glsl */`
  varying vec3 vTPos;
  varying vec3 vTNormal;
`;

const TRIPLANAR_FRAG_PARS = /* glsl */`
  uniform sampler2D tAlb;
  uniform sampler2D tSrf;
  uniform float uTScale;
  float gTRough;
  float gTAO;
  vec3 gTNormal;
`;

// World space reuses the world position the atmosphere already needs, and only
// the normal has to be walked through the instance transform.
const TRIPLANAR_VERTEX_WORLD = /* glsl */`
  vTPos = vWPos;
  vec3 tnTmp = objectNormal;
  #ifdef USE_INSTANCING
    tnTmp = mat3(instanceMatrix) * tnTmp;
  #endif
  vTNormal = normalize(mat3(modelMatrix) * tnTmp);
`;

// Object space is pre-instance by definition, so there is nothing to fold in.
const TRIPLANAR_VERTEX_OBJECT = /* glsl */`
  vTPos = transformed;
  vTNormal = normalize(objectNormal);
`;

const TRIPLANAR_FRAG = /* glsl */`
  vec3 tN = normalize(vTNormal);
  // Fourth power, so the dominant axis wins decisively; a soft blend triple-
  // samples everywhere and reads as a blurred smear on every face.
  vec3 bw = abs(tN); bw = bw * bw * bw * bw;
  bw /= max(bw.x + bw.y + bw.z, 1e-4);

  vec2 uvX = vTPos.zy * uTScale;
  vec2 uvY = vTPos.xz * uTScale;
  vec2 uvZ = vTPos.xy * uTScale;

  vec4 aX = texture2D(tAlb, uvX), aY = texture2D(tAlb, uvY), aZ = texture2D(tAlb, uvZ);
  vec4 sX = texture2D(tSrf, uvX), sY = texture2D(tSrf, uvY), sZ = texture2D(tSrf, uvZ);

  // Albedo is stored as sqrt(linear), so squaring decodes it.
  diffuseColor.rgb *= (aX.rgb * aX.rgb) * bw.x
                    + (aY.rgb * aY.rgb) * bw.y
                    + (aZ.rgb * aZ.rgb) * bw.z;

  gTRough = sX.z * bw.x + sY.z * bw.y + sZ.z * bw.z;
  gTAO    = sX.w * bw.x + sY.w * bw.y + sZ.w * bw.z;

  vec2 tX = sX.xy * 2.0 - 1.0;
  vec2 tY = sY.xy * 2.0 - 1.0;
  vec2 tZ = sZ.xy * 2.0 - 1.0;
  vec3 nAcc = vec3(0.0);
  nAcc += normalize(vec3(tN.x, tN.y + tX.y, tN.z + tX.x)) * bw.x;
  nAcc += normalize(vec3(tN.x + tY.x, tN.y, tN.z + tY.y)) * bw.y;
  nAcc += normalize(vec3(tN.x + tZ.x, tN.y + tZ.y, tN.z)) * bw.z;
  gTNormal = normalize(nAcc);
`;

/**
 * A textured surface projected from position rather than UV.
 *
 * @param opts.space 'world' scales and varies with placement, so no two
 *        instances repeat -- right for rock and masonry. 'object' projects
 *        before the instance transform, so the grain stays square to the
 *        object's own faces -- right for a manufactured thing like a crate.
 * @param opts.scale texture repeats per metre.
 */
function triplanarMaterial(tex, opts = {}) {
  const world = (opts.space ?? 'world') === 'world';
  const mat = new THREE.MeshStandardMaterial({
    color: srgb(opts.color ?? 0xffffff),
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? 0,
    vertexColors: !!opts.vertexColors,
    dithering: true,
  });

  const uniforms = {
    tAlb: { value: tex.albedo },
    tSrf: { value: tex.surface },
    uTScale: { value: opts.scale ?? 1 },
  };

  return atmosphericMaterial(mat, {
    key: opts.key,
    vertPars: TRIPLANAR_VARYINGS,
    vertBody: world ? TRIPLANAR_VERTEX_WORLD : TRIPLANAR_VERTEX_OBJECT,
    fragPars: `${TRIPLANAR_VARYINGS}\n${TRIPLANAR_FRAG_PARS}`,
  }, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', `${TRIPLANAR_FRAG}\n${opts.frag ?? ''}`)
      .replace('#include <roughnessmap_fragment>',
        'float roughnessFactor = clamp(roughness * (0.40 + 1.20 * gTRough), 0.05, 1.0);')
      .replace('#include <normal_fragment_maps>',
        'normal = normalize((viewMatrix * vec4(gTNormal, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', `
        reflectedLight.indirectDiffuse *= gTAO;
        reflectedLight.directDiffuse *= mix(1.0, gTAO, 0.30);
      `);
  });
}

/** Deterministic wobble, keyed off direction so shared vertices stay welded. */
function wobble(v, seed) {
  return Math.sin(v.x * 12.9 + v.y * 4.7 + v.z * 8.3 + seed * 3.1) * 0.5 + 0.5;
}

/** Randomly perturb an icosahedron so rocks read as chipped stone. */
function rockGeometry(detail = 1, seed = 0, squash = 0.82) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    v.multiplyScalar(0.78 + wobble(v, seed) * 0.42);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/**
 * A broken wall segment. The unit box is pre-ruined in the geometry: a jagged
 * top edge, a slight batter (walls lean inward as they rise), and a vertex
 * colour gradient from dirt-stained base to weathered face. Three variants
 * with different break patterns are spread across the instances so nearby
 * ruins do not visibly share a silhouette.
 *
 * The colour attribute is a MULTIPLIER on the concrete albedo, not a colour.
 * It held absolute limestone hex values when the wall was untextured, which
 * cannot survive being multiplied into a real albedo -- 0.16 linear stone times
 * 0.15 linear concrete is a black wall. Same gradient, expressed as a scale:
 * 1.0 on the clean upper face falling to 0.62 at the damp footing, running
 * browner as it goes down.
 */
function ruinGeometry(seed) {
  const geo = new THREE.BoxGeometry(1, 1, 1, 6, 6, 2).toNonIndexed();
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);

    // Break the top edge. The drop is keyed on x so the whole top ring of
    // vertices at one x tears together, producing steps rather than fuzz.
    if (v.y > 0.49) {
      const bite = Math.sin(v.x * 21.7 + seed * 7.3) * 0.5 + 0.5;
      const step = Math.sin(v.x * 6.1 + seed * 2.9) * 0.5 + 0.5;
      v.y -= bite * 0.16 + step * 0.30;
    }
    // Batter: the wall face leans in toward the top, like real masonry.
    const t = v.y + 0.5;
    v.z *= 1 - t * 0.12;
    // A little face unevenness, so the flats catch light unevenly.
    v.z += (wobble(v, seed + 5) - 0.5) * 0.03;

    pos.setXYZ(i, v.x, v.y, v.z);

    // 0 at the footing, 1 up the clean face.
    const up = Math.min(1, Math.max(0, t * 1.4 - 0.1));
    // Mottle, so the gradient is not airbrushed.
    const k = (0.62 + 0.38 * up) * (0.88 + wobble(v, seed + 9) * 0.24);
    colors[i * 3] = k;
    colors[i * 3 + 1] = k * (0.94 + 0.05 * up);
    colors[i * 3 + 2] = k * (0.86 + 0.09 * up);
  }
  geo.computeVertexNormals();
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/**
 * Concatenate non-indexed geometries into one. Everything merged here shares a
 * single material.
 *
 * UVs come along because the trunks are merged and then textured; a source
 * geometry without them contributes zeros rather than knocking the attribute
 * out of alignment.
 */
function mergeGeos(list) {
  let count = 0;
  for (const g of list) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let o = 0, uo = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o);
    nrm.set(g.attributes.normal.array, o);
    const t = g.attributes.uv;
    if (t) uv.set(t.array, uo);
    o += g.attributes.position.array.length;
    uo += g.attributes.position.count * 2;
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/**
 * Rewrite a trunk's UVs so the bark grain is even.
 *
 * A cylinder's own v runs 0..1 over its height, and trunks are unit-height
 * geometry scaled per-instance -- so leaving v alone would stretch the grain by
 * the tree's height and make a tall tree's bark visibly coarser than a short
 * one's. Deriving v from the vertex's own y instead fixes the repeat to
 * `vPerUnit` over the trunk, which lands near a centimetre of texel on a
 * typical tree. v = 0 stays at the base, which TRUNK_FRAG relies on.
 */
function barkUV(geo, uRepeat = 2, vPerUnit = 4) {
  const uv = geo.attributes.uv;
  const pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * uRepeat, pos.getY(i) * vPerUnit);
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Per-instance brightness for stone, centred on 1.0.
 *
 * Every boulder samples the same 256px tile, so without this they share not
 * just a shape family but an exact value -- which is what makes a scree slope
 * read as clones of one rock. Centring on 1.0 means the average boulder shows
 * the texture's own albedo rather than a tinted version of it.
 */
function stoneTint(out, seed) {
  const v = 0.80 + rand2(seed, 2, 93) * 0.42;
  return out.setRGB(v, v * 0.99, v * 0.95);
}

/** A box, moved into place, as non-indexed geometry ready for merging. */
function boxAt(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.translate(x, y, z);
  return g;
}

export class PropRenderer {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.meshes = [];
    this.foliageMats = [];
  }

  build() {
    const byType = { tree: [], rock: [], ruin: [], crate: [], wall: [], roof: [] };
    for (const p of this.world.props) byType[p.type]?.push(p);

    this.mats = this._materials();
    this._buildTrees(byType[PROP_TREE]);
    this._buildRocks(byType[PROP_ROCK]);
    this._buildRuins(byType[PROP_RUIN]);
    this._buildCrates(byType[PROP_CRATE]);
    this._buildStructures(byType[PROP_WALL], byType[PROP_ROOF]);
    this._buildScatter();

    // The foliage sway needs a clock. The sky fans one out from its own draw
    // call, so nothing has to be added to the game loop.
    this.unhook = onFrame((ctx) => this._wind(ctx.time));
  }

  /**
   * Building walls and roofs: one instanced box each, scaled per piece.
   *
   * Both share a unit-box geometry and differ only in scale, so a whole
   * settlement costs two draw calls. The material is the plain concrete
   * projection rather than the ruins' vertex-coloured one -- a BoxGeometry
   * carries no colour attribute, and a vertexColors material reads that
   * missing attribute as black.
   */
  _buildStructures(walls, roofs) {
    const tint = new THREE.Color();

    const place = (list, mesh) => {
      const M = new THREE.Matrix4(), Q = new THREE.Quaternion();
      const P = new THREE.Vector3(), S = new THREE.Vector3();
      list.forEach((p, i) => {
        Q.identity();
        // Props record the base y of a piece; a box is placed by its centre.
        P.set(p.x, p.y + p.sy / 2, p.z);
        S.set(p.sx, p.sy, p.sz);
        M.compose(P, Q, S);
        mesh.setMatrixAt(i, M);
        // Faint per-piece variation, centred on 1.0 so it multiplies the
        // albedo rather than recolouring it: a long wall of identical panels
        // reads as one flat slab.
        const v = 0.93 + rand2(i, 5, 4242) * 0.14;
        mesh.setColorAt(i, tint.setRGB(v, v, v));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };

    if (walls?.length) {
      place(walls, this._add(new THREE.BoxGeometry(1, 1, 1), this.mats.building, walls.length));
    }
    if (roofs?.length) {
      place(roofs, this._add(new THREE.BoxGeometry(1, 1, 1), this.mats.building, roofs.length));
    }
  }

  /**
   * The shared triplanar materials.
   *
   * Built once and reused across prop types so stone on a boulder, a wall's
   * rubble and a scatter pebble all compile to one program. The split between
   * `stone` and `pebble` is texel density: one repeat per 1.5m looks right on a
   * two-metre boulder and turns a 30cm pebble into a single flat smear, so the
   * small stuff gets its own, denser, projection.
   */
  _materials() {
    const rock = rockTextures();
    // No material colour on any of these. The textures out of texturelab are
    // real linear albedo -- stone sits around 0.08-0.20, concrete 0.09-0.32 --
    // so a tint on top multiplies a dark value by another dark value and the
    // props come out as black silhouettes. Variation belongs per instance
    // (setColorAt, centred on 1.0), not in the material.
    return {
      stone: triplanarMaterial(rock, {
        key: 'stone', scale: 0.65, roughness: 0.98,
      }),
      pebble: triplanarMaterial(rock, {
        key: 'pebble', scale: 2.2, roughness: 0.98,
      }),
      // vertexColors carries the base-to-top weathering gradient that
      // ruinGeometry bakes in -- as a multiplier, not an absolute colour.
      concrete: triplanarMaterial(concreteTextures(), {
        key: 'concrete', scale: 0.8, roughness: 0.95, vertexColors: true,
      }),
      // Same concrete, no vertexColors: building walls and roofs are unit
      // boxes with no colour attribute for that flag to read.
      building: triplanarMaterial(concreteTextures(), {
        key: 'building', scale: 0.7, roughness: 0.93,
      }),
      // Object space, so the sawn grain stays square to the crate's own faces
      // instead of sliding across them as the crate rotates.
      plank: triplanarMaterial(plankTextures(), {
        key: 'plank', space: 'object', scale: 1.6, roughness: 0.88,
      }),
      // The batten skeleton reads darker than the panels it frames, which is
      // main's two-tone crate; 0.62 in linear is that step, not a recolour.
      batten: triplanarMaterial(plankTextures(), {
        key: 'batten', space: 'object', scale: 2.4, roughness: 0.9, color: 0xcdc6bc,
      }),
    };
  }

  _add(geo, mat, count, opts = {}) {
    const m = new THREE.InstancedMesh(geo, mat, count);
    m.castShadow = opts.castShadow ?? true;
    m.receiveShadow = true;
    m.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    this.group.add(m);
    this.meshes.push(m);
    return m;
  }

  /**
   * An alpha-cut card material, shared with the ground clutter's shader.
   *
   * Going through clutter.js rather than rolling a material here is the point:
   * the grass already solved sway, the sqrt albedo decode, aerial fog and the
   * backface normal flip that would otherwise light the far side of every card
   * as though it faced the floor. Foliage wants all four.
   */
  _foliage(map, opts) {
    const mat = foliageMaterial(map, { alphaTest: 0.5, roughness: 0.85, ...opts });
    this.foliageMats.push(mat);
    return mat;
  }

  /** Drive the card sway. One clock for every card material in the scene. */
  _wind(time) {
    for (const m of this.foliageMats) {
      const u = m.userData.uniforms;
      if (u) u.uTime.value = time;
    }
  }

  // ------------------------------------------------------------------ trees

  _buildTrees(trees) {
    if (!trees.length) return;

    // Two species, split deterministically. Uniform forests are plantations;
    // a mix is what reads as wilderness.
    const broadleaf = [];
    const pine = [];
    for (const p of trees) (p.rot % 1 < 0.58 ? broadleaf : pine).push(p);

    this._buildBroadleaf(broadleaf);
    this._buildPines(pine);
  }

  _buildBroadleaf(trees) {
    if (!trees.length) return;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion();
    const E = new THREE.Euler(), P = new THREE.Vector3(), S = new THREE.Vector3();

    // Trunk: tapered, with a root flare at the base so it grips the ground
    // instead of standing on it. Bark carries the fissures, the moss in them and
    // the dirt at the footing, so the trunk needs no tint of its own.
    const trunkGeo = barkUV(mergeGeos([
      new THREE.CylinderGeometry(0.26, 0.40, 1, 7, 1).toNonIndexed().translate(0, 0.5, 0),
      new THREE.CylinderGeometry(0.40, 0.62, 0.14, 7, 1).toNonIndexed().translate(0, 0.07, 0),
    ]));
    const barkMat = surfaceMaterial(barkTextures(), {
      key: 'bark', roughness: 0.95, bump: 1.15, frag: TRUNK_FRAG,
    });
    const trunk = this._add(trunkGeo, barkMat, trees.length);

    // The crown: a shell of alpha-cut leaf cards. Nine of the twelve are laid
    // out on a fibonacci-ish sphere and turned to face outward, which makes their
    // normals approximate the crown's own sphere so the whole thing shades as one
    // volume instead of as a pile of independently lit rectangles. The other
    // three are dropped in at random angles nearer the axis to fill the holes the
    // shell leaves when you stand under it.
    // 22 rather than the 12 this started at. A card seen exactly edge-on is
    // invisible, so a shell thin enough to look right side-on tears open when you
    // stand under an isolated tree and look up into the sky behind it. Cards are
    // two triangles; density is the cheapest fix available here.
    const CARDS = 22;
    const OUTWARD = 14;
    const leafMat = this._foliage(leafCard(), { windAmp: 0.17, key: 'leaf' });
    const leaves = this._add(
      new THREE.PlaneGeometry(1, 1), leafMat, trees.length * CARDS,
      // Foliage casting shadows would double the alpha-tested vertex load for a
      // canopy that already reads as translucent; the trunk shadow is what sells
      // the tree's contact with the ground.
      { castShadow: false });

    // Two bare branches per tree, bridging trunk and crown -- the giveaway of
    // a lollipop is a canopy with no visible connection to its trunk. Same bark
    // material as the trunk (one program, and they are the same wood); only the
    // UV density differs, and that lives in the geometry.
    const branchGeo = new THREE.CylinderGeometry(0.035, 0.075, 1, 5, 1);
    branchGeo.translate(0, 0.5, 0);
    barkUV(branchGeo, 1, 3);
    const branches = this._add(branchGeo, barkMat, trees.length * 2);

    const tint = new THREE.Color();

    trees.forEach((p, i) => {
      const h = p.height;
      const lean = (p.rot % 0.16) - 0.08;

      E.set(lean, p.rot, lean * 0.6);
      Q.setFromEuler(E);
      P.set(p.x, p.y, p.z);
      S.set(p.scale, h, p.scale);
      M.compose(P, Q, S);
      trunk.setMatrixAt(i, M);

      // This tree's green, expressed as a MULTIPLIER on the leaf card's albedo
      // rather than a colour. The card already carries real leaf green (~0.10-0.24
      // linear); an absolute HSL colour here would multiply a dark green by
      // another dark green and give a stand of black trees -- the same trap the
      // ruin gradient and the stone tint are commented for. Red up and blue down
      // drifts the crown from fresh green toward yellowed olive.
      const drift = rand2(i, 5, 431);
      const rMul = 1.00 + drift * 0.18;
      const bMul = 0.94 - drift * 0.18;

      // Branches reach from the upper trunk *into* the crown, and have to stop
      // there. At h * 0.30 and this tilt the tips cleared the leaf shell and read
      // as bare poles stuck through the canopy -- worse than no branches at all,
      // which is what they exist to avoid.
      for (let b = 0; b < 2; b++) {
        const a = p.rot * 5 + b * 2.6;
        P.set(p.x, p.y + h * (0.54 + b * 0.12), p.z);
        E.set(0.78 + b * 0.22, a, 0);
        Q.setFromEuler(E);
        S.set(p.scale, h * 0.21, p.scale);
        M.compose(P, Q, S);
        branches.setMatrixAt(i * 2 + b, M);
      }

      // The crown sits a little wider than it is tall -- a broadleaf spreads.
      const cy = p.y + h * 0.78;
      const rx = 2.05 * p.scale;
      // Deeper than it first looked right: at 1.35 the cards stacked into a flat
      // umbrella, because they are wider than the shell they sit on.
      const ry = 1.75 * p.scale;
      for (let k = 0; k < CARDS; k++) {
        const o = i * CARDS + k;
        const outward = k < OUTWARD;
        const u = rand2(i, k + 11, 197);
        const v = rand2(i, k + 29, 199);
        const theta = outward ? (k / OUTWARD) * Math.PI * 2 + p.rot : u * Math.PI * 2;
        // Squeezed off the poles: a full sphere puts a card flat on top of the
        // crown where it reads as a lid.
        const phi = outward
          ? Math.acos(1 - 2 * ((k + 0.5) / OUTWARD)) * 0.82 + 0.28
          : Math.acos(1 - 2 * v);
        const rr = outward ? 1.0 : 0.28 + u * 0.4;

        const dx = Math.sin(phi) * Math.cos(theta);
        const dy = Math.cos(phi);
        const dz = Math.sin(phi) * Math.sin(theta);

        P.set(p.x + dx * rx * rr, cy + dy * ry * rr, p.z + dz * rx * rr);
        if (outward) {
          TMP_Q.setFromUnitVectors(UNIT_Z, TMP_D.set(dx, dy, dz).normalize());
          // Spin the card in its own plane so the shell does not look combed.
          TMP_Q2.setFromAxisAngle(UNIT_Z, v * Math.PI * 2);
          Q.copy(TMP_Q).multiply(TMP_Q2);
        } else {
          E.set(rand2(i, k + 31, 211) * 2.2 - 1.1, u * 6.28, rand2(i, k + 37, 223) * 1.4 - 0.7);
          Q.setFromEuler(E);
        }
        const size = (1.95 + rand2(i, k + 41, 227) * 1.05) * p.scale;
        S.set(size, size, size);
        M.compose(P, Q, S);
        leaves.setMatrixAt(o, M);

        // Cards nearer the top of the crown run brighter, the underside stays
        // darker -- that vertical gradient is what gives a canopy depth. Floored
        // around 0.72 because past that it stops reading as shadow and starts
        // reading as a hole punched in the tree.
        const lit = 0.72 + 0.32 * Math.max(0, dy);
        // Held under 1.0 on average: the leaf card is already a fairly bright
        // green, and letting the tint push past it takes the canopy acid against
        // an olive terrain.
        const tone = 0.70 + rand2(i, k + 43, 229) * 0.34;
        const base = tone * lit;
        tint.setRGB(base * rMul, base, base * bMul);
        leaves.setColorAt(o, tint);
      }
    });

    trunk.instanceMatrix.needsUpdate = true;
    branches.instanceMatrix.needsUpdate = true;
    leaves.instanceMatrix.needsUpdate = true;
    leaves.instanceColor.needsUpdate = true;
  }

  _buildPines(trees) {
    if (!trees.length) return;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion();
    const E = new THREE.Euler(), P = new THREE.Vector3(), S = new THREE.Vector3();

    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.34, 1, 7, 1);
    trunkGeo.translate(0, 0.5, 0);
    barkUV(trunkGeo);
    // Same bark, tinted down: pine bark is darker and greyer than broadleaf, and
    // main's palette had the two trunks at different browns for exactly that
    // reason. A near-white multiply keeps the texture's own detail intact.
    const trunk = this._add(trunkGeo, surfaceMaterial(barkTextures(), {
      key: 'bark-pine', color: 0xe8e0d6, roughness: 0.95, bump: 1.15, frag: TRUNK_FRAG,
    }), trees.length);

    // Needle sprays on a cone, in two populations.
    //
    // The spiral shell makes the silhouette: lower cards sit wider out, hang
    // harder and run larger. INNER cards pack the crown axis instead, and they
    // are what stops you seeing sky through the middle of a pine.
    //
    // A solid inner cone was the obvious way to plug that middle and it is the
    // wrong tool: an untextured flat-shaded cone is plainly visible *through* the
    // gaps in the card shell it is supposed to be hiding behind, so it reads as a
    // cardboard cutout inside the tree. Cards can hide behind other cards.
    //
    // Denser overall than the broadleaf crown -- a pine's outline is nearly
    // solid, and a sparse spiral just looks like a dead tree.
    const CARDS = 30;
    const INNER = 8;
    const needleMat = this._foliage(needleCard(), { windAmp: 0.10, key: 'needle' });
    const sprigs = this._add(
      new THREE.PlaneGeometry(1, 1), needleMat, trees.length * CARDS,
      { castShadow: false });
    const tint = new THREE.Color();

    trees.forEach((p, i) => {
      const h = p.height;
      const lean = (p.rot % 0.12) - 0.06;

      E.set(lean, p.rot, lean * 0.5);
      Q.setFromEuler(E);
      P.set(p.x, p.y, p.z);
      S.set(p.scale * 0.9, h, p.scale * 0.9);
      M.compose(P, Q, S);
      trunk.setMatrixAt(i, M);

      // The crown envelope, shared by both card populations.
      const cy0 = h * 0.28;
      const ch = h * 0.68;

      // Per-tree multiplier on the needle albedo, same reasoning as the
      // broadleaf: the card is already cold dark green, so this only nudges it.
      const drift = rand2(i, 9, 433);
      const rMul = 0.94 + drift * 0.16;
      const bMul = 1.04 - drift * 0.14;

      for (let k = 0; k < CARDS; k++) {
        const o = i * CARDS + k;
        const inner = k < INNER;
        // 0 at the crown base, 1 at the tip. Both populations span the full
        // height, so the axis is plugged all the way up and not just in the middle.
        const f = inner
          ? (k + 0.5) / INNER
          : (k - INNER + 0.5) / (CARDS - INNER);
        // The golden angle, so the spiral never lines up into a visible seam
        // however many cards it is given.
        const a = p.rot * 3 + k * 2.399963;
        const rr = (inner
          ? 0.26 + f * 0.40
          : 1.65 * (1 - f * 0.86) + 0.20) * p.scale;
        // Crosses zero near the top: a conifer's lower branches hang and its
        // leader sweeps up. Holding every spray horizontal made the crown read
        // as a flat star of fronds seen from below.
        const droop = inner ? 0.50 - f * 0.80 : 0.78 - f * 1.10;

        P.set(p.x + Math.cos(a) * rr, p.y + cy0 + f * ch, p.z + Math.sin(a) * rr);

        // The sprig runs along the card's local +Y (needle base at v = 0), so
        // aiming local +Y outward-and-down is what makes the branch hang instead
        // of standing up like a flag.
        TMP_D.set(Math.cos(a), -droop, Math.sin(a)).normalize();
        TMP_Q.setFromUnitVectors(UNIT_Y, TMP_D);
        TMP_Q2.setFromAxisAngle(TMP_D, a * 1.7 + f * 2.1);
        Q.copy(TMP_Q2).multiply(TMP_Q);

        // The spray only fills the middle ~45% of its card's width, so the card
        // runs wider than the crown radius it covers. Kept well under the earlier
        // 4.4 though: at that size each card was a distinct frond stuck on the
        // trunk rather than part of a crown.
        const size = (inner ? 1.45 : 1.55 + (1 - f) * 1.35) * p.scale;
        S.set(size, size, size);
        M.compose(P, Q, S);
        sprigs.setMatrixAt(o, M);

        // Up the tree is toward the light; the skirt at the bottom sits in the
        // crown's own shadow. The inner cards run darker still -- they are the
        // crown's interior, and that depth is the whole reason they are there.
        const lit = (inner ? 0.62 : 0.82) + 0.30 * f;
        const tone = 0.86 + rand2(i, k + 47, 233) * 0.34;
        const base = tone * lit;
        tint.setRGB(base * rMul, base, base * bMul);
        sprigs.setColorAt(o, tint);
      }
    });

    trunk.instanceMatrix.needsUpdate = true;
    sprigs.instanceMatrix.needsUpdate = true;
    sprigs.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------------ rocks

  _buildRocks(rocks) {
    if (!rocks.length) return;

    // Faceting still carries the silhouette, and it survives the textured path
    // for free: these icosahedra are non-indexed, so computeVertexNormals gives
    // all three corners of a face the same normal and the interpolated normal
    // the shader projects from is constant across each face.
    const main = this._add(rockGeometry(1, 0), this.mats.stone, rocks.length);
    // A companion chip beside each boulder. Rocks come in families; a lone
    // clean boulder on flat grass looks placed rather than deposited.
    const chip = this._add(rockGeometry(0, 4, 0.7), this.mats.pebble, rocks.length);

    const M = new THREE.Matrix4(), Q = new THREE.Quaternion();
    const E = new THREE.Euler(), P = new THREE.Vector3(), S = new THREE.Vector3();
    const tint = new THREE.Color();

    rocks.forEach((p, i) => {
      E.set(p.rot * 0.3, p.rot, p.rot * 0.2);
      Q.setFromEuler(E);
      P.set(p.x, p.y - p.scale * 0.28, p.z);
      S.set(p.scale, p.scale * 0.9, p.scale * 1.05);
      M.compose(P, Q, S);
      main.setMatrixAt(i, M);
      main.setColorAt(i, stoneTint(tint, i));
      chip.setColorAt(i, stoneTint(tint, i + 7919));

      const a = p.rot * 5.3;
      const d = p.scale * (1.1 + (p.rot % 0.3));
      const cs = p.scale * (0.22 + (p.rot % 0.17));
      E.set(p.rot, p.rot * 2.7, 0);
      Q.setFromEuler(E);
      P.set(p.x + Math.cos(a) * d, this.world.heightAt(p.x + Math.cos(a) * d, p.z + Math.sin(a) * d) - cs * 0.3, p.z + Math.sin(a) * d);
      S.set(cs, cs * 0.8, cs);
      M.compose(P, Q, S);
      chip.setMatrixAt(i, M);
    });
    main.instanceMatrix.needsUpdate = true;
    chip.instanceMatrix.needsUpdate = true;
    main.instanceColor.needsUpdate = true;
    chip.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------------ ruins

  _buildRuins(ruins) {
    if (!ruins.length) return;

    // Three break patterns, spread across the walls; vertexColors carries the
    // weathering gradient baked into the geometry, weathered concrete supplies
    // the surface. World-space projection matters most here: walls are a unit
    // box scaled to length, so a geometry UV would smear along the long axis.
    const wallMat = this.mats.concrete;
    const variants = [1, 2, 3].map(() => []);
    ruins.forEach((p, i) => variants[i % 3].push(p));

    const M = new THREE.Matrix4(), Q = new THREE.Quaternion();
    const P = new THREE.Vector3(), S = new THREE.Vector3();
    const E = new THREE.Euler();

    variants.forEach((list, vi) => {
      if (!list.length) return;
      const mesh = this._add(ruinGeometry(vi * 17 + 3), wallMat, list.length);
      list.forEach((p, i) => {
        Q.identity();
        P.set(p.x, p.y - 0.6 + p.sy / 2, p.z);
        S.set(p.sx, p.sy + 0.6, p.sz);
        M.compose(P, Q, S);
        mesh.setMatrixAt(i, M);
      });
      mesh.instanceMatrix.needsUpdate = true;
    });

    // Rubble at the foot of every wall -- the missing top had to go somewhere,
    // and the debris is what ties the wall to the ground plane.
    const rubble = this._add(rockGeometry(0, 8, 0.6), this.mats.pebble, ruins.length * 2);
    const rubbleTint = new THREE.Color();
    ruins.forEach((p, i) => {
      for (let k = 0; k < 2; k++) {
        const r = rand2(i, k, 991);
        const along = (r - 0.5) * (p.sx > p.sz ? p.sx : p.sz);
        const out = (p.sx > p.sz ? p.sz : p.sx) * 0.5 + 0.3 + r * 0.5;
        const x = p.x + (p.sx > p.sz ? along : (k ? out : -out));
        const z = p.z + (p.sx > p.sz ? (k ? out : -out) : along);
        const s = 0.22 + r * 0.4;
        E.set(r * 3, r * 7, 0);
        Q.setFromEuler(E);
        P.set(x, this.world.heightAt(x, z) + s * 0.15, z);
        S.set(s, s * 0.7, s);
        M.compose(P, Q, S);
        rubble.setMatrixAt(i * 2 + k, M);
        rubble.setColorAt(i * 2 + k, stoneTint(rubbleTint, i * 2 + k));
      }
    });
    rubble.instanceMatrix.needsUpdate = true;
    rubble.instanceColor.needsUpdate = true;
  }

  // ----------------------------------------------------------------- crates

  _buildCrates(crates) {
    // A crate with a model is drawn by models.js, fitted to this same collider.
    // Drawing both would leave a box of planks inside a military crate.
    crates = crates.filter((p) => !p.model);
    if (!crates.length) return;

    // A crate is planks and a frame, not a box: pale panel faces inside a
    // darker batten skeleton. Two instanced meshes, two wood tones.
    const panel = this._add(
      new THREE.BoxGeometry(0.92, 0.92, 0.92).toNonIndexed(),
      this.mats.plank, crates.length);

    const b = 0.10;   // batten thickness
    const frameGeo = mergeGeos([
      // Four vertical corner battens.
      boxAt(b, 1, b, -0.5 + b / 2, 0, -0.5 + b / 2),
      boxAt(b, 1, b, 0.5 - b / 2, 0, -0.5 + b / 2),
      boxAt(b, 1, b, -0.5 + b / 2, 0, 0.5 - b / 2),
      boxAt(b, 1, b, 0.5 - b / 2, 0, 0.5 - b / 2),
      // Horizontal rails, top and bottom, on all four sides.
      boxAt(1, b, b, 0, 0.5 - b / 2, -0.5 + b / 2),
      boxAt(1, b, b, 0, 0.5 - b / 2, 0.5 - b / 2),
      boxAt(1, b, b, 0, -0.5 + b / 2, -0.5 + b / 2),
      boxAt(1, b, b, 0, -0.5 + b / 2, 0.5 - b / 2),
      boxAt(b, b, 1, -0.5 + b / 2, 0.5 - b / 2, 0),
      boxAt(b, b, 1, 0.5 - b / 2, 0.5 - b / 2, 0),
      boxAt(b, b, 1, -0.5 + b / 2, -0.5 + b / 2, 0),
      boxAt(b, b, 1, 0.5 - b / 2, -0.5 + b / 2, 0),
    ]);
    const frame = this._add(frameGeo, this.mats.batten, crates.length);

    const M = new THREE.Matrix4(), Q = new THREE.Quaternion();
    const E = new THREE.Euler(), P = new THREE.Vector3(), S = new THREE.Vector3();

    crates.forEach((p, i) => {
      E.set(0, p.rot, 0);
      Q.setFromEuler(E);
      P.set(p.x, p.y - 0.2 + p.scale / 2, p.z);
      S.set(p.scale, p.scale + 0.2, p.scale);
      M.compose(P, Q, S);
      panel.setMatrixAt(i, M);
      frame.setMatrixAt(i, M);
    });
    panel.instanceMatrix.needsUpdate = true;
    frame.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- scatter

  /**
   * Static ground cover: pebbles and low bushes, scattered deterministically
   * over the grass biome.
   *
   * Grass is deliberately NOT here. clutter.js streams a dense ring of
   * alpha-cut, wind-animated tufts around the camera, which is strictly better
   * than a cone clump wherever the player actually is; running both put two
   * kinds of grass in the same square metre and the cheaper one won on top.
   * Beyond that ring the terrain's own grass layer carries the ground, which is
   * what it is for. Stones and bushes stay, at the density main tuned them to:
   * clutter has no bushes, and its pebbles only reach as far as the ring.
   */
  _buildScatter() {
    const world = this.world;
    const field = world.field;
    // The biome grid is (N+1) x (N+1) -- one entry per cell *corner*, not per
    // cell -- so both the clamp and the row stride use N+1.
    const biomeAt = (x, z) => {
      const gi = Math.max(0, Math.min(N, Math.round(x / CELL)));
      const gj = Math.max(0, Math.min(N, Math.round(z / CELL)));
      return field.biome[gj * (N + 1) + gi];
    };

    const nrm = { x: 0, y: 1, z: 0 };
    const stones = [];
    const bushes = [];

    // One candidate per ~1.6m cell, thinned by noise. Deterministic, so co-op
    // partners stand in the same grass.
    for (let gx = 6; gx < world.size - 6; gx += 1.6) {
      for (let gz = 6; gz < world.size - 6; gz += 1.6) {
        const r = rand2(gx * 10, gz * 10, 777);
        if (r > 0.42) continue;

        const x = gx + (r * 13 % 1) * 1.4;
        const z = gz + (r * 29 % 1) * 1.4;
        if (!world.isWalkable(x, z)) continue;
        if (biomeAt(x, z) !== BIOME_GRASS) continue;
        world.normalAt(x, z, nrm);
        if (nrm.y < 0.86) continue;   // scatter slides off steep ground

        const y = world.heightAt(x, z);
        // Thresholds unchanged from when grass was in this pass, so stones and
        // bushes land at exactly the density they were tuned at; the 0..0.80
        // band that used to be tufts is simply left to clutter.js now.
        const kind = rand2(gx * 3, gz * 7, 778);
        if (kind < 0.80) continue;
        if (kind < 0.93) stones.push({ x, y, z, r });
        else bushes.push({ x, y, z, r });
      }
    }

    const M = new THREE.Matrix4(), Q = new THREE.Quaternion();
    const E = new THREE.Euler(), P = new THREE.Vector3(), S = new THREE.Vector3();

    if (stones.length) {
      const mesh = this._add(rockGeometry(0, 21, 0.6),
        this.mats.pebble, stones.length, { castShadow: false });
      const stoneCol = new THREE.Color();
      stones.forEach((t, i) => {
        const s = 0.10 + t.r * 0.22;
        E.set(t.r * 5, t.r * 11, 0);
        Q.setFromEuler(E);
        P.set(t.x, t.y + s * 0.2, t.z);
        S.set(s, s * 0.75, s);
        M.compose(P, Q, S);
        mesh.setMatrixAt(i, M);
        mesh.setColorAt(i, stoneTint(stoneCol, i));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }

    if (bushes.length) {
      // Cards here too. A bush is the same material as a canopy, and leaving
      // these as solid blobs would put the exact silhouette the trees just lost
      // back in the frame at eye level, where it is most obvious.
      // A squat dome of outward-facing cards, built the same way as a crown.
      //
      // Two things matter here and both were wrong first time round. The card's
      // NORMAL has to point outward -- aligning UNIT_Z, not UNIT_Y. Aligning the
      // plane's in-plane up axis instead leaves every normal perpendicular to the
      // direction it is meant to face, which costs twice: the cards are seen
      // edge-on so they render as slivers, and a normal pointing sideways takes
      // almost no diffuse, so the whole bush comes out black. A bush is at eye
      // level and a few metres away, so there is nowhere for that to hide.
      //
      // And four cards cannot close a shell. A crown gets away with a sparse one
      // because it is 15m up and read against sky; a bush is walked past.
      const CARDS = 10;
      const mat = this._foliage(leafCard(), { windAmp: 0.13, key: 'leaf' });
      const mesh = this._add(new THREE.PlaneGeometry(1, 1), mat,
        bushes.length * CARDS, { castShadow: false });
      const tint = new THREE.Color();
      bushes.forEach((t, i) => {
        const s = 0.95 + t.r * 1.15;
        const rMul = 0.98 + (t.r % 0.31) * 0.55;
        const bMul = 0.96 - (t.r % 0.27) * 0.50;
        // Wider than tall, and sunk so the lower cards meet the grass instead of
        // hovering over their own shadow.
        const rx = s * 0.62;
        const ry = s * 0.44;
        const cy = t.y + ry * 0.72;
        for (let k = 0; k < CARDS; k++) {
          const o = i * CARDS + k;
          const v = rand2(i, k + 53, 239);
          // Golden-angle ring plus a deterministic jitter: an even ring combs,
          // and pure random leaves holes at this card count.
          const theta = k * 2.399963 + t.r * 11 + v * 0.5;
          // Upper hemisphere only, held off the pole so no card lies flat on top.
          const phi = Math.acos(1 - ((k + 0.5) / CARDS) * 0.92) * 0.86 + 0.22;
          const dx = Math.sin(phi) * Math.cos(theta);
          const dy = Math.cos(phi);
          const dz = Math.sin(phi) * Math.sin(theta);

          TMP_Q.setFromUnitVectors(UNIT_Z, TMP_D.set(dx, dy, dz).normalize());
          TMP_Q2.setFromAxisAngle(UNIT_Z, v * Math.PI * 2);
          Q.copy(TMP_Q).multiply(TMP_Q2);
          P.set(t.x + dx * rx, cy + dy * ry, t.z + dz * rx);
          S.set(s, s, s);
          M.compose(P, Q, S);
          mesh.setMatrixAt(o, M);
          const base = (0.74 + rand2(i, k + 59, 241) * 0.36);
          tint.setRGB(base * rMul, base, base * bMul);
          mesh.setColorAt(o, tint);
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    // The wind clock outlives the group otherwise: framehooks holds the closure,
    // and a stale one would keep poking uniforms on disposed materials.
    this.unhook?.();
    this.unhook = null;
    this.foliageMats.length = 0;
    // A Set because the materials are shared across meshes now -- trunk and
    // branches are one bark material, and every stone surface is one of two.
    const mats = new Set();
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      mats.add(m.material);
    }
    for (const m of mats) m.dispose();
    this.meshes.length = 0;
    this.mats = null;
    // _rebuildWorld() builds a fresh PropRenderer per seed, so the old group has
    // to leave the scene with it. The texture set stays: it is cached in
    // texturelab and the next world will want the same one.
    this.scene.remove(this.group);
  }
}
