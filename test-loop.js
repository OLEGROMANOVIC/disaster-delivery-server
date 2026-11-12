/* =====================================================================
   Loop / onboarding / progression tests (post-M4 polish):
   closer destinations, combos, storm bonus, starter package (guided first
   delivery), XP messages, level sync.
     npm run test:loopserver     (terminal 1)
     npm run test:loop           (terminal 2)
   ===================================================================== */
import { Client } from '@colyseus/sdk';
import {
  NET, GAME, PROTOCOL_VERSION, SCORING, PROGRESSION, PACKAGE_TYPES, buildLayout,
  deliveryScore, deliveryReward, levelFromXp, xpToNext, titleFor, rushXp, deliveryXp, weightOf
} from './shared.js';
import { findPath } from './reachability.js';

const URL_ = process.env.SERVER_URL || 'ws://localhost:2567';
const LAYOUT = buildLayout();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0; const lines = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; lines.push(`  PASS  ${name}`); } else { failed++; lines.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
  console.log(cond ? '✔' : '✘', name, !cond && detail ? detail : '');
}
async function waitFor(fn, timeout = 5000, step = 50) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}

function unit() {
  const a = deliveryScore(100, 100, 0, false), b = deliveryScore(100, 100, 3, false), c = deliveryScore(100, 100, 9, true), d = deliveryScore(100, 40, 0, true);
  check('U combo bonus: +10 % per chained delivery', a.total === 100 && b.comboBonus === 30 && b.total === 130);
  check('U combo bonus is capped at +50 %', c.comboBonus === 50);
  check('U storm bonus +30 % for fragile cargo in good shape only', c.stormBonus === 30 && d.stormBonus === 0 && d.reward === deliveryReward(100, 40));
  let ok = true, prev = 0;
  for (let xp = 0; xp < 200000; xp += 500) { const l = levelFromXp(xp).level; if (l < prev) ok = false; prev = l; }
  check('U levels only go up with XP', ok && levelFromXp(0).level === 1 && levelFromXp(xpToNext(1)).level === 2);
  check('U titles change with level', titleFor(1) === 'Rookie' && titleFor(10) === 'Express' && titleFor(99) === 'Disaster Master');
  const r = rushXp({ score: 900, rank: 1, deliveries: 4, golden: true });
  check('U rush XP = played + placement + deliveries + golden', r.xp === PROGRESSION.rush.participation + PROGRESSION.rush.rank[0] + 4 * PROGRESSION.rush.perDelivery + PROGRESSION.rush.golden);
  check('U delivery XP = points / 10', deliveryXp(150) === 15);
}

class Bot {
  constructor(label) { this.client = new Client(URL_); this.seq = 0; this.timer = null; this.label = label; }
  async create(opts = {}) { this.room = await this.client.create('city', { protocol: PROTOCOL_VERSION, mode: 'private', ...opts }); return this.wire(); }
  async join(code, opts = {}) { this.room = await this.client.joinById(code, { protocol: PROTOCOL_VERSION, ...opts }); return this.wire(); }
  async wire() { this.messages = []; this.room.onMessage('*', (type, payload) => this.messages.push({ type, payload })); if (!this.room.state?.players) await new Promise(r => this.room.onStateChange.once(r)); }
  get s() { return this.room.state; }
  get me() { return this.room.state.players.get(this.room.sessionId); }
  walk(points) {
    this.stop(); const path = points.slice();
    return new Promise(res => { const t0 = Date.now(); let last = { x: this.me.x, z: this.me.z, t: Date.now() }, side = 0; this.timer = setInterval(() => {
      const me = this.me; let mx = 0, mz = 0;
      while (path.length) { const [x, z] = path[0], dx = x - me.x, dz = z - me.z, d = Math.hypot(dx, dz); if (d < 0.8) { path.shift(); continue; } mx = dx / d; mz = dz / d; break; }
      // stuck on a parked truck / prop (not in the static path grid): side-step for a moment
      if (Date.now() - last.t > 900) { if (Math.hypot(me.x - last.x, me.z - last.z) < 0.5) side = Date.now() + 600; last = { x: me.x, z: me.z, t: Date.now() }; }
      if (Date.now() < side) { const t = mx; mx = -mz; mz = t; }
      this.seq++; this.room.send('input', { i: [[this.seq, mx, mz, path.length ? 1 : 0]] });
      if (!path.length || Date.now() - t0 > 40000) { this.stop(); res(!path.length); }
    }, 1000 / NET.tickRate); });
  }
  goTo(x, z) {
    // parked trucks aren't in the static layout: route around their current positions
    const extra = [...this.s.vehicles.values()].map(v => { const fx = Math.abs(Math.sin(v.yaw)), fz = Math.abs(Math.cos(v.yaw)); const hx = 1.6 * fz + 4.9 * fx, hz = 1.6 * fx + 4.9 * fz; return { minX: v.x - hx, maxX: v.x + hx, minZ: v.z - hz, maxZ: v.z + hz, minY: 0, maxY: 4 }; });
    const p = findPath({ ...LAYOUT, colliders: LAYOUT.colliders.concat(extra) }, { x: this.me.x, z: this.me.z }, { x, z });
    return p ? this.walk(p) : false;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async interact() {
    await sleep(GAME.interactCooldownMs + 30);
    const n = this.messages.length; this.room.send('interact');
    await waitFor(() => this.messages.slice(n).some(m => m.type === 'interactResult'), 2000, 20);
    return this.messages.slice(n).find(m => m.type === 'interactResult')?.payload;
  }
  async leave() { this.stop(); try { await this.room.leave(true); } catch { /* gone */ } }
}

async function live() {
  // new player with the tutorial flag → personal starter box in front of them
  const A = new Bot('A');
  await A.create({ tutorial: true, level: 7 });
  await waitFor(() => [...A.s.packages.values()].some(p => p.type === 'starter'), 2000);
  const st = [...A.s.packages.values()].find(p => p.type === 'starter');
  check('O1 a new player gets a starter box right next to them', !!st && Math.hypot(st.x - A.me.x, st.z - A.me.z) < 2.4, st ? `${Math.hypot(st.x - A.me.x, st.z - A.me.z).toFixed(2)} m` : 'none');
  const dest = st && A.s.destinations.get(st.destinationId);
  check('O2 its destination is a short walk away', dest && Math.hypot(dest.x - st.x, dest.z - st.z) < 45, dest ? `${Math.hypot(dest.x - st.x, dest.z - st.z).toFixed(1)} m` : '');
  check('O3 the level from the client profile shows on the player', A.me.level === 7);
  const B = new Bot('B');
  await B.join(A.room.roomId);
  check('O4 returning players (no tutorial flag) get no starter box', [...A.s.packages.values()].filter(p => p.type === 'starter').length === 1);
  await B.walk([[B.me.x, B.me.z + 0.01], [st.x + 0.6, st.z]]);
  const steal = await B.interact();
  check('O5 nobody else can take someone\'s starter box', steal && !steal.ok && steal.reason === 'goldenTaken', JSON.stringify(steal));
  const pick = await A.interact();
  check('O6 the new player picks it up with E', pick?.ok && pick.kind === 'pickup', JSON.stringify(pick));
  const t0 = Date.now();
  await A.goTo(dest.x, dest.z);
  const del = await A.interact();
  const secs = (Date.now() - t0) / 1000;
  check('O7 the guided delivery takes well under 30 s', del?.ok && secs < 25, `${secs.toFixed(1)} s ${JSON.stringify(del)}`);
  await waitFor(() => A.messages.some(m => m.type === 'xp'), 1500);
  const xp = A.messages.find(m => m.type === 'xp')?.payload;
  check('P1 the server grants XP for a delivery', xp && xp.reason === 'delivery' && xp.amount === deliveryXp(del.reward), JSON.stringify(xp));
  await sleep(500);
  check('O8 the starter box is not restocked (depot stock unchanged)', ![...A.s.packages.values()].some(p => p.type === 'starter') && [...A.s.packages.values()].filter(p => p.type !== 'golden').length === GAME.maxPackages,
    [...A.s.packages.values()].map(p => `${p.id}:${p.type}:${p.status}`).join(' '));
  A.room.send('level', { level: 8 }); A.room.send('level', { level: 500 });
  await waitFor(() => B.s.players.get(A.room.sessionId)?.level === 8, 1500);
  check('P2 level-ups are shown to others (and bad values ignored)', B.s.players.get(A.room.sessionId)?.level === 8);

  // combo: deliver again within the window
  const nextPkg = () => [...A.s.packages.values()].filter(p => p.status === 'available' && !p.ownerId && p.type !== 'golden').sort((p, q) => Math.hypot(p.x - A.me.x, p.z - A.me.z) - Math.hypot(q.x - A.me.x, q.z - A.me.z))[0];
  let pk = nextPkg();
  if (!pk) console.log('   packages:', [...A.s.packages.values()].map(p => `${p.id}:${p.type}:${p.status}:${p.slot}`).join(' '));
  for (let tries = 0; tries < 3 && !A.me.carrying; tries++) {      // the test walker is simple: retry if it got bumped off course
    pk = nextPkg();
    await A.goTo(pk.x, pk.z + 1);
    const r = await A.interact();
    if (!r?.ok) console.log('   pickup retry', JSON.stringify(r), Math.hypot(A.me.x - pk.x, A.me.z - pk.z).toFixed(2));
    await waitFor(() => !!A.me.carrying, 800);
  }
  const d2 = A.s.destinations.get(A.s.packages.get(A.me.carrying)?.destinationId);
  await A.goTo(d2.x, d2.z);
  const del2 = await A.interact();
  check('L1 a second delivery within the window is a combo with a bonus', del2?.ok && del2.combo === 1 && del2.comboBonus === Math.round(del2.base * SCORING.comboStep) && del2.reward === del2.base + del2.comboBonus + del2.stormBonus, JSON.stringify(del2));
  await waitFor(() => A.me.combo === 1, 1000);
  check('L1 combo is synced on the player', A.me.combo === 1 && A.me.comboUntil > 0);

  // destinations are closer for on-foot packages
  const D = LAYOUT.depot;
  const dist = b => Math.hypot(b.doorX - D.cx, b.doorZ - D.cz);
  const allAvg = LAYOUT.buildings.reduce((a, b) => a + dist(b), 0) / LAYOUT.buildings.length;
  const seen = [...A.s.packages.values()].filter(p => p.type !== 'golden' && weightOf(p.type).onFoot).map(p => dist(LAYOUT.buildings.find(b => b.id === p.destinationId)));
  const avg = seen.reduce((a, b) => a + b, 0) / Math.max(1, seen.length);
  check('L2 on-foot packages go to the nearer buildings', seen.length >= 3 && avg < allAvg * 0.85, `avg ${avg.toFixed(1)} m vs city ${allAvg.toFixed(1)} m`);

  // storm: carry a package while the flood is active → storm flag
  pk = nextPkg();
  await A.goTo(pk.x, pk.z + 1);
  const p3 = await A.interact();
  console.log(`   … waiting for the flood (${A.s.disaster.phase})`);
  await waitFor(() => A.s.disaster.phase === 'active' && A.s.disaster.level > 0.5, 60000, 100);
  await waitFor(() => A.s.packages.get(A.me.carrying)?.storm === true, 3000);
  check('L3 cargo carried through an active disaster is marked for the storm bonus', p3?.ok && A.s.packages.get(A.me.carrying)?.storm === true);

  for (const x of [A, B]) await x.leave();
}

async function main() {
  const t0 = Date.now();
  unit();
  if (process.env.UNIT_ONLY !== '1') await live();
  console.log(`\n${lines.join('\n')}\n\n${passed} passed, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failed ? 1 : 0);
}
main().catch(err => { console.error('Test run crashed:', err); process.exit(2); });
