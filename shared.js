/* =====================================================================
   DISASTER DELIVERY — shared game rules
   Imported by BOTH the browser (index.html) and the Colyseus server
   (server.js). Everything that must give identical results on both
   sides lives here: the deterministic city layout, colliders, ground
   height, the movement step used for prediction + authority, and the
   gameplay constants. No Three.js, no DOM, no Node APIs.
   ===================================================================== */

export const PROTOCOL_VERSION = 3;

export const NET = {
  tickRate: 30,                 // fixed simulation steps per second (client + server)
  fixedDt: 1 / 30,
  patchRateMs: 50,              // Colyseus state patches (20 Hz)
  maxInputsPerMessage: 6,
  inputQueueCap: 24,
  inputBudgetCap: 5,            // server may catch up at most this many steps after jitter
  interpolationDelayMs: 110     // remote players are rendered this far in the past
};

export const GAME = {
  maxPlayers: 6,
  matchSeconds: 240,
  intermissionSeconds: 12,
  lateJoinWindowSeconds: 45,    // joining later than this into a running match → spectate until next round
  reconnectSeconds: 20,
  maxPackages: 6,
  packageRespawnSeconds: 3,
  pickupRadius: 2.4,
  deliveryRadius: 4.5,
  interactCooldownMs: 250,
  emoteCooldownMs: 1500
};

/* ---------------------------------------------------------------------
   PACKAGES — configurable delivery table
   reward: base points · weight: WEIGHT_CLASSES key · fragile: takes knock
   damage · waterSensitive: damaged by flood water while on the ground or in
   an open truck bed · spawnWeight: relative spawn chance · model: GLB key
   --------------------------------------------------------------------- */
export const WEIGHT_CLASSES = {
  light:     { label: 'Light',      speedMul: 1.0,  canSprint: true,  slots: 1, onFoot: true,  tornadoPush: 1.0 },
  medium:    { label: 'Medium',     speedMul: 0.85, canSprint: true,  slots: 1, onFoot: true,  tornadoPush: 0.5 },
  heavy:     { label: 'Heavy',      speedMul: 0.6,  canSprint: false, slots: 2, onFoot: true,  tornadoPush: 0.15 },
  veryheavy: { label: 'Very heavy', speedMul: 0,    canSprint: false, slots: 3, onFoot: false, tornadoPush: 0 }
};
export const PACKAGE_TYPES = {
  box:       { label: 'Box',          model: 'box',          reward: 100,  weight: 'light',     fragile: false, waterSensitive: false, spawnWeight: 30 },
  groceries: { label: 'Groceries',    model: 'groceriesbox', reward: 150,  weight: 'light',     fragile: true,  waterSensitive: true,  spawnWeight: 22 },
  crate:     { label: 'Wooden crate', model: 'woodenbox',    reward: 250,  weight: 'medium',    fragile: false, waterSensitive: false, spawnWeight: 16 },
  aquarium:  { label: 'Aquarium',     model: 'aquarium',     reward: 650,  weight: 'medium',    fragile: true,  waterSensitive: false, spawnWeight: 9 },
  sofa:      { label: 'Sofa',         model: 'sofa',         reward: 500,  weight: 'heavy',     fragile: false, waterSensitive: true,  spawnWeight: 9 },
  piano:     { label: 'Piano',        model: 'piano',        reward: 900,  weight: 'veryheavy', fragile: true,  waterSensitive: true,  spawnWeight: 7 },
  vip:       { label: 'VIP box',      model: 'vipbox',       reward: 1200, weight: 'medium',    fragile: true,  waterSensitive: true,  spawnWeight: 4 }
};
export const CONDITION = {
  dropSpeedThreshold: 7,       // dropping while moving faster than this damages fragile cargo
  dropDamage: 12,
  groundReturnSeconds: 60,     // a package left on the ground away from the depot returns to a free pad
  brokenRespawnSeconds: 3
};
export function packageDef(type) { return PACKAGE_TYPES[type] || PACKAGE_TYPES.box; }
export function weightOf(type) { return WEIGHT_CLASSES[packageDef(type).weight] || WEIGHT_CLASSES.light; }
export function conditionLabel(c) { return c <= 0 ? 'Broken' : c < 50 ? 'Severely damaged' : c < 80 ? 'Damaged' : 'Excellent'; }
/* finalReward = basePoints * (0.5 + 0.5 * condition / 100); broken = 0 */
export function deliveryReward(base, condition) {
  if (condition <= 0) return 0;
  return Math.round(base * (0.5 + 0.5 * Math.min(100, condition) / 100));
}

/* ---------------------------------------------------------------------
   DISASTERS — schedule is written for a 240 s match and scaled to the
   configured match length. Types are picked by the server per slot.
   --------------------------------------------------------------------- */
export const DISASTER = {
  types: ['tornado', 'flood'],          // future: 'earthquake', 'storm', ...
  baseMatchSeconds: 240,
  schedule: [
    { warn: 40,  start: 50,  end: 80 },
    { warn: 110, start: 120, end: 155 },
    { warn: 180, start: 190, end: 225 }
  ],
  recoverySeconds: 6,
  tornado: {
    speed: 6.5, pushRadius: 13, dangerRadius: 6, coreRadius: 3,
    force: 26, maxImpulse: 9, protectSeconds: 2.5,
    carryDamagePerSec: { fragile: 30, normal: 6 },
    knockDamage: { fragile: 15, normal: 4 },
    groundPushSpeed: 3.2, groundMaxDisplacement: 8, groundFragileDamagePerSec: 6,
    vehicleForce: 6, vehicleCargoDamagePerSec: 10
  },
  flood: {
    zonesPerEvent: 3, riseSeconds: 4,
    walkMul: { shallow: 0.55, deep: 0.4 },
    vehicleMul: 0.7,                     // shallow water
    deepBlocksVehicles: true,
    depth: { shallow: 0.35, deep: 0.9 },
    groundDamagePerSec: 8                // water-sensitive packages lying in water
  }
};

/* Predefined flood areas (road segments). Unique ids; server picks which flood. */
export const FLOOD_ZONES = [
  { id: 'F1', label: 'South Avenue',      minX: -19, maxX: 19,  minZ: 19,  maxZ: 31,  deep: false },
  { id: 'F2', label: 'North Avenue',      minX: -19, maxX: 19,  minZ: -31, maxZ: -19, deep: false },
  { id: 'F3', label: 'West Avenue',       minX: -31, maxX: -19, minZ: -19, maxZ: 19,  deep: false },
  { id: 'F4', label: 'East Avenue',       minX: 19,  maxX: 31,  minZ: -19, maxZ: 19,  deep: false },
  { id: 'F5', label: 'East Avenue South', minX: 19,  maxX: 31,  minZ: 31,  maxZ: 69,  deep: false },
  { id: 'F6', label: 'South Avenue East', minX: 31,  maxX: 69,  minZ: 19,  maxZ: 31,  deep: false },
  { id: 'F7', label: 'West Ring Road',    minX: -81, maxX: -69, minZ: -19, maxZ: 19,  deep: true },
  { id: 'F8', label: 'North Ring Road',   minX: -19, maxX: 19,  minZ: -81, maxZ: -69, deep: true },
  { id: 'F9', label: 'South-East Junction', minX: 19, maxX: 31, minZ: 19,  maxZ: 31,  deep: true }
];
/* floods: [{minX,maxX,minZ,maxZ,depth,deep}] with depth already scaled by the water level */
export function floodAt(floods, x, z) {
  let best = null;
  if (!floods) return null;
  for (const f of floods) {
    if (f.depth > 0.05 && x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ && (!best || f.depth > best.depth)) best = f;
  }
  return best;
}

/* ---------------------------------------------------------------------
   VEHICLES — arcade cargo truck (1 unit = 1 metre; HUD shows km/h)
   --------------------------------------------------------------------- */
export const VEHICLE = {
  maxSpeed: 17, reverseSpeed: 6.5, accel: 11, brake: 24, coast: 4.5,
  turnRate: 1.9, radius: 1.45, circleOffset: 3.2, length: 9.5,
  rearZone: 2.8, doorRange: 3.2, loadMaxSpeed: 1.5, exitMaxSpeed: 2,
  cargoSlots: 3, crashSpeed: 7, crashDamagePerUnit: 6,
  resetCooldownSeconds: 30, idleReturnSeconds: 90
};
export function vehicleGeometry(v) {
  const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
  const rx = fz, rz = -fx;
  const o = VEHICLE.circleOffset;
  return {
    fx, fz, rx, rz,
    rearX: v.x - fx * (VEHICLE.length / 2 + 1.3), rearZ: v.z - fz * (VEHICLE.length / 2 + 1.3),
    circles: [{ x: v.x + fx * o, z: v.z + fz * o }, { x: v.x, z: v.z }, { x: v.x - fx * o, z: v.z - fz * o }],
    doors: [
      { x: v.x + fx * 2.2 + rx * 2.3, z: v.z + fz * 2.2 + rz * 2.3 },
      { x: v.x + fx * 2.2 - rx * 2.3, z: v.z + fz * 2.2 - rz * 2.3 }
    ]
  };
}
export function cargoSlotsUsed(cargoIds, packages) {
  let n = 0;
  for (const id of cargoIds) { const p = packages.get(id); if (p) n += weightOf(p.type).slots; }
  return n;
}

export const EMOTES = ['Help!', 'Follow me!', 'Deliver here!', 'Thanks!', "Let's go!"];

export const PLAYER = {
  radius: 0.45, walkSpeed: 6, sprintSpeed: 9.5,
  acceleration: 10, deceleration: 16, stopThreshold: 0.15,
  turnSpeed: 12, stepSmoothing: 18,
  movingOn: 0.6, movingOff: 0.3
};

export const MAP = { playHalf: 87.5 };

export const ROADS = {
  lines: [-75, -25, 25, 75],
  mainLines: [-25, 25],
  halfWidth: 6,
  sidewalk: 3,
  curbHeight: 0.25,
  ringExtent: 81
};

export const BLOCK_TYPES = { '1,1': 'depot', '1,0': 'park', '1,2': 'residential' };

/* Room codes: 6 chars, no ambiguous characters. Codes are join identifiers, not secrets. */
export const ROOM_CODE = {
  alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  length: 6,
  pattern: /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/
};
export function normalizeRoomCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return ROOM_CODE.pattern.test(code) ? code : null;
}
export function isValidRegion(r) { return typeof r === 'string' && /^[a-z0-9-]{1,16}$/.test(r); }
export function sanitizeSkin(skin) { return skin === 2 || skin === '2' ? 2 : 1; }

/* ---------- small deterministic helpers ---------- */
export function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export function dampAngle(current, target, lambda, dt) {
  const TAU = Math.PI * 2;
  const diff = ((((target - current + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return current + diff * (1 - Math.exp(-lambda * dt));
}

/* =====================================================================
   CITY LAYOUT — the single source of truth for where things are.
   The client renders it, the server collides against it.
   ===================================================================== */
export function buildLayout() {
  const R = ROADS, lines = R.lines, hw = R.halfWidth, sw = R.sidewalk, h = R.curbHeight;
  const rng = mulberry32(20261111);
  const L = {
    slabs: [], blocks: [], colliders: [], placements: [], buildings: [],
    spawnPoints: [], packageSlots: [], depot: null, park: null
  };

  const addCollider = (minX, maxX, minZ, maxZ, maxY, blocksCamera = false, tag = '') =>
    L.colliders.push({ minX, maxX, minZ, maxZ, minY: 0, maxY, blocksCamera, tag });
  const boxCollider = (x, z, hx, hz, maxY, blocksCamera, tag) => addCollider(x - hx, x + hx, z - hz, z + hz, maxY, blocksCamera, tag);
  const groundAt = (x, z) => {
    let g = 0;
    for (const s of L.slabs) if (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ && s.h > g) g = s.h;
    return g;
  };
  /* Colliders are fixed sizes (not derived from GLB bounds) so client and server agree exactly. */
  const COLLIDERS = {
    streetlamb: { post: 0.3, h: 5 },
    trafficlight: { post: 0.3, h: 4.6 },
    trashcontainer: { hx: 0.85, hz: 0.85, h: 1.6 },
    woodenbox: { hx: 0.55, hz: 0.55, h: 1.2 }
  };
  const place = (key, x, z, rotY = 0, opts = {}) => {
    const y = opts.y ?? groundAt(x, z) + 0.005;
    L.placements.push({ key, x, y, z, rotY, scale: opts.scale ?? 1, stack: opts.stack || 0 });
    if (opts.collider === false) return;
    const c = COLLIDERS[key];
    if (!c) return;
    if (c.post) boxCollider(x, z, c.post, c.post, y + c.h, false, key);
    else boxCollider(x, z, c.hx, c.hz, y + c.h, false, key);
  };

  /* ---- blocks & sidewalks ---- */
  const addSlab = (minX, maxX, minZ, maxZ) => L.slabs.push({ minX, maxX, minZ, maxZ, h });
  for (let i = 0; i < lines.length - 1; i++) {
    for (let j = 0; j < lines.length - 1; j++) {
      const minX = lines[i] + hw, maxX = lines[i + 1] - hw, minZ = lines[j] + hw, maxZ = lines[j + 1] - hw;
      const block = {
        i, j, minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
        plot: { minX: minX + sw, maxX: maxX - sw, minZ: minZ + sw, maxZ: maxZ - sw },
        type: BLOCK_TYPES[`${i},${j}`] || 'apartments'
      };
      L.blocks.push(block);
      addSlab(minX, maxX, minZ, maxZ);
    }
  }
  const e = R.ringExtent, o = e + sw;
  addSlab(-o, o, -o, -e); addSlab(-o, o, e, o); addSlab(-o, -e, -e, e); addSlab(e, o, -e, e);
  const block = type => L.blocks.find(b => b.type === type);

  /* ---- depot ---- */
  {
    const b = block('depot');
    const { cx, cz, plot } = b;
    const backZ = plot.minZ;
    L.depot = { cx, cz, backZ, warehouse: { minX: cx - 12.6, maxX: cx + 12.6, minZ: backZ, maxZ: backZ + 7.2 }, zone: { x: cx, z: cz + 1, w: 14, d: 12 } };
    addCollider(cx - 12.6, cx + 12.6, backZ, backZ + 7.2, h + 7.6, true, 'warehouse');
    for (let k = 0; k < GAME.maxPackages; k++) {
      L.packageSlots.push({ x: cx - 6 + k * 2.4, z: backZ + 8.9, y: h });
    }
    const spawnOffsets = [[-4, 2], [0, 2], [4, 2], [-4, 5.5], [0, 5.5], [4, 5.5]];
    for (const [ox, oz] of spawnOffsets) L.spawnPoints.push({ x: cx + ox, z: cz + oz, y: h, rotY: 0 });

    place('woodenbox', cx - 13.6, backZ + 8.6, 0.1);
    place('woodenbox', cx - 12.2, backZ + 8.6, -0.05);
    place('woodenbox', cx - 13.6, backZ + 10.0, 0.2);
    place('woodenbox', cx - 13.6, backZ + 8.6, 0.35, { stack: 1, collider: false });
    place('woodenbox', cx + 13.6, backZ + 8.6, -0.15);
    place('palletjack', cx + 9.6, backZ + 10.8, 0.6);
    place('platformcart', cx - 9.6, backZ + 10.8, -0.4);
    // Drivable trucks (dynamic, server-owned): parked facing the south avenue
    L.vehicleSpawns = [
      { id: 'T1', x: cx + 11.5, z: cz + 4, yaw: 0 },
      { id: 'T2', x: cx - 11.5, z: cz + 4, yaw: 0 }
    ];
  }

  /* ---- park ---- */
  {
    const b = block('park');
    const { cx, cz } = b;
    L.park = { cx, cz };
    boxCollider(cx, cz, 3.1, 3.1, h + 2.4, false, 'fountain');
    for (const deg of [45, 135, 225, 315]) {
      const a = (deg * Math.PI) / 180;
      const x = cx + Math.sin(a) * 7.4, z = cz + Math.cos(a) * 7.4;
      place('bench', x, z, Math.atan2(cx - x, cz - z));
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      place('plant', cx + sx * 11.5, cz + sz * 11.5, rng() * Math.PI * 2);
      place('plant', cx + sx * 6.5, cz + sz * 13, rng() * Math.PI * 2);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      place('streetlamb', cx + sx * 2.6, cz + sz * 10, sx > 0 ? -Math.PI / 2 : Math.PI / 2);
    }
    place('trashcontainer', cx + 13.5, cz + 4, -Math.PI / 2);
  }

  /* ---- buildings ---- */
  const courtyard = (x, z) => {
    place('bench', x - 3, z, Math.PI / 2);
    place('bench', x + 3, z, -Math.PI / 2);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) place('plant', x + sx * 5, z + sz * 5, rng() * 6.28);
    place('trashcontainer', x, z - 5.2, 0);
  };
  const addBuilding = (key, x, z, rotY, scale, blockName) => {
    place(key, x, z, rotY, { scale, collider: false });
    const half = 5.6 * scale;
    boxCollider(x, z, half, half, 40, true, 'building');
    const fx = Math.sin(rotY), fz = Math.cos(rotY);
    const doorDist = 6 * scale + 1.8;
    const id = `B${String(L.buildings.length + 1).padStart(2, '0')}`;
    L.buildings.push({
      id, key, x, z, rotY,
      doorX: x + fx * doorDist, doorZ: z + fz * doorDist,
      label: `${blockName} · No. ${L.buildings.length + 1}`
    });
  };
  const cells = [[-8, -8], [8, -8], [-8, 8], [8, 8]];
  const types = ['apartment1', 'apartment2', 'apartment3', 'apartment4'];
  const blockName = b => [['North', '', 'South'][b.j], ['West', '', 'East'][b.i]].filter(Boolean).join('-') + ' Street';
  L.blocks.filter(b => b.type === 'apartments').forEach((b, bi) => {
    const order = shuffled(types, rng);
    const courtyardCell = bi % 2 === 1 ? (bi * 3) % 4 : -1;
    cells.forEach(([ox, oz], ci) => {
      const x = b.cx + ox, z = b.cz + oz;
      if (ci === courtyardCell) { courtyard(x, z); return; }
      const faceX = (ci + bi) % 2 === 0;
      const rot = faceX ? Math.atan2(Math.sign(ox), 0) : Math.atan2(0, Math.sign(oz));
      addBuilding(order[ci], x, z, rot, 1, blockName(b));
    });
    place('trashcontainer', b.cx, b.cz + 13, 0);
    place('plant', b.cx, b.cz - 13, rng() * 6.28);
  });
  {
    const b = block('residential');
    const order = ['apartment2', 'apartment4', null, 'apartment1'];
    cells.forEach(([ox, oz], ci) => {
      const x = b.cx + ox, z = b.cz + oz;
      if (!order[ci]) { courtyard(x, z); return; }
      const rot = ci === 0 ? Math.PI : ci === 1 ? Math.atan2(1, 0) : 0;
      addBuilding(order[ci], x, z, rot, 0.9, 'Residential');
    });
    place('trashcontainer', b.cx, b.cz - 13, 0);
  }

  /* ---- lamps & traffic lights ---- */
  const isMain = v => R.mainLines.includes(v);
  for (const b of L.blocks) {
    const edges = [
      { line: b.minX - hw, x: b.minX + 1.2, z: b.cz + 6, rot: -Math.PI / 2 },
      { line: b.maxX + hw, x: b.maxX - 1.2, z: b.cz - 6, rot: Math.PI / 2 },
      { line: b.minZ - hw, x: b.cx - 6, z: b.minZ + 1.2, rot: Math.PI },
      { line: b.maxZ + hw, x: b.cx + 6, z: b.maxZ - 1.2, rot: 0 }
    ];
    for (const ed of edges) if (isMain(ed.line)) place('streetlamb', ed.x, ed.z, ed.rot);
  }
  for (const cx of R.mainLines) for (const cz of R.mainLines) {
    for (const s of [1, -1]) place('trafficlight', cx + s * 7.6, cz + s * 7.6, Math.atan2(-s, -s));
  }

  /* ---- roadwork on the east ring road ---- */
  for (let z = 38; z <= 62; z += 3) place('trafficcone', 75.6, z, rng() * 6.28);
  for (const z of [38, 62]) for (const x of [77.2, 78.8, 80.3]) place('trafficcone', x, z, rng() * 6.28);
  place('woodenbox', 78.2, 46, 0.3);
  place('woodenbox', 78.6, 47.4, -0.2);
  place('woodenbox', 78.4, 54, 0.1);

  /* ---- border greenery ---- */
  for (let t = -72; t <= 72; t += 24) {
    place('plant', t, -86.6, rng() * 6.28);
    place('plant', t + 12, 86.6, rng() * 6.28);
    place('plant', -86.6, t + 12, rng() * 6.28);
    place('plant', 86.6, t, rng() * 6.28);
  }
  return L;
}

/* =====================================================================
   PHYSICS WORLD — collision + ground queries over a layout
   ===================================================================== */
export function createPhysicsWorld(layout) {
  const { colliders, slabs } = layout;
  return {
    layout,
    groundHeight(x, z) {
      let g = 0;
      for (const s of slabs) if (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ && s.h > g) g = s.h;
      return g;
    },
    /* Circle (player) vs boxes. Pushes pos out, returns accumulated push normal in out. */
    resolveCircle(pos, r, out) {
      out.x = 0; out.z = 0;
      for (let iter = 0; iter < 3; iter++) {
        let pushed = false;
        for (const c of colliders) {
          if (pos.x < c.minX - r || pos.x > c.maxX + r || pos.z < c.minZ - r || pos.z > c.maxZ + r) continue;
          if (pos.y > c.maxY - 0.05) continue;
          const qx = clamp(pos.x, c.minX, c.maxX), qz = clamp(pos.z, c.minZ, c.maxZ);
          const dx = pos.x - qx, dz = pos.z - qz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          let nx, nz, pen;
          if (d2 > 1e-10) {
            const d = Math.sqrt(d2); nx = dx / d; nz = dz / d; pen = r - d;
          } else {
            const l = pos.x - c.minX, rr = c.maxX - pos.x, t = pos.z - c.minZ, bb = c.maxZ - pos.z;
            const m = Math.min(l, rr, t, bb);
            if (m === l) { nx = -1; nz = 0; pen = l + r; }
            else if (m === rr) { nx = 1; nz = 0; pen = rr + r; }
            else if (m === t) { nx = 0; nz = -1; pen = t + r; }
            else { nx = 0; nz = 1; pen = bb + r; }
          }
          pos.x += nx * pen; pos.z += nz * pen;
          out.x += nx; out.z += nz;
          pushed = true;
        }
        if (!pushed) break;
      }
      return out;
    }
  };
}

/* =====================================================================
   INPUT VALIDATION + MOVEMENT STEP (identical on client and server)
   state: { position:{x,y,z}, velocity:{x,z}, rotationY, moving }
   input: { mx, mz, sp }  (movement direction in world XZ, sprint flag)
   ===================================================================== */
export function sanitizeMoveInput(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let mx = Number(raw.mx), mz = Number(raw.mz);
  if (!Number.isFinite(mx) || !Number.isFinite(mz)) return null;
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  // quantize so client + server simulate the exact same numbers
  mx = Math.round(mx * 1000) / 1000;
  mz = Math.round(mz * 1000) / 1000;
  return { mx, mz, sp: raw.sp === true || raw.sp === 1 };
}

const _n = { x: 0, z: 0 };
/* Push a circle out of other circles (trucks). Returns true if pushed. */
function resolveCircles(pos, r, circles, out) {
  let pushed = false;
  if (!circles) return false;
  for (const c of circles) {
    const dx = pos.x - c.x, dz = pos.z - c.z, rr = r + c.r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) continue;
    const d = Math.sqrt(d2) || 1e-4;
    const nx = d2 > 1e-8 ? dx / d : 1, nz = d2 > 1e-8 ? dz / d : 0, pen = rr - d;
    pos.x += nx * pen; pos.z += nz * pen;
    out.x += nx; out.z += nz;
    pushed = true;
  }
  return pushed;
}
export function walkSpeedMultiplier(mods, x, z) {
  let mul = mods?.carryMul ?? 1;
  const f = floodAt(mods?.floods, x, z);
  if (f) mul *= f.deep ? DISASTER.flood.walkMul.deep : DISASTER.flood.walkMul.shallow;
  return mul;
}
/* mods (optional): { carryMul, canSprint, floods, circles:[{x,z,r}] } */
export function stepMovement(state, input, dt, world, mods = null) {
  const P = PLAYER, v = state.velocity, pos = state.position;
  const ix = input.mx, iz = input.mz;
  const hasInput = ix !== 0 || iz !== 0;
  const canSprint = mods?.canSprint !== false;
  const speed = (input.sp && canSprint ? P.sprintSpeed : P.walkSpeed) * walkSpeedMultiplier(mods, pos.x, pos.z);
  const k = 1 - Math.exp(-(hasInput ? P.acceleration : P.deceleration) * dt);
  v.x += (ix * speed - v.x) * k;
  v.z += (iz * speed - v.z) * k;
  if (!hasInput && v.x * v.x + v.z * v.z < P.stopThreshold * P.stopThreshold) { v.x = 0; v.z = 0; }

  pos.x += v.x * dt;
  pos.z += v.z * dt;
  // external impulse (tornado) decays smoothly; synced so prediction replays it
  const imp = state.impulse;
  if (imp && (imp.x !== 0 || imp.z !== 0)) {
    pos.x += imp.x * dt; pos.z += imp.z * dt;
    const k2 = Math.exp(-3.5 * dt);
    imp.x *= k2; imp.z *= k2;
    if (Math.abs(imp.x) < 0.05 && Math.abs(imp.z) < 0.05) { imp.x = 0; imp.z = 0; }
  }

  const n = world.resolveCircle(pos, P.radius, _n);
  resolveCircles(pos, P.radius, mods?.circles, n);
  const nl = Math.hypot(n.x, n.z);
  if (nl > 0) {
    const nx = n.x / nl, nz = n.z / nl;
    const d = v.x * nx + v.z * nz;
    if (d < 0) { v.x -= nx * d; v.z -= nz * d; }
  }

  const lim = MAP.playHalf;
  if (pos.x < -lim) { pos.x = -lim; if (v.x < 0) v.x = 0; }
  if (pos.x > lim) { pos.x = lim; if (v.x > 0) v.x = 0; }
  if (pos.z < -lim) { pos.z = -lim; if (v.z < 0) v.z = 0; }
  if (pos.z > lim) { pos.z = lim; if (v.z > 0) v.z = 0; }

  const gy = world.groundHeight(pos.x, pos.z);
  pos.y += (gy - pos.y) * (1 - Math.exp(-P.stepSmoothing * dt));
  if (Math.abs(gy - pos.y) < 0.002) pos.y = gy;
  if (pos.y < 0) pos.y = 0;

  if (hasInput) state.rotationY = dampAngle(state.rotationY, Math.atan2(ix, iz), P.turnSpeed, dt);
  else if (Math.hypot(v.x, v.z) > 0.3) state.rotationY = dampAngle(state.rotationY, Math.atan2(v.x, v.z), P.turnSpeed, dt);
  // keep rotation bounded so float32 sync never loses precision
  if (state.rotationY > Math.PI) state.rotationY -= Math.PI * 2;
  else if (state.rotationY < -Math.PI) state.rotationY += Math.PI * 2;

  const sp = Math.hypot(v.x, v.z);
  if (!state.moving && sp > P.movingOn) state.moving = true;
  else if (state.moving && sp < P.movingOff) state.moving = false;
}

export function distanceXZ(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }

/* =====================================================================
   VEHICLE STEP (identical on client prediction and server authority)
   v: { x, z, yaw, speed } · input: { steer, throttle, brake } (-1..1)
   mods: { floods, circles } · returns impact speed when it hits something
   ===================================================================== */
export function sanitizeDriveInput(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let steer = Number(raw.steer), throttle = Number(raw.throttle);
  if (!Number.isFinite(steer) || !Number.isFinite(throttle)) return null;
  steer = Math.round(clamp(steer, -1, 1) * 1000) / 1000;
  throttle = Math.round(clamp(throttle, -1, 1) * 1000) / 1000;
  return { steer, throttle, brake: raw.brake === true || raw.brake === 1 };
}
const _vp = { x: 0, y: 0.3, z: 0 }, _vn = { x: 0, z: 0 };
export function stepVehicle(v, input, dt, world, mods = null) {
  const V = VEHICLE;
  const floodHere = floodAt(mods?.floods, v.x, v.z);
  const max = V.maxSpeed * (floodHere ? DISASTER.flood.vehicleMul : 1);
  let s = v.speed;
  // punchy launch that tapers off near top speed
  const pull = V.accel * (1 - 0.6 * Math.min(1, (Math.abs(s) / V.maxSpeed) ** 2));
  if (input.brake) s = Math.sign(s) * Math.max(0, Math.abs(s) - V.brake * dt);
  else if (input.throttle > 0) s = s < -0.2 ? Math.min(0, s + V.brake * dt) : s + pull * input.throttle * dt;
  else if (input.throttle < 0) s = s > 0.2 ? Math.max(0, s - V.brake * dt) : s + pull * 0.7 * input.throttle * dt;
  else s = Math.sign(s) * Math.max(0, Math.abs(s) - V.coast * dt);
  if (s > max) s = Math.max(max, s - V.brake * dt);   // ease down when entering water
  if (s < -V.reverseSpeed) s = -V.reverseSpeed;

  // steering: responsive at low speed, calmer at top speed (no turning on the spot)
  const sf = clamp(Math.abs(s) / 2.5, 0, 1) * (1 - 0.4 * Math.abs(s) / V.maxSpeed);
  v.yaw -= input.steer * V.turnRate * sf * Math.sign(s) * dt;
  if (v.yaw > Math.PI) v.yaw -= Math.PI * 2; else if (v.yaw < -Math.PI) v.yaw += Math.PI * 2;

  let nx = v.x + Math.sin(v.yaw) * s * dt, nz = v.z + Math.cos(v.yaw) * s * dt;
  // deep water blocks entry
  if (DISASTER.flood.deepBlocksVehicles) {
    const fNext = floodAt(mods?.floods, nx, nz);
    if (fNext?.deep && !floodHere?.deep) { v.speed = 0; return 0; }
  }
  // collision: three circles along the truck vs static boxes + other trucks
  const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw), o = V.circleOffset;
  let px = 0, pz = 0;
  for (const off of [o, 0, -o]) {
    _vp.x = nx + fx * off; _vp.z = nz + fz * off; _vp.y = 0.3;
    const bx = _vp.x, bz = _vp.z;
    world.resolveCircle(_vp, V.radius, _vn);
    _vn.x = 0; _vn.z = 0;
    resolveCircles(_vp, V.radius, mods?.circles, _vn);
    const dx = _vp.x - bx, dz = _vp.z - bz;
    if (Math.abs(dx) > Math.abs(px)) px = dx;
    if (Math.abs(dz) > Math.abs(pz)) pz = dz;
  }
  let impact = 0;
  if (px !== 0 || pz !== 0) {
    nx += px; nz += pz;
    // slide along walls: only the part of the motion going INTO the obstacle is lost
    const pl = Math.hypot(px, pz), nxn = px / pl, nzn = pz / pl;
    const into = -(fx * nxn + fz * nzn) * Math.sign(s);          // 1 = head-on, 0 = scraping along
    if (into > 0) {
      impact = Math.abs(s) * into;
      s *= into > 0.85 ? -0.15 : 1 - into * 0.9;                    // small bounce only when head-on
    }
  }
  const lim = MAP.playHalf - 2;
  if (nx < -lim || nx > lim || nz < -lim || nz > lim) { nx = clamp(nx, -lim, lim); nz = clamp(nz, -lim, lim); impact = Math.max(impact, Math.abs(s)); s = 0; }
  v.x = nx; v.z = nz; v.speed = Math.abs(s) < 0.02 ? 0 : s;
  return impact;
}
export function vehicleCircles(vehicles, exceptId = null) {
  const out = [];
  for (const v of vehicles) {
    if (v.id === exceptId) continue;
    for (const c of vehicleGeometry(v).circles) out.push({ x: c.x, z: c.z, r: VEHICLE.radius });
  }
  return out;
}

/* =====================================================================
   INTERACTION RULES — one function decides what "E" does.
   The server executes the result; the client shows it as a prompt.
   ctx: { x, z, carrying, driving, packages (Map), vehicles (Map), destinations (Map) }
   ===================================================================== */
const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
export function resolveInteraction(ctx) {
  const { x, z, packages, vehicles, destinations } = ctx;
  const V = VEHICLE;
  if (ctx.driving) {
    const v = vehicles.get(ctx.driving);
    if (!v) return { kind: 'none' };
    return Math.abs(v.speed) <= V.exitMaxSpeed ? { kind: 'exitVehicle', vehicleId: v.id } : { kind: 'none', reason: 'slowDownToExit' };
  }
  // trucks whose cargo door is next to the player and that are (almost) stopped
  let rearTruck = null, rearD = V.rearZone;
  let doorTruck = null, doorD = V.doorRange;
  for (const v of vehicles.values()) {
    const g = vehicleGeometry(v);
    const dr = dist(x, z, g.rearX, g.rearZ);
    if (dr <= rearD && Math.abs(v.speed) <= V.loadMaxSpeed) { rearTruck = v; rearD = dr; }
    for (const d of g.doors) {
      const dd = dist(x, z, d.x, d.z);
      if (dd <= doorD && !v.driverId) { doorTruck = v; doorD = dd; }
    }
  }
  const carried = ctx.carrying ? packages.get(ctx.carrying) : null;
  if (carried) {
    const dest = destinations.get(carried.destinationId);
    if (dest && dist(x, z, dest.x, dest.z) <= GAME.deliveryRadius) return { kind: 'deliver', packageId: carried.id };
    if (rearTruck) {
      const free = V.cargoSlots - cargoSlotsUsed(rearTruck.cargo, packages);
      return free >= weightOf(carried.type).slots
        ? { kind: 'loadCarried', packageId: carried.id, vehicleId: rearTruck.id }
        : { kind: 'none', reason: 'truckFull', vehicleId: rearTruck.id };
    }
    return { kind: 'none', reason: 'carrying' };
  }
  // deliver straight from a truck parked at the destination
  if (rearTruck) {
    for (const id of rearTruck.cargo) {
      const p = packages.get(id);
      const dest = p && destinations.get(p.destinationId);
      if (dest && dist(x, z, dest.x, dest.z) <= GAME.deliveryRadius + 1.5) return { kind: 'deliverFromTruck', packageId: id, vehicleId: rearTruck.id };
    }
  }
  // nearest package on the ground
  let best = null, bestD = GAME.pickupRadius;
  for (const p of packages.values()) {
    if (p.status !== 'available') continue;
    const d = dist(x, z, p.x, p.z);
    if (d <= bestD) { best = p; bestD = d; }
  }
  if (best) {
    const w = weightOf(best.type);
    if (w.onFoot) return { kind: 'pickup', packageId: best.id };
    for (const v of vehicles.values()) {
      const g = vehicleGeometry(v);
      if (Math.abs(v.speed) <= V.loadMaxSpeed && dist(best.x, best.z, g.rearX, g.rearZ) <= 5 &&
          V.cargoSlots - cargoSlotsUsed(v.cargo, packages) >= w.slots) {
        return { kind: 'loadHeavy', packageId: best.id, vehicleId: v.id };
      }
    }
    return { kind: 'none', reason: 'needTruck', packageId: best.id };
  }
  if (rearTruck) {
    for (let i = rearTruck.cargo.length - 1; i >= 0; i--) {
      const p = packages.get(rearTruck.cargo[i]);
      if (p && weightOf(p.type).onFoot) return { kind: 'unload', packageId: p.id, vehicleId: rearTruck.id };
    }
  }
  if (doorTruck) return { kind: 'enterVehicle', vehicleId: doorTruck.id };
  return { kind: 'none' };
}
