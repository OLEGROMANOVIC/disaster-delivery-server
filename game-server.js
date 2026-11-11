/* =====================================================================
   DISASTER DELIVERY — Colyseus game server logic (Colyseus 0.18)
   Started by server.js (local + Colyseus Cloud). Imported by tests.
   ===================================================================== */
import { defineServer, defineRoom, Room, ServerError, matchMaker, CloseCode, LocalPresence, LocalDriver, RedisPresence, RedisDriver } from 'colyseus';
import { schema, t } from '@colyseus/schema';
import jwt from 'jsonwebtoken';
import {
  NET, GAME, PACKAGE_TYPES, EMOTES, ROOM_CODE, PROTOCOL_VERSION, DISASTER, FLOOD_ZONES, VEHICLE, CONDITION, ROADS, MAP,
  buildLayout, createPhysicsWorld, stepMovement, stepVehicle, sanitizeMoveInput, sanitizeDriveInput, sanitizeSkin,
  distanceXZ, deliveryReward, packageDef, weightOf, floodAt, vehicleGeometry, vehicleCircles, cargoSlotsUsed,
  resolveInteraction, mulberry32
} from './shared.js';

/* ---------------------------------------------------------------------
   Configuration (environment variables — see .env.example)
   --------------------------------------------------------------------- */
const env = process.env;
const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const CONFIG = {
  port: num(env.PORT, 2567),
  region: (env.REGION || (env.COLYSEUS_CLOUD !== undefined ? 'cloud' : 'local')).toLowerCase(),
  allowedOrigins: (env.ALLOWED_ORIGINS || 'localhost,127.0.0.1,.crazygames.com')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Empty Origin = non-browser clients (tests). Off by default in production / on Colyseus Cloud.
  allowEmptyOrigin: env.ALLOW_EMPTY_ORIGIN !== undefined ? env.ALLOW_EMPTY_ORIGIN === 'true'
    : (env.NODE_ENV !== 'production' && env.COLYSEUS_CLOUD === undefined),
  matchSeconds: num(env.MATCH_SECONDS, GAME.matchSeconds),
  intermissionSeconds: num(env.INTERMISSION_SECONDS, GAME.intermissionSeconds),
  lateJoinWindowSeconds: num(env.LATE_JOIN_SECONDS, GAME.lateJoinWindowSeconds),
  reconnectSeconds: num(env.RECONNECT_SECONDS, GAME.reconnectSeconds),
  crazyGamesKeyUrl: env.CRAZYGAMES_PUBLIC_KEY_URL || 'https://sdk.crazygames.com/publicKey.json',
  crazyGamesGameId: env.CRAZYGAMES_GAME_ID || '', // optional: reject tokens issued for other games
  // Disaster / package tuning & test hooks (all optional)
  disasterTypes: (env.DISASTER_TYPES || DISASTER.types.join(',')).split(',').map(s => s.trim()).filter(t => DISASTER.types.includes(t)),
  forcedFloodZones: (env.FLOOD_ZONES || '').split(',').map(s => s.trim()).filter(id => FLOOD_ZONES.some(z => z.id === id)),
  tornadoPath: (env.TORNADO_PATH || '').split(';').map(p => p.split(',').map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite)),
  packagePool: (env.PACKAGE_POOL || '').split(',').map(s => s.trim()).filter(k => PACKAGE_TYPES[k])
};
if (env.DROP_DAMAGE !== undefined && Number.isFinite(Number(env.DROP_DAMAGE))) CONDITION.dropDamage = Number(env.DROP_DAMAGE);

/* ---------------------------------------------------------------------
   Origin validation (WebSocket + matchmaking HTTP requests)
   Entries: exact host ("localhost"), or suffix (".crazygames.com"),
   or a full origin ("https://example.com").
   --------------------------------------------------------------------- */
export function isOriginAllowed(origin) {
  if (!origin) return CONFIG.allowEmptyOrigin;
  let host;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  const o = origin.toLowerCase();
  return CONFIG.allowedOrigins.some(rule => {
    if (rule === '*') return true;
    if (rule.includes('://')) return o === rule;
    if (rule.startsWith('.')) return host.endsWith(rule) || host === rule.slice(1);
    return host === rule;
  });
}

/* ---------------------------------------------------------------------
   CrazyGames user token verification (RS256 JWT)
   --------------------------------------------------------------------- */
let cachedKey = null;
let cachedKeyAt = 0;
async function getCrazyGamesKey(force = false) {
  if (!force && cachedKey && Date.now() - cachedKeyAt < 10 * 60 * 1000) return cachedKey;
  const res = await fetch(CONFIG.crazyGamesKeyUrl, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`public key fetch failed: ${res.status}`);
  const body = await res.json();
  if (typeof body.publicKey !== 'string') throw new Error('public key missing');
  cachedKey = body.publicKey;
  cachedKeyAt = Date.now();
  return cachedKey;
}
async function verifyCrazyGamesToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return null;
  for (const force of [false, true]) {
    try {
      const key = await getCrazyGamesKey(force);
      const payload = jwt.verify(token, key, { algorithms: ['RS256'] });
      if (!payload || typeof payload.userId !== 'string' || typeof payload.username !== 'string') return null;
      if (CONFIG.crazyGamesGameId && String(payload.gameId) !== CONFIG.crazyGamesGameId) return null;
      return { userId: payload.userId, username: payload.username };
    } catch (err) {
      if (force) { console.warn('[auth] CrazyGames token rejected:', err.message); return null; }
    }
  }
  return null;
}
function cleanDisplayName(name) {
  return String(name).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24) || null;
}


/* ---------------------------------------------------------------------
   Synchronized state (Colyseus schema)
   --------------------------------------------------------------------- */
const PlayerState = schema({
  sessionId: t.string().default(''),
  name: t.string().default(''),
  verified: t.boolean().default(false),          // true = CrazyGames account verified server-side
  skin: t.uint8().default(1),
  role: t.string().default('active'),            // 'active' | 'spectator'
  connected: t.boolean().default(true),
  slot: t.uint8().default(0),
  x: t.float32().default(0), y: t.float32().default(0), z: t.float32().default(0),
  rotY: t.float32().default(0),
  vx: t.float32().default(0), vz: t.float32().default(0),
  ix: t.float32().default(0), iz: t.float32().default(0),   // external impulse (tornado), replayed by prediction
  moving: t.boolean().default(false),
  anim: t.string().default('idle'),              // 'run' | 'idle'
  ack: t.uint32().default(0),                    // last processed input sequence (client reconciliation)
  score: t.uint32().default(0),
  deliveries: t.uint16().default(0),
  carrying: t.string().default(''),              // package id or ''
  driving: t.string().default('')                // vehicle id or ''
}, 'PlayerState');

const PackageState = schema({
  id: t.string().default(''),
  type: t.string().default(''),
  status: t.string().default('available'),       // 'available' | 'carried' | 'loaded'
  carrierId: t.string().default(''),
  vehicleId: t.string().default(''),
  slot: t.int8().default(-1),                    // depot pad index, -1 when elsewhere
  x: t.float32().default(0), y: t.float32().default(0), z: t.float32().default(0),
  destinationId: t.string().default(''),
  reward: t.uint16().default(0),                 // base points
  condition: t.uint8().default(100)
}, 'PackageState');

const DestinationState = schema({
  id: t.string().default(''),
  label: t.string().default(''),
  x: t.float32().default(0), z: t.float32().default(0),          // delivery point (building door)
  bx: t.float32().default(0), bz: t.float32().default(0)         // building centre (marker)
}, 'DestinationState');

const VehicleState = schema({
  id: t.string().default(''),
  x: t.float32().default(0), z: t.float32().default(0),
  yaw: t.float32().default(0),
  speed: t.float32().default(0),
  driverId: t.string().default(''),
  cargo: t.array('string'),
  state: t.string().default('parked')            // 'parked' | 'driving'
}, 'VehicleState');

const FloodZoneState = schema({
  id: t.string().default(''),
  label: t.string().default(''),
  minX: t.float32().default(0), maxX: t.float32().default(0),
  minZ: t.float32().default(0), maxZ: t.float32().default(0),
  deep: t.boolean().default(false),
  depth: t.float32().default(0)                  // full depth (m); effective depth = depth * level
}, 'FloodZoneState');

const DisasterState = schema({
  type: t.string().default('none'),              // 'none' | 'tornado' | 'flood'
  phase: t.string().default('inactive'),         // 'inactive' | 'warning' | 'active' | 'recovery'
  slot: t.int8().default(-1),
  secondsLeft: t.uint16().default(0),            // until the next phase change
  startsAt: t.float64().default(0),              // server epoch ms
  endsAt: t.float64().default(0),
  level: t.float32().default(0),                 // 0..1 intensity (water height / tornado strength)
  tx: t.float32().default(0), tz: t.float32().default(0), heading: t.float32().default(0),
  pushRadius: t.float32().default(0), dangerRadius: t.float32().default(0),
  floods: t.map(FloodZoneState)
}, 'DisasterState');

const ResultEntry = schema({
  sessionId: t.string().default(''),
  name: t.string().default(''),
  score: t.uint32().default(0),
  deliveries: t.uint16().default(0),
  rank: t.uint8().default(0)
}, 'ResultEntry');

const CityState = schema({
  protocol: t.uint8().default(0),
  roomCode: t.string().default(''),
  region: t.string().default(''),
  mode: t.string().default(''),                  // 'public' | 'private'
  phase: t.string().default('playing'),          // 'playing' | 'results'
  matchNumber: t.uint16().default(0),
  matchStartedAt: t.float64().default(0),
  matchEndsAt: t.float64().default(0),
  phaseEndsAt: t.float64().default(0),
  timeLeft: t.uint16().default(0),
  maxPlayers: t.uint8().default(0),
  playerCount: t.uint8().default(0),
  activeCount: t.uint8().default(0),
  joinable: t.boolean().default(false),
  players: t.map(PlayerState),
  packages: t.map(PackageState),
  destinations: t.map(DestinationState),
  vehicles: t.map(VehicleState),
  disaster: t.ref(DisasterState),
  results: t.array(ResultEntry)
}, 'CityState');

/* Deterministic city shared with the client. */
const LAYOUT = buildLayout();
const WORLD = createPhysicsWorld(LAYOUT);
const ZERO_WALK = { mx: 0, mz: 0, sp: false };
const ZERO_DRIVE = { steer: 0, throttle: 0, brake: true };
const DT = NET.fixedDt;

function randomCode() {
  let s = '';
  for (let i = 0; i < ROOM_CODE.length; i++) s += ROOM_CODE.alphabet[Math.floor(Math.random() * ROOM_CODE.alphabet.length)];
  return s;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* =====================================================================
   DISASTER CONTROLLER — one per room; all timing is server-side.
   Phases: inactive → warning → active → recovery → inactive
   ===================================================================== */
const NODES = [];
for (const x of ROADS.lines) for (const z of ROADS.lines) NODES.push([x, z]);
function neighbours([x, z]) {
  const L = ROADS.lines, out = [];
  const ix = L.indexOf(x), iz = L.indexOf(z);
  if (ix > 0) out.push([L[ix - 1], z]);
  if (ix < L.length - 1) out.push([L[ix + 1], z]);
  if (iz > 0) out.push([x, L[iz - 1]]);
  if (iz < L.length - 1) out.push([x, L[iz + 1]]);
  return out;
}

class DisasterController {
  constructor(room) {
    this.room = room;
    this.d = room.state.disaster;
    this.plan = [];
    this.current = -1;
    this.phase = 'inactive';
    this.path = []; this.pathIndex = 0;
    this.rng = Math.random;
  }
  /* New match: fresh schedule, everything back to normal. */
  reset(matchStartedAt) {
    this.matchStartedAt = matchStartedAt;
    const scale = CONFIG.matchSeconds / DISASTER.baseMatchSeconds;
    const types = CONFIG.disasterTypes;
    let last = null;
    this.plan = types.length ? DISASTER.schedule.map(slot => {
      const pool = types.length > 1 ? types.filter(t => t !== last) : types;
      const type = pool[Math.floor(this.rng() * pool.length)];
      last = type;
      return { type, warn: slot.warn * scale, start: slot.start * scale, end: slot.end * scale, recover: DISASTER.recoverySeconds * Math.min(1, scale * 1.5) };
    }) : [];
    this.current = -1;
    this.clear();
  }
  clear() {
    const d = this.d;
    d.type = 'none'; d.phase = 'inactive'; d.slot = -1; d.secondsLeft = 0; d.level = 0;
    d.startsAt = 0; d.endsAt = 0; d.pushRadius = 0; d.dangerRadius = 0;
    d.floods.clear();
    this.phase = 'inactive';
    this.path = [];
  }
  get floodsForPhysics() {
    if (this.d.type !== 'flood' || this.d.level <= 0.02) return null;
    const lv = this.d.level, out = [];
    for (const f of this.d.floods.values()) out.push({ minX: f.minX, maxX: f.maxX, minZ: f.minZ, maxZ: f.maxZ, deep: f.deep, depth: f.depth * lv });
    return out;
  }
  get tornadoActive() { return this.d.type === 'tornado' && this.d.phase === 'active' && this.d.level > 0.3; }

  update(now) {
    const elapsed = (now - this.matchStartedAt) / 1000;
    let slot = -1, phase = 'inactive';
    for (let i = 0; i < this.plan.length; i++) {
      const p = this.plan[i];
      if (elapsed >= p.warn && elapsed < p.end + p.recover) {
        slot = i;
        phase = elapsed < p.start ? 'warning' : elapsed < p.end ? 'active' : 'recovery';
        break;
      }
    }
    const d = this.d;
    if (slot !== this.current || phase !== this.phase) this.enter(slot, phase, now);
    if (slot < 0) return;
    const p = this.plan[slot];
    const toNext = phase === 'warning' ? p.start - elapsed : phase === 'active' ? p.end - elapsed : p.end + p.recover - elapsed;
    const secs = Math.max(0, Math.ceil(toNext));
    if (d.secondsLeft !== secs) d.secondsLeft = secs;

    // intensity: rises at the start of ACTIVE, falls during RECOVERY
    let level = 0;
    if (phase === 'active') level = clamp((elapsed - p.start) / (d.type === 'flood' ? DISASTER.flood.riseSeconds : 2), 0, 1);
    else if (phase === 'recovery') level = clamp(1 - (elapsed - p.end) / p.recover, 0, 1);
    level = Math.round(level * 100) / 100;
    if (d.level !== level) d.level = level;

    if (d.type === 'tornado' && (phase === 'active' || phase === 'recovery')) this.moveTornado(DT);
  }

  enter(slot, phase, now) {
    const d = this.d;
    const prevSlot = this.current;
    this.current = slot; this.phase = phase;
    if (slot < 0) { this.clear(); return; }
    const p = this.plan[slot];
    if (slot !== prevSlot) { this.clear(); this.current = slot; this.phase = phase; }
    d.slot = slot; d.type = p.type; d.phase = phase;
    d.startsAt = this.matchStartedAt + p.start * 1000;
    d.endsAt = this.matchStartedAt + p.end * 1000;
    if (phase === 'warning') {
      this.room.broadcast('disaster', { phase, type: p.type });
    } else if (phase === 'active') {
      if (p.type === 'tornado') this.spawnTornado(p);
      if (p.type === 'flood') this.spawnFlood();
      this.room.broadcast('disaster', { phase, type: p.type });
    } else if (phase === 'recovery') {
      this.room.broadcast('disaster', { phase, type: p.type });
    }
  }

  spawnTornado(p) {
    const d = this.d, T = DISASTER.tornado;
    d.pushRadius = T.pushRadius; d.dangerRadius = T.dangerRadius;
    if (CONFIG.tornadoPath.length >= 2) {
      this.path = CONFIG.tornadoPath.map(([x, z]) => [x, z]);
    } else {
      // random walk along the road grid, starting on the ring far from the depot
      const ring = NODES.filter(([x, z]) => Math.abs(x) === 75 || Math.abs(z) === 75);
      let cur = ring[Math.floor(this.rng() * ring.length)], prev = null;
      const need = T.speed * (p.end - p.start + p.recover) + 60;
      this.path = [cur];
      let len = 0;
      while (len < need && this.path.length < 64) {
        const options = neighbours(cur).filter(n => !prev || n[0] !== prev[0] || n[1] !== prev[1]);
        const next = options[Math.floor(this.rng() * options.length)];
        len += Math.hypot(next[0] - cur[0], next[1] - cur[1]);
        prev = cur; cur = next; this.path.push(cur);
      }
    }
    this.pathIndex = 1;
    d.tx = this.path[0][0]; d.tz = this.path[0][1];
    d.heading = Math.atan2(this.path[1][0] - d.tx, this.path[1][1] - d.tz);
  }

  moveTornado(dt) {
    const d = this.d;
    if (this.path.length < 2) return;
    let step = DISASTER.tornado.speed * dt;
    let x = d.tx, z = d.tz;
    while (step > 0) {
      if (this.pathIndex >= this.path.length) {          // fixed paths ping-pong
        this.path.reverse(); this.pathIndex = 1;
      }
      const [wx, wz] = this.path[this.pathIndex];
      const dx = wx - x, dz = wz - z, len = Math.hypot(dx, dz);
      if (len <= step) { x = wx; z = wz; step -= len; this.pathIndex++; continue; }
      x += (dx / len) * step; z += (dz / len) * step;
      d.heading = Math.atan2(dx, dz);
      step = 0;
    }
    d.tx = x; d.tz = z;
  }

  spawnFlood() {
    const d = this.d, F = DISASTER.flood;
    let ids = CONFIG.forcedFloodZones;
    if (!ids.length) {
      const pool = FLOOD_ZONES.map(z => z.id);
      ids = [];
      while (ids.length < Math.min(F.zonesPerEvent, pool.length)) {
        const id = pool.splice(Math.floor(this.rng() * pool.length), 1)[0];
        ids.push(id);
      }
    }
    for (const id of ids) {
      const z = FLOOD_ZONES.find(f => f.id === id);
      const st = new FloodZoneState();
      Object.assign(st, { id: z.id, label: z.label, minX: z.minX, maxX: z.maxX, minZ: z.minZ, maxZ: z.maxZ, deep: z.deep, depth: z.deep ? F.depth.deep : F.depth.shallow });
      d.floods.set(id, st);
    }
  }
}

/* =====================================================================
   CityRoom — one persistent party session; matches loop inside it.
   ===================================================================== */
export class CityRoom extends Room {
  maxClients = GAME.maxPlayers;
  patchRate = NET.patchRateMs;
  seatReservationTimeout = 15;
  maxMessagesPerSecond = 90;   // flood protection: clients above this are disconnected

  async onCreate(options = {}) {
    const mode = options.mode === 'private' ? 'private' : 'public';

    // Short, unique, shareable room code doubles as the Colyseus roomId.
    let code = randomCode();
    for (let i = 0; i < 20 && (await matchMaker.query({ roomId: code })).length; i++) code = randomCode();
    this.roomId = code;

    this.state = new CityState();
    this.state.disaster = new DisasterState();
    Object.assign(this.state, {
      protocol: PROTOCOL_VERSION, roomCode: code, region: CONFIG.region, mode,
      maxPlayers: GAME.maxPlayers, joinable: true
    });
    for (const b of LAYOUT.buildings) {
      const d = new DestinationState();
      Object.assign(d, { id: b.id, label: b.label, x: b.doorX, z: b.doorZ, bx: b.x, bz: b.z });
      this.state.destinations.set(b.id, d);
    }

    this.sims = new Map();             // sessionId -> authoritative player simulation + bookkeeping
    this.vsims = new Map();            // vehicleId -> authoritative vehicle simulation
    this.cond = new Map();             // packageId -> float condition (schema holds the rounded value)
    this.groundInfo = new Map();       // packageId -> { since, ox, oz, moved } for packages on the ground
    this.packageCounter = 0;
    this.pendingSpawns = [];
    this.disasters = new DisasterController(this);
    for (const sp of LAYOUT.vehicleSpawns) {
      const v = new VehicleState();
      Object.assign(v, { id: sp.id, x: sp.x, z: sp.z, yaw: sp.yaw, speed: 0 });
      this.state.vehicles.set(sp.id, v);
      this.vsims.set(sp.id, { x: sp.x, z: sp.z, yaw: sp.yaw, speed: 0, spawn: sp, lastReset: 0, idleSince: Date.now() });
    }

    if (mode === 'private') await this.setPrivate(true);
    await this.setMetadata({ mode, region: CONFIG.region, code });

    this.onMessage('input', (client, msg) => this.safe(() => this.handleInput(client, msg)));
    this.onMessage('interact', (client) => this.safe(() => this.handleInteract(client)));
    this.onMessage('drop', (client) => this.safe(() => this.handleDrop(client)));
    this.onMessage('resetVehicle', (client) => this.safe(() => this.handleResetVehicle(client)));
    this.onMessage('emote', (client, msg) => this.safe(() => this.handleEmote(client, msg)));
    this.onMessage('*', () => { /* unknown message types are ignored */ });

    this.setTimestep(() => this.safe(() => this.tick()), 1000 / NET.tickRate);
    this.startMatch();
    console.log(`[room ${code}] created (${mode}, region ${CONFIG.region})`);
  }

  safe(fn) {
    try { fn(); } catch (err) { console.error(`[room ${this.roomId}] handler error:`, err); }
  }

  async onAuth(client, options = {}, context) {
    const origin = context?.headers?.get?.('origin') || '';
    if (!isOriginAllowed(origin)) {
      console.warn(`[room ${this.roomId}] rejected origin "${origin}"`);
      throw new ServerError(4403, 'Origin not allowed.');
    }
    if (options.protocol !== undefined && options.protocol !== PROTOCOL_VERSION) {
      throw new ServerError(4426, 'Game version mismatch — please reload.');
    }
    if (this.state.players.size >= GAME.maxPlayers) {
      throw new ServerError(4429, 'This room is full.');
    }
    const skin = sanitizeSkin(options.skin);
    let identity = null;
    if (options.cgToken) identity = await verifyCrazyGamesToken(options.cgToken);
    let name, verified = false, userId = null;
    if (identity) {
      name = cleanDisplayName(identity.username);
      verified = !!name;
      userId = identity.userId;
    }
    if (!name) name = this.makeGuestName();
    return { name, verified, userId, skin };
  }

  makeGuestName() {
    const taken = new Set([...this.state.players.values()].map(p => p.name));
    for (let i = 0; i < 50; i++) {
      const n = `Courier${100 + Math.floor(Math.random() * 900)}`;
      if (!taken.has(n)) return n;
    }
    return `Courier${Date.now() % 100000}`;
  }

  onJoin(client) {
    const auth = client.auth || {};
    const now = Date.now();
    const p = new PlayerState();
    // Late-join policy: spectate until the next round once the match is under way,
    // unless the room has fewer than 2 active couriers (e.g. a host waiting for friends).
    const lateJoin = this.state.phase === 'playing'
      && now - this.state.matchStartedAt > CONFIG.lateJoinWindowSeconds * 1000
      && this.state.activeCount >= 2;
    Object.assign(p, {
      sessionId: client.sessionId, name: auth.name, verified: !!auth.verified, skin: auth.skin || 1,
      role: lateJoin ? 'spectator' : 'active', connected: true, slot: this.freeSlot()
    });
    const sim = this.createSim(p.slot);
    this.sims.set(client.sessionId, sim);
    this.writePlayer(p, sim);
    this.state.players.set(client.sessionId, p);
    this.updateCounts();
    console.log(`[room ${this.roomId}] ${p.name} joined as ${p.role} (${this.state.playerCount}/${GAME.maxPlayers})`);
  }

  async onDrop(client) {
    const p = this.state.players.get(client.sessionId);
    if (p) p.connected = false;
    const sim = this.sims.get(client.sessionId);
    if (sim) { sim.queue.length = 0; sim.velocity.x = sim.velocity.z = 0; sim.moving = false; }
    if (p?.driving) {                               // stop the truck safely while we wait
      const vs = this.vsims.get(p.driving);
      if (vs) vs.speed = 0;
    }
    if (p && sim) this.writePlayer(p, sim);
    console.log(`[room ${this.roomId}] ${p?.name} dropped — holding seat ${CONFIG.reconnectSeconds}s`);
    this.allowReconnection(client, CONFIG.reconnectSeconds);
  }

  onReconnect(client) {
    const p = this.state.players.get(client.sessionId);
    if (p) p.connected = true;
    console.log(`[room ${this.roomId}] ${p?.name} reconnected`);
  }

  onLeave(client) {
    const sid = client.sessionId;
    const p = this.state.players.get(sid);
    const sim = this.sims.get(sid);
    if (p?.driving) this.releaseVehicle(p, sim, false);
    if (p?.carrying && sim) this.dropPackage(p, sim, 0);   // package stays in the world
    this.state.players.delete(sid);
    this.sims.delete(sid);
    this.updateCounts();
    console.log(`[room ${this.roomId}] ${p?.name || sid} left (${this.state.playerCount}/${GAME.maxPlayers})`);
  }

  onDispose() {
    console.log(`[room ${this.roomId}] disposed`);
  }

  /* ---------------- helpers ---------------- */
  freeSlot() {
    const used = new Set([...this.state.players.values()].map(p => p.slot));
    for (let i = 0; i < GAME.maxPlayers; i++) if (!used.has(i)) return i;
    return 0;
  }

  createSim(slot) {
    const sp = LAYOUT.spawnPoints[slot % LAYOUT.spawnPoints.length];
    return {
      position: { x: sp.x, y: sp.y, z: sp.z }, velocity: { x: 0, z: 0 }, impulse: { x: 0, z: 0 },
      rotationY: sp.rotY, moving: false,
      queue: [], lastQueuedSeq: 0, lastSeq: 0, budget: 1,
      lastInteract: 0, lastEmote: 0, protectedUntil: 0
    };
  }

  respawn(p, sim) {
    const sp = LAYOUT.spawnPoints[p.slot % LAYOUT.spawnPoints.length];
    sim.position.x = sp.x; sim.position.y = sp.y; sim.position.z = sp.z;
    sim.velocity.x = 0; sim.velocity.z = 0; sim.impulse.x = 0; sim.impulse.z = 0;
    sim.rotationY = sp.rotY; sim.moving = false;
  }

  writePlayer(p, sim) {
    const s = sim;
    if (p.x !== s.position.x) p.x = s.position.x;
    if (p.y !== s.position.y) p.y = s.position.y;
    if (p.z !== s.position.z) p.z = s.position.z;
    if (p.rotY !== s.rotationY) p.rotY = s.rotationY;
    if (p.vx !== s.velocity.x) p.vx = s.velocity.x;
    if (p.vz !== s.velocity.z) p.vz = s.velocity.z;
    if (p.ix !== s.impulse.x) p.ix = s.impulse.x;
    if (p.iz !== s.impulse.z) p.iz = s.impulse.z;
    if (p.moving !== s.moving) { p.moving = s.moving; p.anim = s.moving ? 'run' : 'idle'; }
    if (p.ack !== s.lastSeq) p.ack = s.lastSeq;
  }

  writeVehicle(v, vs) {
    if (v.x !== vs.x) v.x = vs.x;
    if (v.z !== vs.z) v.z = vs.z;
    if (v.yaw !== vs.yaw) v.yaw = vs.yaw;
    if (v.speed !== vs.speed) v.speed = vs.speed;
    const st = v.driverId ? 'driving' : 'parked';
    if (v.state !== st) v.state = st;
  }

  updateCounts() {
    let active = 0;
    for (const p of this.state.players.values()) if (p.role === 'active') active++;
    this.state.playerCount = this.state.players.size;
    this.state.activeCount = active;
    this.state.joinable = this.state.players.size < GAME.maxPlayers;
  }

  /* Movement modifiers for a walking player: carried weight, flood water, trucks. */
  walkMods(p, floods, circles) {
    let carryMul = 1, canSprint = true;
    if (p.carrying) {
      const pkg = this.state.packages.get(p.carrying);
      if (pkg) { const w = weightOf(pkg.type); carryMul = w.speedMul || 1; canSprint = w.canSprint; }
    }
    return { carryMul, canSprint, floods, circles };
  }

  /* ---------------- package condition ---------------- */
  damagePackage(pkg, amount, reason) {
    if (!pkg || amount <= 0) return;
    const c = Math.max(0, (this.cond.get(pkg.id) ?? pkg.condition) - amount);
    this.cond.set(pkg.id, c);
    const rounded = Math.ceil(c);
    if (pkg.condition !== rounded) pkg.condition = rounded;
    if (c <= 0) this.breakPackage(pkg, reason);
  }

  breakPackage(pkg, reason) {
    // Rule: a broken package is removed for everyone and a fresh one is restocked at the depot.
    const carrier = pkg.carrierId && this.state.players.get(pkg.carrierId);
    if (carrier && carrier.carrying === pkg.id) carrier.carrying = '';
    if (pkg.vehicleId) {
      const v = this.state.vehicles.get(pkg.vehicleId);
      const i = v ? v.cargo.indexOf(pkg.id) : -1;
      if (i >= 0) v.cargo.splice(i, 1);
    }
    this.broadcast('feed', { kind: 'broken', type: pkg.type, reason, name: carrier?.name || '' });
    this.removePackage(pkg.id, true, CONDITION.brokenRespawnSeconds);
  }

  removePackage(id, respawn, delaySeconds = GAME.packageRespawnSeconds) {
    if (!this.state.packages.has(id)) return;
    this.state.packages.delete(id);
    this.cond.delete(id);
    this.groundInfo.delete(id);
    if (respawn && this.state.phase === 'playing') this.pendingSpawns.push(Date.now() + delaySeconds * 1000);
  }

  /* Put a carried package on the ground next to the player. */
  dropPackage(p, sim, damage, offset = 0.9) {
    const pkg = this.state.packages.get(p.carrying);
    p.carrying = '';
    if (!pkg) return;
    let x = sim.position.x + Math.sin(sim.rotationY) * offset;
    let z = sim.position.z + Math.cos(sim.rotationY) * offset;
    const pos = { x, y: 0.3, z };
    WORLD.resolveCircle(pos, 0.5, { x: 0, z: 0 });
    x = clamp(pos.x, -MAP.playHalf, MAP.playHalf); z = clamp(pos.z, -MAP.playHalf, MAP.playHalf);
    Object.assign(pkg, { status: 'available', carrierId: '', vehicleId: '', slot: -1, x, z, y: WORLD.groundHeight(x, z) });
    this.groundInfo.set(pkg.id, { since: Date.now(), ox: x, oz: z, moved: 0 });
    if (damage > 0) this.damagePackage(pkg, damage, 'dropped');
  }

  /* ---------------- vehicles ---------------- */
  enterVehicle(p, sim, v) {
    const vs = this.vsims.get(v.id);
    if (!vs || v.driverId) return false;
    v.driverId = p.sessionId;
    p.driving = v.id;
    sim.velocity.x = sim.velocity.z = 0; sim.impulse.x = sim.impulse.z = 0; sim.moving = false;
    sim.position.x = vs.x; sim.position.z = vs.z;
    vs.idleSince = 0;
    return true;
  }

  /* Find a free spot beside the truck. Returns false if none (stay inside). */
  releaseVehicle(p, sim, requireSpace = true) {
    const v = this.state.vehicles.get(p.driving);
    const vs = v && this.vsims.get(v.id);
    p.driving = '';
    if (!v || !vs) return true;
    v.driverId = '';
    vs.speed = 0;
    vs.idleSince = Date.now();
    if (!sim) return true;
    const g = vehicleGeometry(vs);
    const candidates = [
      [vs.x + g.rx * 2.9 + g.fx * 1.5, vs.z + g.rz * 2.9 + g.fz * 1.5],
      [vs.x - g.rx * 2.9 + g.fx * 1.5, vs.z - g.rz * 2.9 + g.fz * 1.5],
      [g.rearX - g.fx * 0.8, g.rearZ - g.fz * 0.8],
      [vs.x + g.fx * 6.2, vs.z + g.fz * 6.2]
    ];
    const circles = vehicleCircles(this.state.vehicles.values());
    for (const [x, z] of candidates) {
      if (Math.abs(x) > MAP.playHalf || Math.abs(z) > MAP.playHalf) continue;
      const pos = { x, y: WORLD.groundHeight(x, z), z }, n = { x: 0, z: 0 };
      WORLD.resolveCircle(pos, 0.5, n);
      const blockedByTruck = circles.some(c => Math.hypot(pos.x - c.x, pos.z - c.z) < VEHICLE.radius + 0.5);
      if (Math.hypot(pos.x - x, pos.z - z) < 0.05 && !blockedByTruck) {
        sim.position.x = x; sim.position.z = z; sim.position.y = pos.y;
        sim.velocity.x = sim.velocity.z = 0;
        return true;
      }
    }
    if (!requireSpace) { sim.position.x = vs.x + g.rx * 2.9; sim.position.z = vs.z + g.rz * 2.9; return true; }
    // nowhere to stand: stay in the truck
    p.driving = v.id; v.driverId = p.sessionId; vs.idleSince = 0;
    return false;
  }

  resetVehicleToSpawn(v, vs) {
    const sp = vs.spawn;
    Object.assign(vs, { x: sp.x, z: sp.z, yaw: sp.yaw, speed: 0, lastReset: Date.now(), idleSince: Date.now() });
    this.writeVehicle(v, vs);
  }

  spawnIsFree(vs) {
    for (const [id, o] of this.vsims) if (o !== vs && Math.hypot(o.x - vs.spawn.x, o.z - vs.spawn.z) < 6) return false;
    for (const s of this.sims.values()) if (Math.hypot(s.position.x - vs.spawn.x, s.position.z - vs.spawn.z) < 5.5) return false;
    return true;
  }

  /* ---------------- messages ---------------- */
  handleInput(client, msg) {
    const p = this.state.players.get(client.sessionId);
    const sim = this.sims.get(client.sessionId);
    if (!p || !sim || p.role !== 'active') return;
    const list = msg && Array.isArray(msg.i) ? msg.i : null;
    if (!list || list.length === 0 || list.length > NET.maxInputsPerMessage) return;
    for (const tuple of list) {
      if (!Array.isArray(tuple) || tuple.length !== 4) return;
      const seq = tuple[0];
      if (!Number.isInteger(seq) || seq <= sim.lastQueuedSeq || seq > 2 ** 31) continue;
      const flags = Number.isInteger(tuple[3]) ? tuple[3] : (tuple[3] === true ? 1 : 0);
      const driveMode = (flags & 2) !== 0;
      const input = driveMode
        ? sanitizeDriveInput({ steer: tuple[1], throttle: tuple[2], brake: (flags & 1) !== 0 })
        : sanitizeMoveInput({ mx: tuple[1], mz: tuple[2], sp: (flags & 1) !== 0 });
      if (!input) continue;
      input.seq = seq;
      input.drive = driveMode;
      sim.lastQueuedSeq = seq;
      sim.queue.push(input);
    }
    // Excess inputs (speed hacking / flooding) are discarded instead of simulated.
    if (sim.queue.length > NET.inputQueueCap) sim.queue.splice(0, sim.queue.length - NET.inputQueueCap);
  }

  handleInteract(client) {
    const sid = client.sessionId;
    const p = this.state.players.get(sid);
    const sim = this.sims.get(sid);
    if (!p || !sim || p.role !== 'active' || !p.connected) return;
    const now = Date.now();
    if (now - sim.lastInteract < GAME.interactCooldownMs) return;
    sim.lastInteract = now;
    if (this.state.phase !== 'playing') return;
    const s = this.state;
    const act = resolveInteraction({
      x: sim.position.x, z: sim.position.z, carrying: p.carrying, driving: p.driving,
      packages: s.packages, vehicles: s.vehicles, destinations: s.destinations
    });
    const pkg = act.packageId ? s.packages.get(act.packageId) : null;
    const v = act.vehicleId ? s.vehicles.get(act.vehicleId) : null;
    const reply = (ok, extra = {}) => client.send('interactResult', { ok, kind: act.kind, ...extra });

    switch (act.kind) {
      case 'deliver':
      case 'deliverFromTruck': {
        const reward = deliveryReward(pkg.reward, pkg.condition);
        if (reward <= 0) { reply(false, { reason: 'broken' }); return; }
        if (act.kind === 'deliver') p.carrying = '';
        else { const i = v.cargo.indexOf(pkg.id); if (i >= 0) v.cargo.splice(i, 1); }
        p.score += reward;
        p.deliveries += 1;
        const condition = pkg.condition, type = pkg.type;
        this.removePackage(pkg.id, true);
        reply(true, { reward, type, condition });
        this.broadcast('feed', { kind: 'delivered', sid, name: p.name, reward, type, condition });
        return;
      }
      case 'pickup':
        Object.assign(pkg, { status: 'carried', carrierId: sid, vehicleId: '', slot: -1 });
        this.groundInfo.delete(pkg.id);
        p.carrying = pkg.id;
        reply(true, { id: pkg.id, type: pkg.type });
        return;
      case 'loadCarried':
        Object.assign(pkg, { status: 'loaded', carrierId: '', vehicleId: v.id });
        v.cargo.push(pkg.id);
        p.carrying = '';
        reply(true, { id: pkg.id, type: pkg.type });
        return;
      case 'loadHeavy':
        Object.assign(pkg, { status: 'loaded', carrierId: '', vehicleId: v.id, slot: -1 });
        this.groundInfo.delete(pkg.id);
        v.cargo.push(pkg.id);
        reply(true, { id: pkg.id, type: pkg.type });
        return;
      case 'unload': {
        const i = v.cargo.indexOf(pkg.id);
        if (i >= 0) v.cargo.splice(i, 1);
        Object.assign(pkg, { status: 'carried', carrierId: sid, vehicleId: '' });
        p.carrying = pkg.id;
        reply(true, { id: pkg.id, type: pkg.type });
        return;
      }
      case 'enterVehicle':
        if (this.enterVehicle(p, sim, v)) reply(true, { vehicleId: v.id });
        else reply(false, { reason: 'occupied' });
        return;
      case 'exitVehicle':
        if (this.releaseVehicle(p, sim, true)) reply(true, { vehicleId: act.vehicleId });
        else reply(false, { reason: 'noRoomToExit' });
        return;
      default:
        reply(false, { reason: act.reason || 'nothingNearby' });
    }
  }

  handleDrop(client) {
    const p = this.state.players.get(client.sessionId);
    const sim = this.sims.get(client.sessionId);
    if (!p || !sim || !p.carrying || p.driving || this.state.phase !== 'playing') return;
    const pkg = this.state.packages.get(p.carrying);
    const speed = Math.hypot(sim.velocity.x, sim.velocity.z);
    const dmg = pkg && packageDef(pkg.type).fragile && speed > CONDITION.dropSpeedThreshold ? CONDITION.dropDamage : 0;
    this.dropPackage(p, sim, dmg);
  }

  /* Server-authorized reset: driver only, empty truck, slow, cooldown, free spawn. */
  handleResetVehicle(client) {
    const p = this.state.players.get(client.sessionId);
    if (!p?.driving) return;
    const v = this.state.vehicles.get(p.driving), vs = v && this.vsims.get(v.id);
    if (!vs) return;
    const now = Date.now();
    let reason = null;
    if (v.cargo.length) reason = 'unloadFirst';
    else if (Math.abs(vs.speed) > 1) reason = 'stopFirst';
    else if (now - vs.lastReset < VEHICLE.resetCooldownSeconds * 1000) reason = 'cooldown';
    else if (!this.spawnIsFree(vs)) reason = 'spawnBlocked';
    if (reason) { client.send('interactResult', { ok: false, kind: 'resetVehicle', reason }); return; }
    this.resetVehicleToSpawn(v, vs);
    const sim = this.sims.get(client.sessionId);
    if (sim) { sim.position.x = vs.x; sim.position.z = vs.z; }
    client.send('interactResult', { ok: true, kind: 'resetVehicle' });
  }

  handleEmote(client, msg) {
    const sim = this.sims.get(client.sessionId);
    const p = this.state.players.get(client.sessionId);
    if (!sim || !p) return;
    const id = msg && msg.id;
    if (!Number.isInteger(id) || id < 0 || id >= EMOTES.length) return;
    const now = Date.now();
    if (now - sim.lastEmote < GAME.emoteCooldownMs) return;
    sim.lastEmote = now;
    this.broadcast('emote', { sid: client.sessionId, id });
  }

  /* ---------------- match flow ---------------- */
  startMatch() {
    const now = Date.now();
    const s = this.state;
    s.phase = 'playing';
    s.matchNumber += 1;
    s.matchStartedAt = now;
    s.matchEndsAt = now + CONFIG.matchSeconds * 1000;
    s.phaseEndsAt = s.matchEndsAt;
    s.timeLeft = Math.ceil(CONFIG.matchSeconds);
    s.results.clear();
    s.packages.clear();
    this.cond.clear(); this.groundInfo.clear();
    this.pendingSpawns.length = 0;
    // trucks back to the depot, empty
    for (const [id, v] of s.vehicles) {
      v.driverId = ''; v.cargo.clear();
      this.resetVehicleToSpawn(v, this.vsims.get(id));
      this.vsims.get(id).lastReset = 0;
    }
    for (const [sid, p] of s.players) {
      const sim = this.sims.get(sid);
      p.role = 'active';            // spectators with reserved slots join the new round
      p.score = 0; p.deliveries = 0; p.carrying = ''; p.driving = '';
      if (sim) { this.respawn(p, sim); this.writePlayer(p, sim); }
    }
    this.disasters.reset(now);
    for (let i = 0; i < GAME.maxPackages; i++) this.spawnPackage();
    this.updateCounts();
    this.broadcast('matchStart', { matchNumber: s.matchNumber });
  }

  endMatch() {
    const now = Date.now();
    const s = this.state;
    s.phase = 'results';
    s.phaseEndsAt = now + CONFIG.intermissionSeconds * 1000;
    s.timeLeft = Math.ceil(CONFIG.intermissionSeconds);
    const ranked = [...s.players.values()]
      .filter(p => p.role === 'active')
      .sort((a, b) => b.score - a.score || b.deliveries - a.deliveries || a.name.localeCompare(b.name));
    s.results.clear();
    let rank = 0, prevScore = -1;
    ranked.forEach((p, i) => {
      if (p.score !== prevScore) { rank = i + 1; prevScore = p.score; }
      const r = new ResultEntry();
      Object.assign(r, { sessionId: p.sessionId, name: p.name, score: p.score, deliveries: p.deliveries, rank });
      s.results.push(r);
    });
    for (const p of s.players.values()) p.carrying = '';
    for (const v of s.vehicles.values()) { v.cargo.clear(); this.vsims.get(v.id).speed = 0; }
    s.packages.clear();
    this.cond.clear(); this.groundInfo.clear();
    this.pendingSpawns.length = 0;
    this.disasters.plan = [];          // no hazards during results; cleared now
    this.disasters.clear();
    this.disasters.current = -1;
    this.broadcast('matchEnd', { matchNumber: s.matchNumber });
  }

  pickPackageType() {
    const pool = CONFIG.packagePool.length ? CONFIG.packagePool.map(k => [k, PACKAGE_TYPES[k]]) : Object.entries(PACKAGE_TYPES);
    const total = pool.reduce((sum, [, d]) => sum + d.spawnWeight, 0);
    let roll = Math.random() * total;
    for (const [k, d] of pool) { roll -= d.spawnWeight; if (roll <= 0) return k; }
    return pool[0][0];
  }

  freePadSlot() {
    const used = new Set();
    for (const pkg of this.state.packages.values()) if (pkg.status === 'available' && pkg.slot >= 0) used.add(pkg.slot);
    for (let i = 0; i < LAYOUT.packageSlots.length; i++) if (!used.has(i)) return i;
    return -1;
  }

  spawnPackage() {
    if (this.state.packages.size >= GAME.maxPackages) return false;
    const slot = this.freePadSlot();
    if (slot < 0) return false;
    const destInUse = new Set([...this.state.packages.values()].map(p => p.destinationId));
    const type = this.pickPackageType();
    const candidates = LAYOUT.buildings.filter(b => !destInUse.has(b.id));
    const pool = candidates.length ? candidates : LAYOUT.buildings;
    const dest = pool[Math.floor(Math.random() * pool.length)];
    const pkg = new PackageState();
    const sp = LAYOUT.packageSlots[slot];
    this.packageCounter += 1;
    Object.assign(pkg, {
      id: `P${this.state.matchNumber}-${this.packageCounter}`, type, status: 'available', carrierId: '', vehicleId: '',
      slot, x: sp.x, y: sp.y, z: sp.z, destinationId: dest.id, reward: PACKAGE_TYPES[type].reward, condition: 100
    });
    this.cond.set(pkg.id, 100);
    this.state.packages.set(pkg.id, pkg);
    return true;
  }

  /* ---------------- hazards ---------------- */
  applyTornado(now, floods) {
    const d = this.state.disaster, T = DISASTER.tornado;
    const active = this.disasters.tornadoActive;
    if (!active) return;
    const s = this.state, push = d.pushRadius, danger = d.dangerRadius;
    const scale = d.level;
    for (const [sid, p] of s.players) {
      const sim = this.sims.get(sid);
      if (!sim || p.role !== 'active' || !p.connected) continue;
      if (p.driving) continue;   // trucks are heavy: drivers are protected, cargo is not (below)
      const dx = sim.position.x - d.tx, dz = sim.position.z - d.tz;
      const dd = Math.hypot(dx, dz);
      if (dd >= push) continue;
      const strength = (1 - dd / push) ** 2 * scale;
      const rx = dd > 0.01 ? dx / dd : 1, rz = dd > 0.01 ? dz / dd : 0;
      let fx = rx * 0.55 - rz * 0.85, fz = rz * 0.55 + rx * 0.85;   // outward + swirl
      const fl = Math.hypot(fx, fz); fx /= fl; fz /= fl;
      const protectedNow = now < sim.protectedUntil;
      const mul = protectedNow ? 0.25 : 1;
      sim.impulse.x += fx * T.force * strength * DT * mul;
      sim.impulse.z += fz * T.force * strength * DT * mul;
      const il = Math.hypot(sim.impulse.x, sim.impulse.z);
      if (il > T.maxImpulse) { sim.impulse.x *= T.maxImpulse / il; sim.impulse.z *= T.maxImpulse / il; }

      const pkg = p.carrying ? s.packages.get(p.carrying) : null;
      if (pkg && dd < danger) {
        const rate = packageDef(pkg.type).fragile ? T.carryDamagePerSec.fragile : T.carryDamagePerSec.normal;
        this.damagePackage(pkg, rate * DT * scale, 'tornado');
      }
      if (dd < T.coreRadius && !protectedNow) {
        sim.protectedUntil = now + T.protectSeconds * 1000;   // brief recovery protection
        sim.impulse.x += fx * T.maxImpulse * 0.6; sim.impulse.z += fz * T.maxImpulse * 0.6;
        const cur = p.carrying ? s.packages.get(p.carrying) : null;
        if (cur) {
          const dmg = packageDef(cur.type).fragile ? T.knockDamage.fragile : T.knockDamage.normal;
          this.dropPackage(p, sim, dmg, 2.2);   // knocked out of the courier's hands
        }
        const client = this.clients.find(c => c.sessionId === sid);
        client?.send('hazard', { kind: 'knocked' });
      }
    }
    // unclaimed packages on the ground drift with the wind (limited, stays in map)
    for (const pkg of s.packages.values()) {
      if (pkg.status !== 'available') continue;
      const dx = pkg.x - d.tx, dz = pkg.z - d.tz, dd = Math.hypot(dx, dz);
      if (dd >= push) continue;
      const def = packageDef(pkg.type), w = weightOf(pkg.type);
      const strength = (1 - dd / push) ** 2 * scale;
      if (def.fragile) this.damagePackage(pkg, T.groundFragileDamagePerSec * strength * DT, 'tornado');
      if (!s.packages.has(pkg.id) || w.tornadoPush <= 0) continue;
      let info = this.groundInfo.get(pkg.id);
      if (!info) { info = { since: now, ox: pkg.x, oz: pkg.z, moved: 0 }; this.groundInfo.set(pkg.id, info); }
      if (info.moved >= T.groundMaxDisplacement) continue;
      const rx = dd > 0.01 ? dx / dd : 1, rz = dd > 0.01 ? dz / dd : 0;
      const stepLen = Math.min(T.groundPushSpeed * strength * w.tornadoPush * DT, T.groundMaxDisplacement - info.moved);
      const pos = { x: pkg.x + (rx * 0.55 - rz * 0.85) * stepLen, y: 0.3, z: pkg.z + (rz * 0.55 + rx * 0.85) * stepLen };
      WORLD.resolveCircle(pos, 0.5, { x: 0, z: 0 });
      pos.x = clamp(pos.x, -MAP.playHalf, MAP.playHalf); pos.z = clamp(pos.z, -MAP.playHalf, MAP.playHalf);
      info.moved += Math.hypot(pos.x - pkg.x, pos.z - pkg.z);
      info.since = now;
      pkg.x = pos.x; pkg.z = pos.z; pkg.y = WORLD.groundHeight(pos.x, pos.z);
      if (pkg.slot >= 0) pkg.slot = -1;
    }
    // cargo in trucks caught by the funnel
    for (const v of s.vehicles.values()) {
      if (!v.cargo.length || Math.hypot(v.x - d.tx, v.z - d.tz) >= danger) continue;
      for (const id of [...v.cargo]) {
        const pkg = s.packages.get(id);
        if (pkg && packageDef(pkg.type).fragile) this.damagePackage(pkg, T.vehicleCargoDamagePerSec * DT * scale, 'tornado');
      }
    }
  }

  applyFloodAndGround(now, floods) {
    for (const pkg of this.state.packages.values()) {
      if (pkg.status !== 'available') continue;
      if (floods && packageDef(pkg.type).waterSensitive) {
        const f = floodAt(floods, pkg.x, pkg.z);
        if (f && f.depth > 0.1) { this.damagePackage(pkg, DISASTER.flood.groundDamagePerSec * DT, 'water'); if (!this.state.packages.has(pkg.id)) continue; }
      }
      // packages left lying around return to a free depot pad
      const info = this.groundInfo.get(pkg.id);
      if (pkg.slot < 0 && info && now - info.since > CONDITION.groundReturnSeconds * 1000) {
        const slot = this.freePadSlot();
        if (slot >= 0) {
          const sp = LAYOUT.packageSlots[slot];
          Object.assign(pkg, { slot, x: sp.x, y: sp.y, z: sp.z });
          this.groundInfo.delete(pkg.id);
        }
      }
    }
  }

  /* ---------------- fixed-step simulation ---------------- */
  tick() {
    const now = Date.now();
    const s = this.state;
    const playing = s.phase === 'playing';

    if (playing) this.disasters.update(now);
    const floods = playing ? this.disasters.floodsForPhysics : null;
    if (playing) this.applyTornado(now, floods);

    const allTrucks = [...this.vsims.entries()].map(([id, vs]) => ({ id, x: vs.x, z: vs.z, yaw: vs.yaw }));
    const truckCircles = vehicleCircles(allTrucks);

    for (const [sid, p] of s.players) {
      const sim = this.sims.get(sid);
      if (!sim || p.role !== 'active' || !p.connected) continue;
      sim.budget = Math.min(sim.budget + 1, NET.inputBudgetCap);
      const v = p.driving ? s.vehicles.get(p.driving) : null;
      const vs = v ? this.vsims.get(v.id) : null;
      const walkMods = vs ? null : this.walkMods(p, floods, truckCircles);
      const driveMods = vs ? { floods, circles: vehicleCircles(allTrucks, v.id) } : null;
      while (sim.budget >= 1 && sim.queue.length) {
        const input = sim.queue.shift();
        if (vs) {
          const drive = playing && input.drive ? input : ZERO_DRIVE;
          const impact = stepVehicle(vs, drive, DT, WORLD, driveMods);
          if (impact > VEHICLE.crashSpeed && v.cargo.length) {
            for (const id of [...v.cargo]) {
              const pkg = s.packages.get(id);
              if (pkg && packageDef(pkg.type).fragile) this.damagePackage(pkg, (impact - VEHICLE.crashSpeed) * VEHICLE.crashDamagePerUnit, 'crash');
            }
          }
          sim.position.x = vs.x; sim.position.z = vs.z; sim.position.y = WORLD.groundHeight(vs.x, vs.z);
          sim.rotationY = vs.yaw;
        } else {
          const walk = playing && !input.drive ? input : ZERO_WALK;
          stepMovement(sim, walk, DT, WORLD, walkMods);
        }
        sim.lastSeq = input.seq;
        sim.budget -= 1;
      }
      if (vs) this.writeVehicle(v, vs);
      this.writePlayer(p, sim);
    }

    for (const [id, vs] of this.vsims) this.writeVehicle(s.vehicles.get(id), vs);   // parked/dropped trucks too

    if (playing) {
      this.applyFloodAndGround(now, floods);
      // idle trucks far from the depot drive themselves home (only when empty)
      for (const [id, vs] of this.vsims) {
        const v = s.vehicles.get(id);
        if (v.driverId || v.cargo.length || !vs.idleSince) continue;
        if (now - vs.idleSince > VEHICLE.idleReturnSeconds * 1000 && Math.hypot(vs.x - vs.spawn.x, vs.z - vs.spawn.z) > 15 && this.spawnIsFree(vs)) {
          this.resetVehicleToSpawn(v, vs);
        }
      }
      if (now >= s.matchEndsAt) { this.endMatch(); return; }
      for (let i = this.pendingSpawns.length - 1; i >= 0; i--) {
        if (now >= this.pendingSpawns[i]) { this.pendingSpawns.splice(i, 1); this.spawnPackage(); }
      }
      if (this.pendingSpawns.length === 0 && s.packages.size < GAME.maxPackages) this.spawnPackage();
    } else if (now >= s.phaseEndsAt) {
      this.startMatch();
      return;
    }
    const left = Math.max(0, Math.ceil((s.phaseEndsAt - now) / 1000));
    if (s.timeLeft !== left) s.timeLeft = left;
  }
}

/* =====================================================================
   Server bootstrap
   ===================================================================== */
const baseCors = matchMaker.controller.getCorsHeaders.bind(matchMaker.controller);
matchMaker.controller.getCorsHeaders = function (headers) {
  const base = baseCors(headers);
  const origin = headers?.get?.('origin') || '';
  if (origin && isOriginAllowed(origin)) return { ...base, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  if (!origin) return base;
  return { ...base, 'Access-Control-Allow-Origin': 'null' };
};

/* Single instance per region → in-memory presence/driver (no Redis needed).
   Set REDIS_URI only if you scale a region to several instances. Without this,
   Colyseus Cloud auto-selects Redis on multi-core hosts and waits forever for it. */
const useRedis = !!env.REDIS_URI;
export const server = defineServer({
  presence: useRedis ? new RedisPresence(env.REDIS_URI) : new LocalPresence(),
  driver: useRedis ? new RedisDriver(env.REDIS_URI) : new LocalDriver(),
  rooms: {
    city: defineRoom(CityRoom).filterBy(['mode'])
  },
  express: (app) => {
    app.get('/health', (req, res) => {
      res.json({ ok: true, region: CONFIG.region, protocol: PROTOCOL_VERSION });
    });
  }
});

export { CONFIG, CloseCode, LAYOUT };
