export const DISTRICTS = [
  {name:'OLD CONCRETE QUARTER', material:'districtSand', floor:'districtSandFloor', levels:4, shape:'ruins', color:'#b6a071'},
  {name:'BOILER WORKS', material:'districtSteel', floor:'districtSteelFloor', levels:7, shape:'foundry', color:'#a5b5a7'},
  {name:'OVERGROWN TENEMENTS', material:'districtGarden', floor:'districtSandFloor', levels:5, shape:'garden', color:'#a4ad93'},
  {name:'BRICK WAREHOUSES', material:'districtBrick', floor:'districtSteelFloor', levels:6, shape:'mill', color:'#c4a397'},
  {name:'CIVIC TOWERS', material:'districtIvory', floor:'districtTile', levels:8, shape:'observatory', color:'#d6d3b9'},
  {name:'RESEARCH ANNEX', material:'districtViolet', floor:'districtTile', levels:6, shape:'labs', color:'#abaea5'},
  {name:'DRAINAGE WORKS', material:'districtBasalt', floor:'districtSandFloor', levels:3, shape:'quarry', color:'#a7aaa3'},
  {name:'FREIGHT TERMINAL', material:'districtTerminal', floor:'districtSteelFloor', levels:5, shape:'terminal', color:'#c4ad85'},
];

// Authored movement courtyards. All visible structure uses the same box records
// as collision, raycasting, nav and portals; the perimeter circulation stays open.
export function planParkour(plan) {
  if (plan.arena) return;
  const special = new Set(['start', 'dinosaur_factory', 'reverse_aquarium', 'rhythm_tower']);
  const candidates = plan.rooms.filter(r => !special.has(r.role?.id)
    && !(r.storeys > 1 && r.stairCorner >= 8)
    && r.maxX - r.minX >= 17 && r.maxZ - r.minZ >= 23)
    .sort((a, b) => a.depth - b.depth || b.area - a.area || a.id - b.id);
  // Keep an ordinary indoor room available for the roaming cat landmark.
  const sanctuary = candidates.filter(r => !r.outdoor).at(-1);
  for (const [i, r] of candidates.filter(r => r !== sanctuary).slice(0, DISTRICTS.length).entries()) {
    r.parkour = true;
    r.outdoor = true;
    r.storeys = 1;
    r.parkourTheme = DISTRICTS[i];
    r.parkourLevels = r.parkourTheme.levels;
    r.role = { ...r.role, id: 'parkour', name: r.parkourTheme.name };
    r.label = r.role.name;
  }
}

export function buildParkour(plan, out) {
  plan.parkourDecor = [];
  for (const r of plan.rooms.filter(r => r.parkour)) {
    const y = r.floorY;
    const theme = r.parkourTheme, height = (r.parkourLevels - 1) * 5 + 4;
    const x0 = r.minX + 4, x1 = r.maxX - 4;
    const z0 = r.minZ + 5, z1 = r.maxZ - 5;
    const box = (name, x, bottom, z, sx, sy, sz, material = theme.material, solid = true) => {
      const p = { type: 'wallseg', parkour: true, name, room: r.id,
        x, y: y + bottom, z, sx, sy, sz, height: sy, rot: 0, scale: 1, material };
      if (solid) p.collider = { kind: 'box', minX: x - sx / 2, maxX: x + sx / 2,
        minY: p.y, maxY: p.y + sy, minZ: z - sz / 2, maxZ: z + sz / 2 };
      (solid ? out : plan.parkourDecor).push(p);
      return p;
    };
    // Parallel monoliths support a full wall run and readable portal targets.
    if(['ruins','garden','quarry','terminal'].includes(theme.shape)) {
      const bays=6, span=(z1-z0)/bays;
      for(let bay=0;bay<bays;bay++)box('stepped-west-wall',x0,0,z0+(bay+.5)*span,
        .8,Math.max(4,height-(bay%3)*4),span);
    } else box('west-run-wall', x0, 0, (z0 + z1) / 2, 0.6, height, z1 - z0);
    box('east-run-wall', x1, 0, (z0 + z1) / 2, 0.6, height + 2, z1 - z0);
    // Three one-metre rises teach hopping, then a bridge gives a drop-to-fling.
    for (let i = 0; i < 3; i++) {
      const z = z1 - 0.9 - i * 2.15;
      box('hop-plinth', x0 + 2, 0, z, 2.6, (i + 1) * .6, 1.9);
    }
    // Varied-height districts surround an open atrium. Each floor has a continuous
    // loop and a real stair flight, so height is reachable without teleporting.
    const stairX = x1 - 2;
    const stairStart = z1 - 2;
    const stairRun = Math.min(12, z1 - z0 - 5);
    r.parkourLandings = [{ x: r.cx, y, z: z1 + 2 }];
    for (let level = 1; level < r.parkourLevels; level++) {
      const deck = level * 5;
      // North/south balconies join a broad west promenade. East remains an
      // open stairwell; no slab can block a player's head while climbing.
      box('west-balcony', x0 + 1.8, deck - .3, (z0 + z1) / 2, 3, .3, z1 - z0);
      box('north-balcony', r.cx, deck - .3, z0 + 1.3, x1 - x0 - .6, .3, 2.6);
      box('south-balcony', r.cx, deck - .3, z1 - .6, x1 - x0 - .6, .3, 2.6);
      box('stair-head-landing', stairX, deck - .3, stairStart - stairRun - .7,
        2.8, .3, 1.8);
      box('stair-head-link', stairX, deck - .3, (z0 + stairStart - stairRun) / 2,
        2.8, .3, Math.max(1, stairStart - stairRun - z0));
      for (let step = 0; step < 20; step++) {
        const rise = (step + 1) * .25;
        box('district-stair', stairX, deck - 5 + rise - .25, stairStart - (step + .5) * stairRun / 20,
          2.4, .25, stairRun / 20 + .015, theme.floor);
      }
      // Bridges alternate position and width; the central shaft stays open
      // from the roof to the ground for floor-portal momentum launches.
      if (level % (theme.shape==='foundry'?1:2) === 0) box('sky-bridge', r.cx, deck - .3,
        theme.shape==='labs' ? z0+(z1-z0)*.4 : z1-3.2,
        x1 - x0 - .6, .3, theme.shape==='garden'?4:2.4);
      box('upper-portal-panel', r.cx, deck, z0 + .2, 3.6, 3.7, .4, theme.material);
      r.parkourLandings.push({x:r.cx, y:y+deck, z:z1-.5});
    }
    // Vertical portal plate at the head of a broad, unobstructed lane.
    const plate = box('portal-target', r.cx, 0, z0, 3.6, 4.4, 0.5, theme.material);
    r.parkourSign = { x: plate.x, y: y + 3.6, z: z0 + 0.27 };
    r.parkourEntry = { x: r.cx, y, z: z1 + 2 };
    r.portalProbe = { x: x1 - 1, y, z: z1 - 1 };
    // City blocks flank the narrow movement alleys. Setbacks, service roofs
    // and distinct heights give the skyline a building scale without closing
    // the central portal lane, perimeter stairs, or cross-street openings.
    const depth=z1-z0;
    const count=Math.max(3,Math.min(7,Math.floor(depth/9)));
    for(let i=0;i<count;i++) {
      const z=z0+7+i*(depth-16)/Math.max(1,count-1);
      for(const side of [-1,1]) {
        const x=r.cx+side*7;
        const storeys=2+(i*3+(side+1)+r.id)%Math.max(2,r.parkourLevels-1);
        const h=storeys*4.2;
        box('city-block',x,0,z,4.8,h,4.8);
        // Upper setback remains within the footprint: roof access is real
        // collision and decoration never intrudes into a running corridor.
        if((i+r.id+side)%3!==0)box('setback-storey',x+.25*side,h,z,3.5,3.8,3.6);
        const roof=h+((i+r.id+side)%3!==0?3.8:0);
        box('roof-service-housing',x,roof,z,1.8,1.1,1.4,'districtSteelFloor');
        if(theme.shape==='mill'||theme.shape==='foundry')
          box('exhaust-stack',x+.9,roof,z+.8,.5,3.4,.5,'districtBrick');
        if(theme.shape==='garden')
          box('roof-moss',x,roof+.02,z-1.3,3,.07,.6,'districtLeaves',false);
        // Concrete plinth and lintel give street-level doors a believable scale.
        box('service-door',x,.1,z+2.408,1.2,2.35,.018,'urbanDoor',false);
        box('door-lintel',x,2.5,z+2.4,1.55,.16,.18,theme.material,false);
      }
    }

  }
  buildWallRunRoutes(plan,out);
  dressCityFacades(plan,out);
}

/** Closely spaced wall pairs turn open ground into repeatable movement lines.
 * Crossings every 13 metres keep doors and lateral routes reachable. */
function buildWallRunRoutes(plan,out) {
  if(plan.arena)return;
  const special=new Set(['start','dinosaur_factory','reverse_aquarium','rhythm_tower']);
  for(const room of plan.rooms) {
    room.wallRunLanes=[];
    if(special.has(room.role?.id))continue;
    const gap=4.2, thickness=room.parkour?2.4:.45;
    const minZ=room.minZ+10,maxZ=room.maxZ-10;
    const material=room.parkourTheme?.material??'parkourConcrete';
    const height=room.parkour?Math.max(4.2,(room.parkourLevels-1)*5+3.8):3.5;
    const centers=[room.cx-14,room.cx,room.cx+14]
      .filter(x=>x-gap/2>room.minX+8&&x+gap/2<room.maxX-8);
    // Snapshot excludes walls from this pass; neighboring segments are intended.
    const obstacles=out.filter(p=>p.room===room.id&&!p.parkour&&p.collider?.kind==='box');
    for(const x of centers)for(let z=minZ;z+7<=maxZ;z+=13) {
      const end=Math.min(z+10,maxZ);
      const overlaps=p=>{
        const c=p.collider;
        return c.maxY>room.floorY+.1 && c.minY<room.floorY+3.5
          && c.minX<x+gap/2+thickness+.5 && c.maxX>x-gap/2-thickness-.5
          && c.minZ<end+.5 && c.maxZ>z-.5;
      };
      const clutter=new Set(['shelf','table','desk','locker','bench','chair','cabinet']);
      if(!room.parkour) {
        const blocked=obstacles.filter(overlaps);
        if(blocked.some(p=>p.model||!clutter.has(p.kind)))continue;
        // Ordinary decorative furniture yields to the clear movement aisle;
        // interactive props, staircases, and structural walls are preserved.
        for(const prop of blocked){const index=out.indexOf(prop);if(index>=0)out.splice(index,1);}
      }
      const skylineStep=((Math.floor((z-minZ)/13)+Math.round((x-room.cx)/14)+3)%3)*4.2;
      const segmentHeight=room.parkour?Math.max(8.4,height-skylineStep):height;
      for(const side of [-1,1]) {
        const cx=x+side*(gap/2+thickness/2);
        out.push({type:'wallseg',name:'wall-run-spine',parkour:true,room:room.id,
          x:cx,y:room.floorY,z:(z+end)/2,sx:thickness,sy:segmentHeight,sz:end-z,
          height:segmentHeight,rot:0,scale:1,material,
          collider:{kind:'box',minX:cx-thickness/2,maxX:cx+thickness/2,
            minY:room.floorY,maxY:room.floorY+segmentHeight,minZ:z,maxZ:end}});
      }
      room.wallRunLanes.push({x,z0:z,z1:end,y:room.floorY,gap,height:segmentHeight});
    }
  }
}

/** Shared opaque facade sheets add windows, joints and rain staining to the
 * upper city. Their 8mm relief cannot catch a runner or hide a portal. They
 * merge into spatial batches, with no transparent sorting or extra lights. */
function dressCityFacades(plan,out) {
  for(const p of out) {
    if(!p.parkour || p.sy<8 || !['city-block','wall-run-spine','west-run-wall',
      'east-run-wall','stepped-west-wall'].includes(p.name))continue;
    const material=['urbanFacade','urbanFacadeOchre','urbanFacadeGreen'][p.room%3];
    const bottom=p.y+4.2, h=Math.floor((p.sy-4.2)/4.2)*4.2;
    if(h<4.2)continue;
    const add=(x,z,sx,sz)=>plan.parkourDecor.push({
      type:'wallseg',name:'weathered-facade',parkour:true,room:p.room,
      x,y:bottom,z,sx,sy:h,sz,material,rot:0,scale:1,height:h,
    });
    // Window pattern runs at a constant physical size on both orientations.
    if(p.sz>3)for(const side of [-1,1])add(p.x+side*(p.sx/2+.004),p.z,.008,p.sz-.12);
    if(p.sx>3)for(const side of [-1,1])add(p.x,p.z+side*(p.sz/2+.004),p.sx-.12,.008);
  }
}
