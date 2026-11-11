/* =====================================================================
   DISASTER DELIVERY — shared game rules
   Imported by BOTH the browser (index.html) and the Colyseus server
   (server.js). Everything that must give identical results on both
   sides lives here: the deterministic city layout, colliders, ground
   height, the movement step used for prediction + authority, and the
   gameplay constants. No Three.js, no DOM, no Node APIs.
   ===================================================================== */

export const PROTOCOL_VERSION = 1;

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

/* Configurable rewards. `model` is the GLB key used on the client. */
export const PACKAGE_TYPES = {
  box:       { label: 'Standard box', model: 'box',          reward: 100, weight: 6 },
  groceries: { label: 'Groceries',    model: 'groceriesbox', reward: 150, weight: 3 },
  vip:       { label: 'VIP package',  model: 'vipbox',       reward: 500, weight: 1 }
};

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
    place('palletjack', cx - 9.5, cz + 4, 0.6);
    place('platformcart', cx - 11.5, cz + 9, -0.4);
    place('cargotruck', cx + 11.5, cz + 4, 0);
    boxCollider(cx + 11.5, cz + 4, 1.4, 4.6, h + 3.5, false, 'cargotruck');
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
export function stepMovement(state, input, dt, world) {
  const P = PLAYER, v = state.velocity, pos = state.position;
  const ix = input.mx, iz = input.mz;
  const hasInput = ix !== 0 || iz !== 0;
  const speed = input.sp ? P.sprintSpeed : P.walkSpeed;
  const k = 1 - Math.exp(-(hasInput ? P.acceleration : P.deceleration) * dt);
  v.x += (ix * speed - v.x) * k;
  v.z += (iz * speed - v.z) * k;
  if (!hasInput && v.x * v.x + v.z * v.z < P.stopThreshold * P.stopThreshold) { v.x = 0; v.z = 0; }

  pos.x += v.x * dt;
  pos.z += v.z * dt;

  const n = world.resolveCircle(pos, P.radius, _n);
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
