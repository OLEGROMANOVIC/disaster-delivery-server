/* =====================================================================
   DISASTER DELIVERY — Colyseus game server logic (Colyseus 0.18)
   Started by server.js (local + Colyseus Cloud). Imported by tests.
   ===================================================================== */
import { defineServer, defineRoom, Room, ServerError, matchMaker, CloseCode, LocalPresence, LocalDriver, RedisPresence, RedisDriver } from 'colyseus';
import { schema, t } from '@colyseus/schema';
import jwt from 'jsonwebtoken';
import {
  NET, GAME, PACKAGE_TYPES, EMOTES, ROOM_CODE, PROTOCOL_VERSION,
  buildLayout, createPhysicsWorld, stepMovement, sanitizeMoveInput, sanitizeSkin, distanceXZ
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
  crazyGamesGameId: env.CRAZYGAMES_GAME_ID || '' // optional: reject tokens issued for other games
};

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
  role: t.string().default('active'),   // 'active' | 'spectator'
  connected: t.boolean().default(true),
  slot: t.uint8().default(0),
  x: t.float32().default(0), y: t.float32().default(0), z: t.float32().default(0),
  rotY: t.float32().default(0),
  vx: t.float32().default(0), vz: t.float32().default(0),
  moving: t.boolean().default(false),
  anim: t.string().default('idle'),     // 'run' | 'idle'
  ack: t.uint32().default(0),                // last processed input sequence (for client reconciliation)
  score: t.uint32().default(0),
  deliveries: t.uint16().default(0),
  carrying: t.string().default('')      // package id or ''
}, 'PlayerState');

const PackageState = schema({
  id: t.string().default(''),
  type: t.string().default(''),
  status: t.string().default('available'), // 'available' | 'carried'
  carrierId: t.string().default(''),
  slot: t.uint8().default(0),
  x: t.float32().default(0), y: t.float32().default(0), z: t.float32().default(0),
  destinationId: t.string().default(''),
  reward: t.uint16().default(0)
}, 'PackageState');

const DestinationState = schema({
  id: t.string().default(''),
  label: t.string().default(''),
  x: t.float32().default(0), z: t.float32().default(0),          // delivery point (building door)
  bx: t.float32().default(0), bz: t.float32().default(0)         // building centre (marker)
}, 'DestinationState');

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
  mode: t.string().default(''),                        // 'public' | 'private'
  phase: t.string().default('playing'),    // 'playing' | 'results'
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
  results: t.array(ResultEntry)
}, 'CityState');

/* Deterministic city shared with the client. */
const LAYOUT = buildLayout();
const WORLD = createPhysicsWorld(LAYOUT);
const ZERO_INPUT = { mx: 0, mz: 0, sp: false };
const PACKAGE_WEIGHTS = Object.entries(PACKAGE_TYPES);
const TOTAL_WEIGHT = PACKAGE_WEIGHTS.reduce((s, [, p]) => s + p.weight, 0);

function randomCode() {
  let s = '';
  for (let i = 0; i < ROOM_CODE.length; i++) s += ROOM_CODE.alphabet[Math.floor(Math.random() * ROOM_CODE.alphabet.length)];
  return s;
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
    Object.assign(this.state, {
      protocol: PROTOCOL_VERSION, roomCode: code, region: CONFIG.region, mode,
      maxPlayers: GAME.maxPlayers, joinable: true
    });
    for (const b of LAYOUT.buildings) {
      const d = new DestinationState();
      Object.assign(d, { id: b.id, label: b.label, x: b.doorX, z: b.doorZ, bx: b.x, bz: b.z });
      this.state.destinations.set(b.id, d);
    }

    this.sims = new Map();           // sessionId -> authoritative simulation + rate-limit bookkeeping
    this.packageCounter = 0;
    this.pendingSpawns = [];         // timestamps for package respawns

    if (mode === 'private') await this.setPrivate(true);
    await this.setMetadata({ mode, region: CONFIG.region, code });

    this.onMessage('input', (client, msg) => this.safe(() => this.handleInput(client, msg)));
    this.onMessage('interact', (client) => this.safe(() => this.handleInteract(client)));
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
    if (p?.carrying) this.removePackage(p.carrying, true);
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
      position: { x: sp.x, y: sp.y, z: sp.z }, velocity: { x: 0, z: 0 }, rotationY: sp.rotY, moving: false,
      queue: [], lastQueuedSeq: 0, lastSeq: 0, budget: 1,
      lastInteract: 0, lastEmote: 0
    };
  }

  respawn(p, sim) {
    const sp = LAYOUT.spawnPoints[p.slot % LAYOUT.spawnPoints.length];
    sim.position.x = sp.x; sim.position.y = sp.y; sim.position.z = sp.z;
    sim.velocity.x = 0; sim.velocity.z = 0; sim.rotationY = sp.rotY; sim.moving = false;
  }

  writePlayer(p, sim) {
    const s = sim;
    if (p.x !== s.position.x) p.x = s.position.x;
    if (p.y !== s.position.y) p.y = s.position.y;
    if (p.z !== s.position.z) p.z = s.position.z;
    if (p.rotY !== s.rotationY) p.rotY = s.rotationY;
    if (p.vx !== s.velocity.x) p.vx = s.velocity.x;
    if (p.vz !== s.velocity.z) p.vz = s.velocity.z;
    if (p.moving !== s.moving) { p.moving = s.moving; p.anim = s.moving ? 'run' : 'idle'; }
    if (p.ack !== s.lastSeq) p.ack = s.lastSeq;
  }

  updateCounts() {
    let active = 0;
    for (const p of this.state.players.values()) if (p.role === 'active') active++;
    this.state.playerCount = this.state.players.size;
    this.state.activeCount = active;
    this.state.joinable = this.state.players.size < GAME.maxPlayers;
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
      const input = sanitizeMoveInput({ mx: tuple[1], mz: tuple[2], sp: tuple[3] });
      if (!input) continue;
      input.seq = seq;
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
    const px = sim.position.x, pz = sim.position.z;

    if (p.carrying) {
      const pkg = this.state.packages.get(p.carrying);
      if (!pkg) { p.carrying = ''; return; }
      const dest = this.state.destinations.get(pkg.destinationId);
      if (!dest) return;
      if (distanceXZ(px, pz, dest.x, dest.z) > GAME.deliveryRadius) {
        client.send('interactResult', { ok: false, reason: 'notAtDestination' });
        return;
      }
      const reward = pkg.reward;
      p.score += reward;
      p.deliveries += 1;
      p.carrying = '';
      this.state.packages.delete(pkg.id);
      this.pendingSpawns.push(now + GAME.packageRespawnSeconds * 1000);
      client.send('interactResult', { ok: true, kind: 'delivered', reward, type: pkg.type });
      this.broadcast('feed', { kind: 'delivered', sid, name: p.name, reward, type: pkg.type });
      return;
    }

    let best = null, bestD = GAME.pickupRadius;
    for (const pkg of this.state.packages.values()) {
      if (pkg.status !== 'available') continue;
      const d = distanceXZ(px, pz, pkg.x, pkg.z);
      if (d <= bestD) { best = pkg; bestD = d; }
    }
    if (!best) { client.send('interactResult', { ok: false, reason: 'nothingNearby' }); return; }
    best.status = 'carried';
    best.carrierId = sid;
    p.carrying = best.id;
    client.send('interactResult', { ok: true, kind: 'picked', id: best.id, type: best.type });
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
    this.pendingSpawns.length = 0;
    for (const [sid, p] of s.players) {
      const sim = this.sims.get(sid);
      p.role = 'active';            // spectators with reserved slots join the new round
      p.score = 0; p.deliveries = 0; p.carrying = '';
      if (sim) { this.respawn(p, sim); this.writePlayer(p, sim); }
    }
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
    s.packages.clear();
    this.pendingSpawns.length = 0;
    this.broadcast('matchEnd', { matchNumber: s.matchNumber });
  }

  spawnPackage() {
    const used = new Set();
    const destInUse = new Set();
    for (const pkg of this.state.packages.values()) {
      if (pkg.status === 'available') used.add(pkg.slot);
      destInUse.add(pkg.destinationId);
    }
    let slot = -1;
    for (let i = 0; i < LAYOUT.packageSlots.length; i++) if (!used.has(i)) { slot = i; break; }
    if (slot < 0) return false;

    let roll = Math.random() * TOTAL_WEIGHT, type = 'box';
    for (const [k, def] of PACKAGE_WEIGHTS) { roll -= def.weight; if (roll <= 0) { type = k; break; } }
    const candidates = LAYOUT.buildings.filter(b => !destInUse.has(b.id));
    const pool = candidates.length ? candidates : LAYOUT.buildings;
    const dest = pool[Math.floor(Math.random() * pool.length)];

    const pkg = new PackageState();
    const sp = LAYOUT.packageSlots[slot];
    this.packageCounter += 1;
    Object.assign(pkg, {
      id: `P${this.state.matchNumber}-${this.packageCounter}`, type, status: 'available', carrierId: '',
      slot, x: sp.x, y: sp.y, z: sp.z, destinationId: dest.id, reward: PACKAGE_TYPES[type].reward
    });
    this.state.packages.set(pkg.id, pkg);
    return true;
  }

  removePackage(id, respawn) {
    if (!this.state.packages.has(id)) return;
    this.state.packages.delete(id);
    if (respawn && this.state.phase === 'playing') this.pendingSpawns.push(Date.now() + GAME.packageRespawnSeconds * 1000);
  }

  /* ---------------- fixed-step simulation ---------------- */
  tick() {
    const now = Date.now();
    const s = this.state;
    const playing = s.phase === 'playing';

    for (const [sid, p] of s.players) {
      const sim = this.sims.get(sid);
      if (!sim || p.role !== 'active' || !p.connected) continue;
      sim.budget = Math.min(sim.budget + 1, NET.inputBudgetCap);
      while (sim.budget >= 1 && sim.queue.length) {
        const input = sim.queue.shift();
        stepMovement(sim, playing ? input : ZERO_INPUT, NET.fixedDt, WORLD);
        sim.lastSeq = input.seq;
        sim.budget -= 1;
      }
      this.writePlayer(p, sim);
    }

    if (playing) {
      if (now >= s.matchEndsAt) { this.endMatch(); return; }
      for (let i = this.pendingSpawns.length - 1; i >= 0; i--) {
        if (now >= this.pendingSpawns[i]) { this.pendingSpawns.splice(i, 1); this.spawnPackage(); }
      }
      // Keep the depot stocked even if a respawn was lost (e.g. a carrier left mid-delivery).
      if (this.pendingSpawns.length === 0) {
        let available = 0;
        for (const pkg of s.packages.values()) if (pkg.status === 'available') available++;
        if (available + this.countCarried() < GAME.maxPackages) this.spawnPackage();
      }
    } else if (now >= s.phaseEndsAt) {
      this.startMatch();
      return;
    }
    const left = Math.max(0, Math.ceil((s.phaseEndsAt - now) / 1000));
    if (s.timeLeft !== left) s.timeLeft = left;
  }

  countCarried() {
    let c = 0;
    for (const pkg of this.state.packages.values()) if (pkg.status === 'carried') c++;
    return c;
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

export { CONFIG, CloseCode };
