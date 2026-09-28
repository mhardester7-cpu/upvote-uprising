// Draws what buildings.js laid out.
//
// Every piece is an axis-aligned box, which is the whole reason this is cheap:
// one BoxGeometry, one InstancedMesh per material, and a scale-and-translate
// matrix per piece. A site with seven multi-storey buildings comes out at a
// handful of draw calls rather than several thousand.
//
// Placement lives entirely in buildings.js. This file only reads the records,
// so the wall you can see is the wall you walk into.

import * as THREE from '../../vendor/three.module.js';
import { surface } from './interiortextures.js';
import { photoSurface } from './photosets.js';
import { Merger, chamferedBox } from './archmesh.js';
import {
  PROP_SLAB, PROP_WALLSEG, PROP_STAIR, PROP_FURNITURE,
  PROP_CONTAINER, PROP_BARREL, PROP_DOOR, PROP_WINDOW,
  FLOOR_H,
} from '../world/world.js';
import { levelsOf, DOOR_W, doorwayCenter } from '../world/complex.js';

const srgb = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/**
 * Material per structural role.
 *
 * `surf` names the procedural texture and `repeat` sets its world scale. The
 * repeat is what actually sells the room: aggregate the size of a fist on a
 * wall and grout lines a foot apart on a floor are how the eye judges how big
 * the space is. A flat colour gives it nothing to judge with.
 */
const MATERIALS = {
  districtSand: {color:0xffffff,roughness:1,surf:'concrete',tint:[171,162,139]},
  districtSandFloor: {color:0xffffff,roughness:1,surf:'concrete',tint:[135,128,111]},
  districtSteel: {color:0xffffff,roughness:.96,surf:'concrete',tint:[130,136,128]},
  districtSteelFloor: {color:0xffffff,roughness:.82,metalness:.25,surf:'metal',tint:[80,83,79]},
  districtGarden: {color:0xffffff,roughness:1,surf:'concrete',tint:[136,144,120]},
  districtLeaves: {color:0xffffff,roughness:1,surf:'concrete',tint:[63,78,44]},
  districtBrick: {color:0xffffff,roughness:1,surf:'brick',tint:[133,99,79]},
  districtIvory: {color:0xffffff,roughness:.94,surf:'concrete',tint:[185,181,164]},
  districtTile: {color:0xffffff,roughness:.88,surf:'concrete',tint:[136,141,133]},
  districtViolet: {color:0xffffff,roughness:.96,surf:'concrete',tint:[137,142,144]},
  districtBasalt: {color:0xffffff,roughness:1,surf:'concrete',tint:[108,114,107]},
  districtTerminal: {color:0xffffff,roughness:1,surf:'plaster',tint:[157,150,128]},
  districtWood: {color:0xffffff,roughness:.95,surf:'wood',tint:[116,103,78]},
  urbanFacade: {color:0xffffff,roughness:.94,surf:'facade',tint:[148,148,135]},
  urbanFacadeOchre: {color:0xffffff,roughness:.94,surf:'facade',tint:[158,147,123]},
  urbanFacadeGreen: {color:0xffffff,roughness:.97,surf:'facade',tint:[132,142,121]},
  urbanDoor: {color:0xffffff,roughness:.8,metalness:.15,surf:'milgreen',tint:[64,73,66]},
  parkourConcrete: { color: 0xffffff, roughness: 0.96, metalness: 0.01,
    surf: 'concrete', repeat: 3, tint: [156, 159, 151] },
  parkourPanel: { color: 0xffffff, roughness: 0.82, metalness: 0.02,
    surf: 'concrete', repeat: 2, tint: [213, 215, 198] },
  parkourDark: { color: 0x535b56, roughness: 1, metalness: 0 },
  slab: { color: 0xffffff, roughness: 0.94, metalness: 0.02,
    surf: 'concrete', repeat: 6, tint: [150, 145, 140] },
  roof: { color: 0xffffff, roughness: 0.95, metalness: 0.03,
    surf: 'concrete', repeat: 8, tint: [124, 121, 117] },
  wall: { color: 0xffffff, roughness: 0.9, metalness: 0.03,
    surf: 'plaster', repeat: 3, tint: [186, 178, 164] },
  partition: { color: 0xffffff, roughness: 0.88, metalness: 0.02,
    surf: 'plaster', repeat: 2.5, tint: [206, 200, 190] },
  parapet: { color: 0xffffff, roughness: 0.93, metalness: 0.03,
    surf: 'concrete', repeat: 3, tint: [142, 135, 127] },
  pilaster: { color: 0xffffff, roughness: 0.92, metalness: 0.03,
    surf: 'concrete', tint: [150, 143, 134] },
  cornice: { color: 0xffffff, roughness: 0.86, metalness: 0.03,
    surf: 'plaster', tint: [196, 190, 180] },
  pipe: { color: 0xffffff, roughness: 0.45, metalness: 0.75,
    surf: 'metal', tint: [122, 118, 112] },
  stair: { color: 0xffffff, roughness: 0.8, metalness: 0.2,
    surf: 'metal', repeat: 1.5, tint: [139, 141, 144] },
  door: { color: 0xffffff, roughness: 0.55, metalness: 0.45,
    surf: 'metal', repeat: 1.2, tint: [180, 118, 44] },
  aquariumDoor: { color: 0xffffff, roughness: 0.34, metalness: 0.66,
    surf: 'metal', repeat: 1.05, tint: [58, 151, 166] },
  // The escape door. Every other shutter is the same rusted orange, so the one
  // that leads outside is worth telling apart from across a room -- a player
  // who has to walk up to each door to read its prompt is a player hunting for
  // the exit rather than deciding whether to pay for it.
  escape: { color: 0xffffff, roughness: 0.42, metalness: 0.62,
    surf: 'metal', repeat: 1.2, tint: [86, 142, 96] },

  // Exterior shell is board-formed concrete; interior partitions are painted
  // plaster. Reading different is most of what stops a room feeling extruded.
  shell: { color: 0xffffff, roughness: 0.93, metalness: 0.03,
    surf: 'concrete', repeat: 2.2, tint: [163, 156, 147] },
  // A courtyard is paved, not carpeted: coarser aggregate than an indoor slab.
  apron: { color: 0xffffff, roughness: 0.96, metalness: 0.02,
    surf: 'concrete', repeat: 9, tint: [136, 132, 126] },

  // ---- trim -----------------------------------------------------------
  // Derived from the layout rather than generated by it: none of this
  // collides, because a skirting board you can catch on is a bug, not detail.
  frame: { color: 0xffffff, roughness: 0.7, metalness: 0.25,
    surf: 'metal', repeat: 0.8, tint: [96, 92, 86] },
  skirting: { color: 0xffffff, roughness: 0.8, metalness: 0.08,
    surf: 'wood', repeat: 0.6, tint: [92, 82, 70] },
  // Boards nailed across a window. Rough sawn timber, so they read as
  // improvised rather than as part of the building.
  board: { color: 0xffffff, roughness: 0.92, metalness: 0.02,
    surf: 'wood', repeat: 0.5, tint: [118, 92, 58] },
  // The hidden panel. Barely off the plaster around it -- enough to notice
  // from arm's length, not enough to spot from the doorway.
  secret: { color: 0xffffff, roughness: 0.84, metalness: 0.06,
    surf: 'plaster', tint: [198, 190, 176] },
};

/** How proud of the wall face trim sits. Enough to catch a highlight. */
const TRIM_PROUD = 0.04;

/** Furniture kinds that read as timber rather than painted steel. */
const WOODEN = new Set(['desk', 'table', 'counter', 'pallet', 'cabinet']);

/** Furniture reads by colour as much as by shape at gameplay distance. */
const FURNITURE_COLOURS = {
  desk: 0x8a6a44,
  table: 0x9a7a4e,
  shelf: 0x6f7378,
  locker: 0x4f6472,
  cabinet: 0x7b6a55,
  sofa: 0x51565f,
  counter: 0x8d8577,
  pallet: 0xa2814f,
};

/** Materials for the recognisable, human-scale habitat silhouettes. */
const HABITAT_SPECS = {
  wood: { color: 0xffffff, roughness: 0.82, metalness: 0.04,
    surf: 'wood', tint: [118, 84, 55] },
  linen: { color: 0xd5cbb8, roughness: 0.96, metalness: 0.0 },
  fabric: { color: 0x59636a, roughness: 0.93, metalness: 0.0 },
  accent: { color: 0x78844d, roughness: 0.84, metalness: 0.02 },
  ceramic: { color: 0xd8d4c5, roughness: 0.28, metalness: 0.0 },
  appliance: { color: 0x7b817f, roughness: 0.48, metalness: 0.18 },
  metal: { color: 0x575d60, roughness: 0.55, metalness: 0.32 },
  screen: { color: 0x091217, roughness: 0.16, metalness: 0.08 },
};

const CONTAINER_COLOURS = [0xa8452c, 0x2f6b8a, 0x4f7a3a, 0xb0912f, 0x8a4a72];
const BARREL_COLOURS = [0xa8352c, 0x2c5f8a, 0xc9a227];

/**
 * Tint, normalised so it colours a photograph instead of dimming it.
 *
 * The procedural surfaces take a tint as a paint colour and draw with it, so the
 * values in MATERIALS are absolute -- concrete is a 150-grey. Multiplying a
 * photograph by that same 0.59 grey would just make a dark room. Scaling the
 * tint so its brightest channel is 1 keeps what the tint is actually *for*: the
 * hue that tells one role from another. That matters more than it sounds --
 * the escape door is green and every other shutter is rusted orange, and a
 * player reads that from across a room to decide whether to pay for the exit.
 */
function tintColour(tint) {
  const max = Math.max(tint[0], tint[1], tint[2], 1);
  // Keep the hue at full strength, and put back a fraction of the tint's own
  // darkness. Normalising to white alone made every concrete surface a bright
  // near-white -- the photograph is already light, so multiplying it by 1.0 lit
  // the floor like a showroom. The 0.4 exponent is a compromise: a 150-grey
  // comes back at 0.82 rather than 0.59, dark enough to read as a floor and
  // light enough that the photograph is still visible in it.
  const value = Math.pow(max / 255, 0.4);
  return new THREE.Color((tint[0] / max) * value, (tint[1] / max) * value, (tint[2] / max) * value);
}

function standard(spec) {
  const m = new THREE.MeshStandardMaterial({
    color: srgb(spec.color),
    roughness: spec.roughness ?? 0.9,
    metalness: spec.metalness ?? 0.05,
  });
  if (spec.surf) {
    // A photographed set when the art pack has one for this role, and the
    // canvas the room used to be drawn with otherwise. Both tile at the same
    // physical size, because the geometry's UVs are already in world units --
    // that is what `repeat: 1` means here and it is why the swap is this small.
    const photo = photoSurface(spec.surf);
    if (photo) {
      m.map = photo.map;
      m.normalMap = photo.normalMap;
      // One file carrying occlusion, roughness and metalness in R, G and B --
      // exactly the channels these three samplers read.
      m.aoMap = photo.armMap;
      m.roughnessMap = photo.armMap;
      m.metalnessMap = photo.armMap;
      m.normalScale = new THREE.Vector2(1, 1);
      if (spec.tint) m.color = tintColour(spec.tint);
      return m;
    }
    // repeat 1: the geometry's UVs are already in world units, so the texture
    // tiles at a fixed physical size instead of being stretched to fit
    // whatever piece it landed on.
    const s = surface(spec.surf, { seed: spec.seed ?? 1, tint: spec.tint, repeat: 1 });
    if (s) {
      m.map = s.map;
      m.normalMap = s.normalMap;
      m.normalScale = new THREE.Vector2(0.9, 0.9);
    }
  }
  return m;
}

/** World size of one texture repeat, per material. */
const TILE = {
  urbanFacade:4.2, urbanFacadeOchre:4.2, urbanFacadeGreen:4.2,
  districtSand:3, districtSteel:3, districtGarden:3, districtIvory:3,
  districtViolet:3, districtBasalt:3, districtTerminal:2, districtBrick:2,
  slab: 1.6, apron: 1.8, roof: 2.0, secret: 1.1,
  shell: 1.4, partition: 1.2, parapet: 1.4, stair: 0.9,
  door: 1.0, frame: 0.6, skirting: 0.5, board: 0.7,
  pilaster: 1.2, cornice: 0.7, pipe: 0.8,
};

export class BuildingRenderer {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.objects = [];
    this.materials = [];
  }

  build() {
    const boxes = new Map();     // material key -> [{x,y,z,sx,sy,sz,rot}]
    const barrels = [[], [], []];
    // Doors are individual meshes, not instances: they are removed one at a
    // time when bought, and pulling one instance out of an InstancedMesh means
    // rewriting the whole buffer. Boards are the same story, one board at a
    // time, plus they move while they are being worked on.
    this.doorMeshes = new Map();
    this.boardMeshes = new Map();
    this.secretMeshes = new Map();

    const put = (key, item) => {
      if (!boxes.has(key)) boxes.set(key, []);
      boxes.get(key).push(item);
    };

    for (const p of [...this.world.props, ...(this.world.plan?.parkourDecor ?? [])]) {
      switch (p.type) {
        case PROP_WINDOW:
          // Boards are the one piece of the shell that comes and goes, so they
          // cannot be baked into the merged geometry the way everything else
          // is. A zombie prising one off has to be something you SEE happen --
          // the plank shakes, splinters, and is gone -- and none of that is
          // possible once it is a few hundred triangles in the middle of a
          // buffer shared with every wall in the building.
          this._buildBoard(p);
          break;
        case PROP_SLAB:
        case PROP_WALLSEG:
        case PROP_STAIR: {
          // The cache panel leaves the world when opened, so unlike ordinary
          // walls it must remain an addressable mesh rather than being baked
          // into the permanent architecture buffer.
          if (p.secret) {
            this._buildSecret(p);
            break;
          }
          // These carry their own y as the *bottom* of the piece, because that
          // is what the collider is built from; the instance needs the centre.
          const theme = this.world.plan?.rooms[p.room]?.parkourTheme;
          const material = theme && !p.parkour
            ? (p.type === PROP_SLAB ? theme.floor : ['wall','partition','parapet'].includes(p.material) ? theme.material : p.material)
            : p.material;
          put(material, {
            x: p.x, y: p.y + p.sy / 2, z: p.z,
            sx: p.sx, sy: p.sy, sz: p.sz, rot: 0,
          });
          break;
        }
        case PROP_FURNITURE:
          // Interactive machines own detailed meshes and moving parts. Their
          // furniture props remain here as the shared collision contract only.
          if (p.model || p.kind === 'nugget_dispenser' || p.kind === 'dinosaur_factory') break;
          if (p.kind === 'human_enclosure' && p.enclosureShape) {
            this._putHumanEnclosure(p, put);
            break;
          }
          put('furniture:' + p.kind, {
            x: p.x, y: p.y + p.sy / 2, z: p.z,
            sx: p.sx, sy: p.sy, sz: p.sz, rot: 0,
          });
          break;
        case PROP_CONTAINER:
          if (p.model) break;   // drawn by models.js, into this same collider
          put('container:' + (Math.floor(p.seed * 5) % 5), {
            x: p.x, y: p.y + p.sy / 2, z: p.z,
            sx: p.sx, sy: p.sy, sz: p.sz, rot: 0,
          });
          break;
        case PROP_BARREL:
          if (p.model) break;   // drawn by models.js
          barrels[Math.floor(p.seed * 3) % 3].push(p);
          break;
        case PROP_DOOR:
          this._buildDoor(p);
          break;
        default:
          break;   // trees, rocks and crates belong to the outdoor renderer
      }
    }

    // Trim is derived here, from the same records the solid geometry came
    // from, so it can never disagree with where a wall or door actually is.
    this._addTrim(boxes, put);
    for (const r of this.world.plan?.rooms ?? []) {
      if (!r.parkourSign) continue;
      const canvas = document.createElement('canvas');
      canvas.width = 1024; canvas.height = 256;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = r.parkourTheme?.color ?? '#d9dbc9'; ctx.fillRect(0, 0, 1024, 256);
      ctx.fillStyle = '#28332e'; ctx.font = 'bold 58px monospace';
      ctx.fillText(r.label, 38, 78);
      ctx.font = '28px monospace';
      ctx.fillText('HOLD JUMP + MOVE / CHAIN HOPS', 38, 134);
      ctx.fillText('RUN ALONG WALL / TAP JUMP TO TRANSFER', 38, 181);
      ctx.font = '22px monospace';ctx.fillText(`${r.parkourLevels} LEVELS / ${r.parkourTheme?.shape.toUpperCase() ?? 'DISTRICT'}`,38,231);
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      const mat = this._track(new THREE.MeshBasicMaterial({ map }));
      mat.userData.ownedMap = true;
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.25, 0.8125), mat);
      sign.position.set(r.parkourSign.x, r.parkourSign.y, r.parkourSign.z);
      this._add(sign);
    }

    // Architecture is merged, not instanced: a chamfer and a world-scale UV
    // both need the piece's real size, and an instanced unit cube has neither.
    const merger = new Merger(64);
    for (const [key, items] of boxes) {
      const tile = TILE[key.split(':')[0]] ?? 1.0;
      // Trim is small and takes a finer chamfer; structure takes a coarser one.
      const bevel = (key === 'frame' || key === 'skirting' || key === 'board') ? 0.018 : 0.038;
      for (const it of items) {
        merger.addBox(key, { ...it, tile, bevel });
      }
    }
    this._addRelief(merger);

    const sharedMaterials=new Map();
    for (const [key, geo] of merger.build()) {
      const materialKey=geo.userData.materialKey??key;
      if(!sharedMaterials.has(materialKey))sharedMaterials.set(materialKey,this._track(standard(this._spec(materialKey))));
      const mesh = new THREE.Mesh(geo, sharedMaterials.get(materialKey));
      this._add(mesh);
    }

    const barrelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.88, 12);
    barrels.forEach((items, i) => {
      if (!items.length) return;
      const m = this._track(standard({ color: BARREL_COLOURS[i], roughness: 0.55, metalness: 0.35 }));
      const mesh = new THREE.InstancedMesh(barrelGeo, m, items.length);
      const mtx = new THREE.Matrix4();
      items.forEach((p, k) => {
        mtx.compose(
          new THREE.Vector3(p.x, p.y + 0.44, p.z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.rot, 0)),
          new THREE.Vector3(1, 1, 1),
        );
        mesh.setMatrixAt(k, mtx);
      });
      this._add(mesh);
    });
  }

  /**
   * Build a domestic silhouette from small fitted parts inside one collider.
   *
   * These are intentionally recognisable objects rather than labelled cuboids:
   * mattress and pillow, sofa arms, chair backs, toilet tank, refrigerator
   * doors. The authored collider remains the simple outer box used by physics.
   */
  _putHumanEnclosure(p, put) {
    const yaw = p.rot ?? 0;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const add = (material, lx, ly, lz, sx, sy, sz, localYaw = 0) => {
      put(`habitat:${material}`, {
        x: p.x + lx * c + lz * s,
        y: p.y + ly,
        z: p.z - lx * s + lz * c,
        sx, sy, sz, rot: yaw + localYaw,
      });
    };
    const legs = (w, d, h, size = 0.07, material = 'wood') => {
      for (const x of [-w / 2 + size, w / 2 - size]) {
        for (const z of [-d / 2 + size, d / 2 - size]) {
          add(material, x, h / 2, z, size, h, size);
        }
      }
    };
    const chair = (x, z, turn = 0) => {
      const alongX = Math.abs(Math.sin(turn)) > 0.5;
      const cw = alongX ? 0.48 : 0.44;
      const cd = alongX ? 0.44 : 0.48;
      add('wood', x, 0.44, z, cw, 0.11, cd, turn);
      add('fabric', x, 0.51, z, cw * 0.88, 0.08, cd * 0.82, turn);
      const backZ = z - Math.cos(turn) * 0.20;
      const backX = x - Math.sin(turn) * 0.20;
      add('wood', backX, 0.70, backZ, cw, 0.50, 0.08, turn);
      for (const dx of [-0.17, 0.17]) {
        for (const dz of [-0.17, 0.17]) {
          const ox = x + dx * Math.cos(turn) + dz * Math.sin(turn);
          const oz = z - dx * Math.sin(turn) + dz * Math.cos(turn);
          add('wood', ox, 0.20, oz, 0.055, 0.40, 0.055);
        }
      }
    };

    const w = p.sx, d = p.sz;
    switch (p.enclosureShape) {
      case 'bed':
        add('wood', 0, 0.22, 0, w, 0.14, d);
        add('linen', 0, 0.42, 0.03, w * 0.95, 0.27, d * 0.88);
        add('linen', 0, 0.61, -d * 0.28, w * 0.45, 0.12, d * 0.25);
        add('wood', 0, 0.45, -d * 0.47, w, 0.82, 0.08);
        legs(w, d, 0.20, 0.08, 'wood');
        break;
      case 'wardrobe':
        add('wood', 0, p.sy * 0.49, 0, w, p.sy * 0.98, d);
        add('accent', -w * 0.245, p.sy * 0.50, d * 0.505, w * 0.47, p.sy * 0.91, 0.035);
        add('accent', w * 0.245, p.sy * 0.50, d * 0.505, w * 0.47, p.sy * 0.91, 0.035);
        add('metal', -0.055, p.sy * 0.50, d * 0.54, 0.025, 0.16, 0.025);
        add('metal', 0.055, p.sy * 0.50, d * 0.54, 0.025, 0.16, 0.025);
        break;
      case 'sofa':
        add('wood', 0, 0.10, 0, w * 0.86, 0.20, d * 0.68);
        add('fabric', 0, 0.25, 0.03, w, 0.38, d * 0.82);
        add('fabric', 0, 0.48, d * 0.09, w * 0.82, 0.18, d * 0.57);
        add('fabric', 0, 0.67, -d * 0.34, w, 0.43, d * 0.20);
        for (const x of [-w * 0.45, w * 0.45]) add('fabric', x, 0.48, 0.05, w * 0.10, 0.42, d * 0.76);
        break;
      case 'armchair':
        add('wood', 0, 0.10, 0, w * 0.72, 0.20, d * 0.66);
        add('accent', 0, 0.28, 0.04, w * 0.82, 0.40, d * 0.78);
        add('accent', 0, 0.50, d * 0.10, w * 0.60, 0.16, d * 0.52);
        add('accent', 0, 0.70, -d * 0.34, w * 0.84, 0.42, d * 0.18);
        for (const x of [-w * 0.43, w * 0.43]) add('accent', x, 0.48, 0.06, w * 0.14, 0.40, d * 0.72);
        break;
      case 'coffee_table':
        add('wood', 0, p.sy - 0.065, 0, w, 0.13, d);
        legs(w * 0.82, d * 0.75, p.sy - 0.12, 0.065, 'metal');
        break;
      case 'television':
        add('wood', 0, 0.25, 0, w, 0.50, d);
        add('metal', 0, 0.60, 0, 0.12, 0.28, 0.12);
        add('appliance', 0, 0.90, 0, w * 0.90, 0.58, 0.10);
        add('screen', 0, 0.90, d * 0.16, w * 0.82, 0.49, 0.025);
        break;
      case 'dining_set': {
        const tableW = w * 0.68, tableD = d * 0.48;
        add('wood', 0, 0.73, 0, tableW, 0.13, tableD);
        legs(tableW * 0.84, tableD * 0.72, 0.67, 0.065, 'wood');
        chair(0, -d * 0.35, Math.PI);
        chair(0, d * 0.35, 0);
        break;
      }
      case 'toilet':
        add('ceramic', 0, 0.22, d * 0.08, w * 0.62, 0.42, d * 0.66);
        add('ceramic', 0, 0.47, d * 0.06, w * 0.76, 0.12, d * 0.70);
        add('ceramic', 0, 0.58, -d * 0.34, w * 0.84, 0.40, d * 0.22);
        add('screen', 0, 0.55, d * 0.08, w * 0.62, 0.035, d * 0.52);
        break;
      case 'sink':
        add('ceramic', 0, 0.45, 0, w * 0.42, 0.90, d * 0.45);
        add('ceramic', 0, 0.91, d * 0.05, w, 0.18, d * 0.86);
        add('metal', 0, 1.06, -d * 0.10, 0.05, 0.25, 0.05);
        add('screen', 0, p.sy - 0.18, -d * 0.48, w * 0.82, 0.32, 0.025);
        break;
      case 'refrigerator':
        add('appliance', 0, p.sy * 0.5, 0, w, p.sy, d);
        add('linen', 0, p.sy * 0.66, d * 0.505, w * 0.94, p.sy * 0.62, 0.035);
        add('linen', 0, p.sy * 0.18, d * 0.505, w * 0.94, p.sy * 0.28, 0.035);
        add('metal', w * 0.34, p.sy * 0.63, d * 0.54, 0.035, 0.38, 0.035);
        break;
      default:
        add('appliance', 0, p.sy / 2, 0, w, p.sy, d);
        break;
    }
  }

  /**
   * Doorframes and skirting.
   *
   * The single biggest reason an interior reads as Minecraft is that every
   * surface meets every other at a bare 90-degree corner. Real rooms have a
   * line where the wall meets the floor and a frame around every opening, and
   * those lines are what your eye uses to read a space as built rather than
   * extruded. They are also cheap: two more instanced boxes per opening.
   */
  _addTrim(boxes, put) {
    const rooms = this.world.plan?.rooms ?? [];

    // ---- doorframes: a jamb each side and a lintel over --------------
    for (const p of this.world.props) {
      if (p.type !== PROP_DOOR && p.type !== 'doorway') continue;
      const alongX = p.sx > p.sz;
      const t = (alongX ? p.sz : p.sx) + TRIM_PROUD * 2;
      const jamb = 0.12;
      const h = p.sy + 0.1;

      for (const side of [-1, 1]) {
        put('frame', {
          x: alongX ? p.x + side * (p.sx / 2 + jamb / 2) : p.x,
          y: p.y + h / 2,
          z: alongX ? p.z : p.z + side * (p.sz / 2 + jamb / 2),
          sx: alongX ? jamb : t, sy: h, sz: alongX ? t : jamb, rot: 0,
        });
      }
      put('frame', {
        x: p.x, y: p.y + h + jamb / 2, z: p.z,
        sx: (alongX ? p.sx + jamb * 2 : t),
        sy: jamb,
        sz: (alongX ? t : p.sz + jamb * 2),
        rot: 0,
      });
    }

    // ---- skirting: a line where wall meets floor ---------------------
    //
    // On every floor, not just the ground one. A storey with no line where its
    // wall meets its floor is the storey that reads as unfinished: the eye uses
    // that line to tell a room from a box, and an upper floor without it looks
    // like the building was extruded and then cut.
    for (const r of rooms) {
      if (r.outdoor) continue;             // a yard has no skirting board
      const inset = 0.02;
      for (const level of levelsOf(r)) {
        const y = level + 0.07;
        const runs = [
          { x: r.cx, z: r.minZ + inset, sx: r.maxX - r.minX, sz: 0.09 },
          { x: r.cx, z: r.maxZ - inset, sx: r.maxX - r.minX, sz: 0.09 },
          { x: r.minX + inset, z: r.cz, sx: 0.09, sz: r.maxZ - r.minZ },
          { x: r.maxX - inset, z: r.cz, sx: 0.09, sz: r.maxZ - r.minZ },
        ];
        for (const run of runs) put('skirting', { ...run, y, sy: 0.14, rot: 0 });
      }
    }
  }

  /** Material description for a merge key. */
  _spec(key) {
    let spec = MATERIALS[key];
    if (!spec) {
      if (key.startsWith('habitat:')) {
        spec = HABITAT_SPECS[key.slice('habitat:'.length)] ?? HABITAT_SPECS.appliance;
      } else if (key.startsWith('furniture:')) {
        const kind = key.slice('furniture:'.length);
        const hex = FURNITURE_COLOURS[kind] ?? 0x8a7a66;
        const wooden = WOODEN.has(kind);
        spec = {
          color: 0xffffff,
          roughness: wooden ? 0.85 : 0.62,
          // Painted steel, not bare. A metalness that high has almost no
          // diffuse response, so a locker lit by lamps rather than by a bright
          // environment renders as a black slab -- which is what the shelves
          // were doing.
          metalness: wooden ? 0.05 : 0.14,
          surf: wooden ? 'wood' : 'metal',
          repeat: wooden ? 1 : 1.2,
          tint: [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255],
        };
      } else if (key.startsWith('container:')) {
        const hex = CONTAINER_COLOURS[Number(key.slice('container:'.length))];
        spec = {
          color: 0xffffff, roughness: 0.7, metalness: 0.3,
          surf: 'metal', repeat: 2,
          tint: [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255],
        };
      } else {
        spec = { color: 0x888888 };
      }
    }

    return spec;
  }

  /**
   * Architectural relief.
   *
   * A room bounded by four flat planes reads as a box however well it is
   * textured, because nothing breaks the run of the wall and nothing marks
   * where the wall stops. Pilasters give the wall a rhythm, a cornice gives it
   * a top, and a run of pipe across the ceiling gives the space a function.
   * None of it collides -- it is all shallow enough to stand inside the wall.
   */
  _addRelief(merger) {
    const rooms = this.world.plan?.rooms ?? [];

    for (const r of rooms) {
      const w = r.maxX - r.minX, d = r.maxZ - r.minZ;

      // Storey by storey. Relief that spans three floors in one piece is not
      // relief, it is a stripe: a pilaster is read against the height of the
      // room it stands in, and a cornice only means anything where a wall
      // actually stops.
      const levels = r.outdoor ? [r.floorY] : levelsOf(r);

      for (let k = 0; k < levels.length; k++) {
        const floorY = levels[k];
        const ceil = r.outdoor
          ? floorY + 2.6
          : Math.min(floorY + FLOOR_H, r.floorY + FLOOR_H * (r.storeys ?? 1));

        // ---- pilasters: shallow piers at a regular pitch --------------
        //
        // On a regular pitch, and NOT across an opening. A pier is a thickening
        // of a wall, so one that lands where the wall has a hole in it is a
        // post standing in the middle of the doorway -- decoration you walk
        // into, and on this map a doorway you have paid to open. The pitch
        // gives way to the opening rather than the other way round: skip that
        // bay and the rhythm reads as a wider bay, which is what a real
        // building does over a door anyway.
        const pitch = 4.2;
        const depth = 0.16, wide = 0.5;
        for (const [along, fixed, axis] of [
          [w, r.minZ, 'z0'], [w, r.maxZ, 'z1'], [d, r.minX, 'x0'], [d, r.maxX, 'x1'],
        ]) {
          const n = Math.max(1, Math.round(along / pitch) - 1);
          for (let i = 1; i <= n; i++) {
            const t = (i / (n + 1)) * along;
            const horiz = axis.startsWith('z');
            const x = horiz ? r.minX + t : fixed + (axis === 'x0' ? depth / 2 : -depth / 2);
            const z = horiz ? fixed + (axis === 'z0' ? depth / 2 : -depth / 2) : r.minZ + t;
            if (this._inOpening(x, z, wide / 2 + 0.25)) continue;
            merger.addBox('pilaster', {
              x, y: floorY + (ceil - floorY) / 2, z,
              sx: horiz ? wide : depth, sy: ceil - floorY, sz: horiz ? depth : wide,
              tile: TILE.pilaster, bevel: 0.03,
            });
          }
        }

        if (r.outdoor) continue;

        // ---- cornice: a band where the wall meets the ceiling ---------
        const cy = ceil - 0.13;
        const cs = 0.22;
        for (const run of [
          { x: r.cx, z: r.minZ + cs / 2, sx: w, sz: cs },
          { x: r.cx, z: r.maxZ - cs / 2, sx: w, sz: cs },
          { x: r.minX + cs / 2, z: r.cz, sx: cs, sz: d },
          { x: r.maxX - cs / 2, z: r.cz, sx: cs, sz: d },
        ]) {
          merger.addBox('cornice', { ...run, y: cy, sy: 0.2, tile: TILE.cornice, bevel: 0.025 });
        }

        // ---- services: pipe runs under the ceiling --------------------
        const along = w >= d;
        const pipeY = ceil - 0.4;
        for (let j = 0; j < 2; j++) {
          const off = (j - 0.5) * 0.62;
          const geo = new THREE.CylinderGeometry(0.09, 0.09, along ? w - 0.6 : d - 0.6, 10, 1);
          geo.rotateZ(along ? Math.PI / 2 : 0);
          if (!along) geo.rotateX(Math.PI / 2);
          geo.translate(
            along ? r.cx : r.cx + off,
            pipeY,
            along ? r.cz + off : r.cz,
          );
          merger.add('pipe', geo);
        }
      }
    }
  }

  /**
   * Is this point in the mouth of a doorway?
   *
   * Read off the plan's links rather than off the emitted geometry, because a
   * doorway is an *absence* -- the gap between two wall segments -- and there
   * is no prop standing there to test against. Bought doors and open thresholds
   * both count: a doorway you have not opened yet is still a doorway, and the
   * pier would still be in the middle of it once you had.
   */
  _inOpening(x, z, margin) {
    const links = this.world.plan?.links ?? [];
    for (const l of links) {
      const mid = doorwayCenter(l);
      const half = DOOR_W / 2 + margin;
      if (l.axis === 'x') {
        if (Math.abs(x - l.at) < margin + 0.4 && Math.abs(z - mid) < half) return true;
      } else if (Math.abs(z - l.at) < margin + 0.4 && Math.abs(x - mid) < half) {
        return true;
      }
    }
    return false;
  }

  /**
   * One board across a window, kept addressable so it can be torn off.
   *
   * Its rest pose is remembered rather than read back off the mesh, because
   * the shake writes to the same transform every frame and a pose derived from
   * a shaken mesh drifts.
   */
  _buildBoard(p) {
    if (!this.boardMat) {
      this.boardMat = this._track(standard(MATERIALS.board));
    }
    const mesh = new THREE.Mesh(
      chamferedBox(p.sx, p.sy, p.sz, 0.018, TILE.board),
      this.boardMat,
    );
    const rest = new THREE.Vector3(p.x, p.y + p.sy / 2, p.z);
    mesh.position.copy(rest);
    mesh.userData.rest = rest;
    this._add(mesh);
    this.boardMeshes.set(p, mesh);
  }

  /** Take a board that has been prised off out of the scene. */
  removeBoard(p) {
    const mesh = this.boardMeshes.get(p);
    if (!mesh) return null;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    this.boardMeshes.delete(p);
    const i = this.objects.indexOf(mesh);
    if (i >= 0) this.objects.splice(i, 1);
    return mesh.userData.rest;
  }

  /** Nail one back up. */
  restoreBoard(p) {
    if (this.boardMeshes.has(p)) return;
    this._buildBoard(p);
  }

  /**
   * Bring the boards on screen into line with the boards in the simulation,
   * and shake whichever one is being prised at.
   *
   * Driven by the barriers themselves rather than by events, for two reasons.
   * Being worked on is a *state* that lasts a second and a half, not a moment,
   * so there is nothing an event could carry that would keep a plank shaking.
   * And a barrier that was repaired, or one whose boards came off on a server
   * in a co-op game, is reconciled by the same pass -- there is no sequence of
   * events that can be missed and leave a board on screen that a bullet passes
   * straight through.
   *
   * @param onBreak called with the world position of each board that has just
   *                gone, for the splinters and the noise
   */
  syncBoards(barriers, time, onBreak = null) {
    if (!barriers) return;
    for (const b of barriers) {
      for (const board of b.broken) {
        const rest = this.removeBoard(board);
        if (rest) onBreak?.(rest);
      }
      for (const board of b.boards) this.restoreBoard(board);

      // The one being prised is always the lowest still standing: a barrier is
      // torn from the bottom, because the bottom board is the one in the way of
      // climbing through.
      const board = b.boards[0];
      const mesh = board && this.boardMeshes.get(board);
      if (!mesh) continue;
      const rest = mesh.userData.rest;
      if (!b.working) {
        mesh.position.copy(rest);
        mesh.rotation.set(0, 0, 0);
        continue;
      }
      // Amplitude rises with progress, so a barrier about to give reads as one
      // about to give.
      const amp = 0.02 + b.progress * 0.06;
      mesh.position.set(
        rest.x + Math.sin(time * 41) * amp,
        rest.y + Math.sin(time * 33) * amp * 0.6,
        rest.z + Math.cos(time * 37) * amp,
      );
      mesh.rotation.z = Math.sin(time * 29) * (0.02 + b.progress * 0.07);
    }
  }

  /** One shutter, kept addressable so it can be removed on purchase. */
  _buildDoor(p) {
    const m = this._track(standard(MATERIALS[p.material] ?? MATERIALS.door));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.sx, p.sy, p.sz), m);
    mesh.position.set(p.x, p.y + p.sy / 2, p.z);
    this._add(mesh);
    this.doorMeshes.set(p, mesh);
  }

  /** Take a bought door out of the scene. */
  removeDoor(p) {
    const mesh = this.doorMeshes.get(p);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    const mi = this.materials.indexOf(mesh.material);
    if (mi >= 0) this.materials.splice(mi, 1);
    this.doorMeshes.delete(p);
    const i = this.objects.indexOf(mesh);
    if (i >= 0) this.objects.splice(i, 1);
  }

  /** Reconcile shutters after a restart restores their world props. */
  syncDoors(doors) {
    const wanted = new Set(doors ?? []);
    for (const door of [...this.doorMeshes.keys()]) {
      if (!wanted.has(door)) this.removeDoor(door);
    }
    for (const door of wanted) {
      if (!this.doorMeshes.has(door)) this._buildDoor(door);
    }
  }

  /** Build the hidden cache panel as removable wall geometry. */
  _buildSecret(p) {
    const m = this._track(standard(MATERIALS.secret));
    const mesh = new THREE.Mesh(chamferedBox(p.sx, p.sy, p.sz, 0.038, TILE.secret), m);
    mesh.position.set(p.x, p.y + p.sy / 2, p.z);
    this._add(mesh);
    this.secretMeshes.set(p, mesh);
  }

  removeSecret(p) {
    const mesh = this.secretMeshes.get(p);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    const mi = this.materials.indexOf(mesh.material);
    if (mi >= 0) this.materials.splice(mi, 1);
    this.secretMeshes.delete(p);
    const i = this.objects.indexOf(mesh);
    if (i >= 0) this.objects.splice(i, 1);
  }

  /** Reconcile the cache panel when an old run is reset. */
  syncSecrets(panels) {
    const wanted = new Set(panels ?? []);
    for (const panel of [...this.secretMeshes.keys()]) {
      if (!wanted.has(panel)) this.removeSecret(panel);
    }
    for (const panel of wanted) {
      if (!this.secretMeshes.has(panel)) this._buildSecret(panel);
    }
  }

  _add(obj) {
    obj.castShadow = true;
    obj.receiveShadow = true;
    this.scene.add(obj);
    this.objects.push(obj);
    return obj;
  }

  _track(m) { this.materials.push(m); return m; }

  dispose() {
    for (const o of this.objects) {
      this.scene.remove(o);
      o.geometry?.dispose?.();
    }
    for (const m of this.materials) {
      if (m.userData.ownedMap) m.map?.dispose();
      m.dispose();
    }
    this.objects.length = 0;
    this.materials.length = 0;
    this.doorMeshes?.clear();
    this.boardMeshes?.clear();
    this.secretMeshes?.clear();
    this.boardMat = null;
  }
}

// One shared unit cube; every box instance is a scale of it.
let unitBox = null;
function UNIT_BOX() {
  if (!unitBox) unitBox = new THREE.BoxGeometry(1, 1, 1);
  return unitBox;
}
