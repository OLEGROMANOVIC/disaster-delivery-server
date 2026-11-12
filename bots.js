/* =====================================================================
   DISASTER DELIVERY — server-side bot couriers (server only)

   Bots fill rooms that have few real players and step aside as soon as a
   real player needs the seat. They play through exactly the same rules as
   humans: every tick they produce one movement input ({mx,mz,sp,jp}) that
   goes through the normal input queue, and they use the normal interact /
   drop / emote / chat handlers (with cooldowns). Nothing is shortcut.

   They look like ordinary couriers to clients (no bot flag is synced).
   ===================================================================== */
import { MAP, PLAYER, GAME, EMOTE_LIST, QUICK_CHAT, packageDef, weightOf } from './shared.js';

/* ---------------------------------------------------------------------
   Navigation grid (built once per process) + A* with string pulling.
   Parkour pieces are colliders too, so bots always take street routes.
   --------------------------------------------------------------------- */
export function createNavGrid(layout, world, cell = 1, clearance = 0.72) {
  const half = MAP.playHalf - 0.5;
  const N = Math.floor((half * 2) / cell) + 1;
  const free = new Uint8Array(N * N);
  const toW = i => -half + i * cell;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = toW(i), z = toW(j), g = world.groundHeight(x, z);
    let ok = true;
    for (const c of layout.colliders) {
      if (c.maxY <= g + 0.4) continue;
      const qx = Math.max(c.minX, Math.min(x, c.maxX)), qz = Math.max(c.minZ, Math.min(z, c.maxZ));
      if ((x - qx) ** 2 + (z - qz) ** 2 < clearance * clearance) { ok = false; break; }
    }
    free[i * N + j] = ok ? 1 : 0;
  }
  const cellOf = v => Math.max(0, Math.min(N - 1, Math.round((v + half) / cell)));
  const isFree = (x, z) => free[cellOf(x) * N + cellOf(z)] === 1;
  /* nearest free cell (start/goal may sit right next to a wall or prop) */
  const nearestFree = (ci, cj) => {
    if (free[ci * N + cj]) return [ci, cj];
    for (let r = 1; r < 6; r++) for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      const a = ci + di, b = cj + dj;
      if (a >= 0 && b >= 0 && a < N && b < N && free[a * N + b]) return [a, b];
    }
    return null;
  };
  const lineFree = (ax, az, bx, bz) => {
    const d = Math.hypot(bx - ax, bz - az), n = Math.ceil(d / 0.35);
    for (let k = 1; k < n; k++) { const t = k / n; if (!isFree(ax + (bx - ax) * t, az + (bz - az) * t)) return false; }
    return true;
  };
  // A* scratch buffers (single-threaded server: safe to reuse)
  const g = new Float32Array(N * N), came = new Int32Array(N * N), stamp = new Uint32Array(N * N);
  const heap = []; let run = 0;
  const push = (k, f) => { heap.push([f, k]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142]];

  function findPath(from, to) {
    const s = nearestFree(cellOf(from.x), cellOf(from.z)), t = nearestFree(cellOf(to.x), cellOf(to.z));
    if (!s || !t) return null;
    if (lineFree(from.x, from.z, to.x, to.z)) return [[to.x, to.z]];
    run++; heap.length = 0;
    const sk = s[0] * N + s[1], tk = t[0] * N + t[1];
    const h = k => { const dx = Math.abs(((k / N) | 0) - t[0]), dz = Math.abs((k % N) - t[1]); return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz); };
    stamp[sk] = run; g[sk] = 0; came[sk] = sk; push(sk, h(sk));
    let found = false, expanded = 0;
    while (heap.length) {
      const [, k] = pop();
      if (k === tk) { found = true; break; }
      if (++expanded > 40000) break;
      const i = (k / N) | 0, j = k % N;
      for (const [di, dj, w] of DIRS) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= N || b >= N) continue;
        const n = a * N + b;
        if (!free[n]) continue;
        if (di && dj && (!free[(i + di) * N + j] || !free[i * N + j + dj])) continue;
        const ng = g[k] + w;
        if (stamp[n] === run && ng >= g[n]) continue;
        stamp[n] = run; g[n] = ng; came[n] = k; push(n, ng + h(n));
      }
    }
    if (!found) return null;
    const pts = [];
    for (let k = tk; ; k = came[k]) { pts.push([toW((k / N) | 0), toW(k % N)]); if (came[k] === k) break; }
    pts.reverse(); pts.push([to.x, to.z]);
    // string pulling: keep only the corners we can't see past
    const out = []; let ax = from.x, az = from.z, idx = 0;
    while (idx < pts.length - 1) {
      let far = idx + 1;
      for (let k = pts.length - 1; k > idx + 1; k--) if (lineFree(ax, az, pts[k][0], pts[k][1])) { far = k; break; }
      out.push(pts[far]); ax = pts[far][0]; az = pts[far][1]; idx = far;
    }
    return out;
  }
  /* a random walkable point near (x, z) — for wandering */
  function randomNear(x, z, radius, rng = Math.random) {
    for (let n = 0; n < 30; n++) {
      const a = rng() * Math.PI * 2, r = radius * (0.3 + 0.7 * rng());
      const px = Math.max(-half, Math.min(half, x + Math.cos(a) * r)), pz = Math.max(-half, Math.min(half, z + Math.sin(a) * r));
      if (isFree(px, pz)) return { x: px, z: pz };
    }
    return { x, z };
  }
  return { findPath, randomNear, isFree, lineFree };
}

/* ---------------------------------------------------------------------
   Names that look like the ones real players have (guests + usernames)
   --------------------------------------------------------------------- */
const ADJ = ['Swift', 'Lucky', 'Turbo', 'Sneaky', 'Happy', 'Crazy', 'Mighty', 'Tiny', 'Rapid', 'Silent', 'Brave', 'Funky', 'Sunny', 'Rocket', 'Pixel', 'Shadow', 'Lazy', 'Fuzzy', 'Epic', 'Chill', 'Noisy', 'Golden', 'Frosty', 'Wild'];
const ANIMAL = ['Fox', 'Panda', 'Otter', 'Tiger', 'Wolf', 'Koala', 'Falcon', 'Llama', 'Badger', 'Penguin', 'Gecko', 'Moose', 'Shark', 'Bunny', 'Raccoon', 'Duck', 'Hawk', 'Yeti', 'Lynx', 'Frog'];
const FIRST = ['mateo', 'lina', 'noah', 'emma', 'luca', 'sofia', 'yusuf', 'elif', 'max', 'zoe', 'leo', 'mia', 'adam', 'nora', 'ali', 'ivy', 'omar', 'jade', 'finn', 'ela'];
export function makeBotName(taken, rng = Math.random) {
  const pick = a => a[Math.floor(rng() * a.length)];
  for (let n = 0; n < 40; n++) {
    const r = rng();
    let name;
    if (r < 0.35) name = `Courier${100 + Math.floor(rng() * 900)}`;                       // looks like a guest
    else if (r < 0.7) name = `${pick(ADJ)}${pick(ANIMAL)}${rng() < 0.6 ? Math.floor(rng() * 900 + 100) : ''}`;
    else name = `${pick(FIRST)}${pick(['', '_', '.', 'x'])}${pick(['gg', 'xd', 'pro', String(Math.floor(rng() * 900 + 100)), 'yt', 'ok'])}`;
    if (!taken.has(name)) return name;
  }
  return `Courier${Date.now() % 1000}`;
}

/* ---------------------------------------------------------------------
   Bot brain. One per bot courier. `room` is the CityRoom; the bot acts
   only through room handlers + the input it returns each tick.
   --------------------------------------------------------------------- */
const r01 = () => Math.random();
const between = (a, b) => a + Math.random() * (b - a);

export class BotBrain {
  constructor(room, sid, nav) {
    this.room = room; this.sid = sid; this.nav = nav;
    this.client = { sessionId: sid, send: (type, msg) => this.onMessage(type, msg) };   // stand-in for a socket
    // personality: every bot plays a bit differently
    this.skill = between(0.45, 0.95);                 // path discipline, reaction speed
    this.sprintBias = between(0.6, 0.95);
    this.jumpiness = between(0.05, 0.25);             // random hops per second while running (people love jumping)
    this.social = between(0.2, 0.9);                  // chance to chat / emote at moments
    this.goal = null;                                 // { kind, x, z, id?, until? }
    this.path = []; this.pathTo = null;
    this.pauseUntil = 0; this.nextThink = 0;
    this.lastPos = null; this.lastProgressAt = Date.now(); this.stuck = 0;
    this.sidestep = null;
    this.wobble = r01() * 10;
    this.lastPhase = '';
    this.goldenDecisionAt = 0;
  }
  get p() { return this.room.state.players.get(this.sid); }
  get sim() { return this.room.sims.get(this.sid); }

  onMessage(type, msg) {
    if (type !== 'interactResult') return;
    if (msg.ok && (msg.kind === 'deliver' || msg.kind === 'deliverFromTruck')) {
      this.goal = null; this.path = [];
      this.pauseUntil = Date.now() + between(400, 1400);
      if (r01() < 0.25 * this.social) this.later(between(300, 900), () => this.room.handleEmote(this.client, { id: r01() < 0.6 ? 'cheer' : 'dance' }));
    } else if (msg.ok && msg.kind === 'pickup') {
      this.goal = null; this.path = [];
      this.pauseUntil = Date.now() + between(250, 700);
    } else if (!msg.ok) {
      this.failures = (this.failures || 0) + 1;
      if (this.failures > 2) { this.goal = null; this.path = []; this.failures = 0; }
    }
  }
  later(ms, fn) { setTimeout(() => { try { if (this.room.bots?.has(this.sid)) fn(); } catch { /* bot gone */ } }, ms); }
  say(id, delayMs = 0) { this.later(delayMs, () => this.room.handleChat(this.client, { id })); }

  /* React to room events (phase changes, golden package, deliveries by others). */
  onEvent(type, data) {
    if (type === 'phase') {
      if (data.phase === 'rush_warning' && r01() < 0.35 * this.social) this.say(6, between(500, 4000));            // Let's deliver!
      if (data.phase === 'results') {
        const me = [...this.room.state.results].find(r => r.sessionId === this.sid);
        if (me?.rank === 1 && me.score > 0) this.later(between(800, 2500), () => this.room.handleEmote(this.client, { id: 'cheer' }));
        else if (r01() < 0.45 * this.social) this.say(7, between(600, 5000));                                    // GG!
      }
      if (data.phase === 'intermission' && r01() < 0.3 * this.social) this.later(between(1000, 6000), () => this.room.handleEmote(this.client, { id: EMOTE_LIST[Math.floor(r01() * EMOTE_LIST.length)].id }));
      if (data.phase === 'free_play' && r01() < 0.15 * this.social) this.say(0, between(1000, 8000));            // Hello!
    }
    if (type === 'golden' && data.phase === 'spawn') this.goldenDecisionAt = Date.now() + between(1500, 6000) / this.skill;
    if (type === 'golden' && data.phase === 'delivered' && data.sid !== this.sid && r01() < 0.3 * this.social) this.say(3, between(500, 2500)); // Nice!
    if (type === 'tornado' && r01() < 0.12 * this.social) this.say(5, between(200, 1500));                         // Watch out!
  }

  /* ---------------- decisions (a few times per second) ---------------- */
  think(now) {
    const s = this.room.state, p = this.p, sim = this.sim;
    const pos = sim.position;
    if (s.phase === 'results') { this.goal = null; this.path = []; return; }
    // flee a nearby tornado for a moment (humans do!)
    const d = s.disaster;
    if (d && d.type === 'tornado' && (d.phase === 'active' || d.phase === 'warning') && d.level > 0.1) {
      const dist = Math.hypot(pos.x - d.tx, pos.z - d.tz);
      if (dist < (d.pushRadius || 13) + 4 && this.goal?.kind !== 'flee' && r01() < 0.6 + 0.3 * this.skill) {
        const ax = (pos.x - d.tx) / (dist || 1), az = (pos.z - d.tz) / (dist || 1);
        const t = this.nav.randomNear(pos.x + ax * 16, pos.z + az * 16, 5);
        this.setGoal({ kind: 'flee', x: t.x, z: t.z, until: now + between(2500, 4500) });
        if (!this.warned) { this.warned = true; this.onEvent('tornado'); }
        return;
      }
    }
    if (this.goal?.until && now > this.goal.until) this.goal = null;
    if (this.goal?.kind === 'flee' && !this.goal.until) this.goal = null;

    // carrying: go deliver (also during breaks we just hang on to it)
    if (p.carrying) {
      const pkg = s.packages.get(p.carrying);
      if (!pkg) return;
      const dest = s.destinations.get(pkg.destinationId);
      if (!dest) return;
      if (s.phase === 'intermission') { if (!this.goal) this.wander(now, pos, 10); return; }
      if (this.goal?.kind !== 'deliver' || this.goal.id !== pkg.id) this.setGoal({ kind: 'deliver', id: pkg.id, x: dest.x, z: dest.z });
      return;
    }
    if (this.goal?.kind === 'pickup') {
      const pkg = s.packages.get(this.goal.id);
      if (!pkg || pkg.status !== 'available' || (pkg.ownerId && pkg.ownerId !== this.sid)) this.goal = null;
      else if (Math.hypot(pkg.x - this.goal.x, pkg.z - this.goal.z) > 1.5) this.setGoal({ ...this.goal, x: pkg.x, z: pkg.z });   // it was moved
    }
    if (s.phase === 'intermission') { if (!this.goal || this.goal.kind === 'pickup') this.wander(now, pos, 14); return; }

    // the Golden Package is worth dropping plans for (after a human-ish reaction delay; re-checked
    // every few seconds while it is up for grabs and this bot has empty hands)
    const gold = [...s.packages.values()].find(k => k.type === 'golden' && k.status === 'available' && (!k.ownerId || k.ownerId === this.sid));
    if (gold && this.goal?.id !== gold.id && now > (this.goldenDecisionAt || 0)) {
      if (r01() < 0.35 + 0.5 * this.skill) { this.goldenDecisionAt = 0; this.setGoal({ kind: 'pickup', id: gold.id, x: gold.x, z: gold.z }); return; }
      this.goldenDecisionAt = now + between(4000, 9000);
    }
    if (this.goal && this.goal.kind !== 'wander') return;
    // casual moments in free play
    if (s.phase === 'free_play' && !this.goal && r01() < 0.12) { this.wander(now, pos, 18, between(3000, 7000)); return; }
    if (this.goal?.kind === 'wander' && now < this.goal.until) return;

    // pick a package nobody else (bot) is going for; prefer near + valuable
    const claimed = new Set();
    for (const b of this.room.bots.values()) if (b !== this && b.goal?.kind === 'pickup') claimed.add(b.goal.id);
    let best = null, bestScore = Infinity;
    for (const pkg of s.packages.values()) {
      if (pkg.status !== 'available' || pkg.type === 'golden' || claimed.has(pkg.id)) continue;
      if (!weightOf(pkg.type).onFoot) continue;                 // pianos need a truck: bots leave those to humans
      // don't snatch a package a real courier is standing next to
      let humanNear = false;
      for (const [sid, q] of s.players) if (!this.room.bots.has(sid) && q.role === 'active' && !q.carrying && Math.hypot(q.x - pkg.x, q.z - pkg.z) < 4) humanNear = true;
      if (humanNear) continue;
      const dist = Math.hypot(pkg.x - pos.x, pkg.z - pos.z);
      const score = dist - packageDef(pkg.type).reward * 0.01 * this.skill + r01() * 8;
      if (score < bestScore) { bestScore = score; best = pkg; }
    }
    if (best) this.setGoal({ kind: 'pickup', id: best.id, x: best.x, z: best.z });
    else if (!this.goal) this.wander(now, pos, 8, between(1500, 4000));   // depot empty: mill about
  }
  wander(now, pos, radius, ms = between(2500, 6000)) {
    const t = this.nav.randomNear(pos.x, pos.z, radius);
    this.setGoal({ kind: 'wander', x: t.x, z: t.z, until: now + ms });
  }
  setGoal(goal) {
    this.goal = goal;
    const pos = this.sim.position;
    this.path = this.nav.findPath({ x: pos.x, z: pos.z }, { x: goal.x, z: goal.z }) || [];
    this.pathTo = { x: goal.x, z: goal.z };
    this.sprintNow = goal.kind !== 'wander' && r01() < this.sprintBias;
    if (!this.path.length && Math.hypot(goal.x - pos.x, goal.z - pos.z) > 2) this.goal = null;   // unreachable
  }

  /* ---------------- per-tick steering → one input ---------------- */
  tick(now, dt) {
    const p = this.p, sim = this.sim;
    if (!p || !sim || p.role !== 'active') return null;
    const s = this.room.state;
    if (s.phase === 'results') return { mx: 0, mz: 0, sp: false, jp: false };
    if (now >= this.nextThink) { this.nextThink = now + between(180, 420); this.think(now); }
    const pos = sim.position;
    const idle = { mx: 0, mz: 0, sp: false, jp: false };
    if (now < this.pauseUntil || !this.goal) return idle;

    // close enough to act?
    const g = this.goal;
    const dGoal = Math.hypot(g.x - pos.x, g.z - pos.z);
    if (g.kind === 'pickup' && dGoal < 1.6) { this.room.handleInteract(this.client); this.pauseUntil = now + 300; return idle; }
    if (g.kind === 'deliver' && dGoal < 2.6) { this.room.handleInteract(this.client); this.pauseUntil = now + 350; return idle; }
    if ((g.kind === 'wander' || g.kind === 'flee') && dGoal < 1) { this.goal = null; this.pauseUntil = now + between(300, 1500); return idle; }

    // stuck? (trucks, props, other couriers block the grid route sometimes)
    if (!this.lastPos || now - this.lastProgressAt > 1200) {
      const moved = this.lastPos ? Math.hypot(pos.x - this.lastPos.x, pos.z - this.lastPos.z) : 1;
      this.lastPos = { x: pos.x, z: pos.z }; this.lastProgressAt = now;
      if (moved < 0.6) {
        this.stuck++;
        const a = Math.atan2(g.x - pos.x, g.z - pos.z) + (r01() < 0.5 ? 1 : -1) * Math.PI / 2;
        this.sidestep = { x: Math.sin(a), z: Math.cos(a), until: now + between(400, 800), jump: true };
        if (this.stuck >= 3) this.setGoal(g);              // replan from here
        if (this.stuck >= 6) { this.goal = null; this.stuck = 0; return idle; }
      } else this.stuck = 0;
    }
    if (this.sidestep && now < this.sidestep.until) {
      const jp = this.sidestep.jump && !sim.air; this.sidestep.jump = false;
      return { mx: this.sidestep.x, mz: this.sidestep.z, sp: false, jp };
    }
    this.sidestep = null;

    // follow the path
    while (this.path.length && Math.hypot(this.path[0][0] - pos.x, this.path[0][1] - pos.z) < (this.path.length > 1 ? 1.1 : 0.6)) this.path.shift();
    const [tx, tz] = this.path.length ? this.path[0] : [g.x, g.z];
    let dx = tx - pos.x, dz = tz - pos.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    // a little human imprecision (less for skilled bots)
    this.wobble += dt;
    const w = Math.sin(this.wobble * 1.7) * 0.12 * (1.2 - this.skill);
    const mx = dx * Math.cos(w) - dz * Math.sin(w), mz = dx * Math.sin(w) + dz * Math.cos(w);
    const far = dGoal > 7;
    const sprint = far && this.sprintNow;
    const canJump = !p.carrying || weightOf(s.packages.get(p.carrying)?.type).canJump;
    const jp = canJump && !sim.air && far && r01() < this.jumpiness * dt;
    return { mx, mz, sp: sprint, jp };
  }
}
