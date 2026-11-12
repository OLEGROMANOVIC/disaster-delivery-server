/* =====================================================================
   Milestone 3 tests — disasters, package condition, trucks.
   Real Colyseus clients against a running server. Each scenario needs
   the server started with specific settings:

   SCENARIO=tornado  →  FIRST_FREE_PLAY_SECONDS=5 RUSH_WARNING_SECONDS=2 RUSH_SECONDS=70 RESULTS_SECONDS=3 INTERMISSION_SECONDS=3
                         DISASTER_FIRST_DELAY=20 DISASTER_ACTIVE=15 DISASTER_TYPES=tornado TORNADO_PATH="-30,25;30,25" PACKAGE_POOL=groceries npm start
   SCENARIO=flood    →  RUSH_SECONDS=240 DISASTER_FIRST_DELAY=20 DISASTER_TYPES=flood FLOOD_ZONES=F1 PACKAGE_POOL=groceries npm start
   SCENARIO=trucks   →  RUSH_SECONDS=300 DISASTER_TYPES=none PACKAGE_POOL=groceries DROP_DAMAGE=60 RECONNECT_SECONDS=3 npm start

   then:  SCENARIO=<name> node test-milestone3.js
   ===================================================================== */
import { Client } from '@colyseus/sdk';
import net from 'node:net';
import {
  NET, GAME, VEHICLE, DISASTER, PACKAGE_TYPES, PROTOCOL_VERSION, buildLayout, createPhysicsWorld, resolveInteraction,
  deliveryReward, stepVehicle, stepMovement, walkSpeedMultiplier
} from './shared.js';

const URL_ = process.env.SERVER_URL || 'ws://localhost:2567';
const SCENARIO = process.env.SCENARIO || 'trucks';
const LAYOUT = buildLayout();
const WORLD = createPhysicsWorld(LAYOUT);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  PASS  ${name}`); } else { failed++; results.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
  console.log(cond ? '✔' : '✘', name, !cond && detail ? detail : '');
}
async function waitFor(fn, timeout = 5000, step = 50) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (fn()) return true; } catch { /* keep waiting */ } await sleep(step); }
  return false;
}

/* proxy to simulate an abrupt network loss */
const PROXY_PORT = 2598;
const proxySockets = new Set();
const upstream = new globalThis.URL(URL_.replace(/^ws/, 'http'));
const proxy = net.createServer(sock => {
  const up = net.connect(Number(upstream.port || 80), upstream.hostname);
  sock.pipe(up); up.pipe(sock);
  for (const s of [sock, up]) { proxySockets.add(s); s.on('error', () => {}); s.on('close', () => proxySockets.delete(s)); }
});
const cutNetwork = () => { for (const s of proxySockets) s.destroy(); };

class Bot {
  constructor(label, url = URL_) { this.label = label; this.client = new Client(url); this.seq = 0; this.timer = null; this.messages = []; }
  async wire() {
    this.room.reconnection.minUptime = 1000;
    this.room.onMessage('*', (type, payload) => this.messages.push({ type, payload, t: Date.now() }));
    if (!this.room.state?.players) await new Promise(r => this.room.onStateChange.once(r));
    return this.room;
  }
  async createPrivate() { this.room = await this.client.create('city', { mode: 'private', protocol: PROTOCOL_VERSION }); return this.wire(); }
  async joinCode(code) { this.room = await this.client.joinById(code, { protocol: PROTOCOL_VERSION }); return this.wire(); }
  get me() { return this.room.state.players.get(this.room.sessionId); }
  get s() { return this.room.state; }
  walkInput(mx, mz, sp = false) { this.seq++; this.room.send('input', { i: [[this.seq, mx, mz, sp ? 1 : 0]] }); }
  driveInput(throttle, steer = 0, brake = false) { this.seq++; this.room.send('input', { i: [[this.seq, steer, throttle, 2 | (brake ? 1 : 0)]] }); }
  walkTo(points, sprint = false, timeout = 30000) {
    this.stop();
    const path = points.slice();
    return new Promise(resolve => {
      const end = Date.now() + timeout;
      this.timer = setInterval(() => {
        const me = this.me;
        if (!me) return;
        let mx = 0, mz = 0;
        while (path.length) {
          const [tx, tz] = path[0];
          const dx = tx - me.x, dz = tz - me.z, d = Math.hypot(dx, dz);
          if (d < 0.5) { path.shift(); continue; }
          mx = dx / d; mz = dz / d; break;
        }
        this.walkInput(mx, mz, sprint && path.length > 0);
        if (!path.length || Date.now() > end) { this.stop(); resolve(path.length === 0); }
      }, 1000 / NET.tickRate);
    });
  }
  async hold(ms, fn) { const end = Date.now() + ms; while (Date.now() < end) { fn(); await sleep(1000 / NET.tickRate); } }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  lastResult() { return [...this.messages].reverse().find(m => m.type === 'interactResult')?.payload; }
  async interact() {
    await sleep(Math.max(0, (this.lastInteract || 0) + 320 - Date.now()));   // server cooldown is 250 ms
    this.lastInteract = Date.now();
    const n = this.messages.length;
    this.room.send('interact');
    const ok = await waitFor(() => this.messages.slice(n).some(m => m.type === 'interactResult'), 2000);
    return ok ? this.messages.slice(n).find(m => m.type === 'interactResult').payload : { ok: false, kind: 'noReply' };
  }
  async leave() { this.stop(); try { await this.room?.leave(true); } catch { /* gone */ } }
}

/* ---------------- unit checks of shared rules (no server) ---------------- */
function unitChecks() {
  check('U reward formula: full condition = base', deliveryReward(650, 100) === 650);
  check('U reward formula: 50% condition = 75% of base', deliveryReward(1000, 50) === 750);
  check('U reward formula: broken = 0', deliveryReward(900, 0) === 0);
  const floods = [{ minX: -19, maxX: 19, minZ: 19, maxZ: 31, depth: 0.35, deep: false }];
  check('U walking in shallow flood = 55% speed', Math.abs(walkSpeedMultiplier({ floods }, 0, 25) - 0.55) < 1e-9);
  check('U heavy cargo slows walking', walkSpeedMultiplier({ carryMul: 0.6 }, 0, 0) === 0.6);
  // vehicle: shallow water caps speed at 70%
  const wide = [{ minX: -80, maxX: 80, minZ: 19, maxZ: 31, depth: 0.35, deep: false }];
  const v = { x: -70, z: 25, yaw: Math.PI / 2, speed: 0 };
  for (let i = 0; i < 150; i++) stepVehicle(v, { steer: 0, throttle: 1, brake: false }, NET.fixedDt, WORLD, { floods: wide });
  check('U truck top speed in shallow flood = 70%', Math.abs(v.speed - VEHICLE.maxSpeed * DISASTER.flood.vehicleMul) < 0.3, v.speed.toFixed(2));
  // deep water blocks entry
  const deep = [{ minX: -19, maxX: 19, minZ: 19, maxZ: 31, depth: 0.9, deep: true }];
  const v2 = { x: 0, z: 14, yaw: 0, speed: 10 };
  for (let i = 0; i < 60; i++) stepVehicle(v2, { steer: 0, throttle: 1, brake: false }, NET.fixedDt, WORLD, { floods: deep });
  check('U deep flood blocks truck entry', v2.z < 19.5, v2.z.toFixed(2));
  // very heavy needs a truck
  const pk = new Map([['P1', { id: 'P1', type: 'piano', status: 'available', x: 0, z: -7.1, destinationId: 'B01' }]]);
  const trucks = new Map([['T1', { id: 'T1', x: 50, z: 50, yaw: 0, speed: 0, driverId: '', cargo: [] }]]);
  const dests = new Map([['B01', { x: 99, z: 99 }]]);
  check('U piano cannot be carried on foot', resolveInteraction({ x: 0, z: -6, packages: pk, vehicles: trucks, destinations: dests }).reason === 'needTruck');
  trucks.get('T1').x = 0; trucks.get('T1').z = -7.1 + 6.05 + 2;   // rear ~2 m from the piano
  check('U piano loads into a truck parked next to it', resolveInteraction({ x: 0, z: -6, packages: pk, vehicles: trucks, destinations: dests }).kind === 'loadHeavy');
}

/* ---------------- scenario: tornado ---------------- */
async function tornado() {
  const a = new Bot('A'), b = new Bot('B');
  await a.createPrivate();
  await b.joinCode(a.room.roomId);
  const room2 = new Bot('R2');
  check('D disaster starts INACTIVE', a.s.disaster.phase === 'inactive');
  // carry a groceries package to the south avenue, in the tornado's path
  const pk = [...a.s.packages.values()].find(p => p.status === 'available');
  await a.walkTo([[a.me.x, 2], [pk.x, pk.z + 1.2]]);
  const pickup = await a.interact();
  check('P picked up a fragile package', pickup?.ok && pickup.kind === 'pickup', JSON.stringify(pickup));
  await a.walkTo([[0, 10], [0, 24]]);
  console.log('   … waiting for the tornado warning');
  await waitFor(() => a.s.disaster.phase === 'warning', 40000, 100);
  check('D1 warning phase announced with type', a.s.disaster.phase === 'warning' && a.s.disaster.type === 'tornado');
  check('D2 both clients agree on warning + countdown', b.s.disaster.phase === 'warning' && Math.abs(b.s.disaster.secondsLeft - a.s.disaster.secondsLeft) <= 1, `${a.s.disaster.secondsLeft} vs ${b.s.disaster.secondsLeft}`);
  await room2.createPrivate();
  await waitFor(() => a.s.disaster.phase === 'active', 15000, 100);
  check('D3 tornado becomes ACTIVE', a.s.disaster.phase === 'active');
  check('D4 a different room has its own (inactive) disaster state', room2.s.disaster.phase === 'inactive', room2.s.disaster.phase);
  await sleep(600);
  const ta = [a.s.disaster.tx, a.s.disaster.tz], tb = [b.s.disaster.tx, b.s.disaster.tz];
  check('D5 both clients see the tornado at the same place', Math.hypot(ta[0] - tb[0], ta[1] - tb[1]) < 1.0, `${ta} vs ${tb}`);
  const late = new Bot('LATE');
  await late.joinCode(a.room.roomId);
  check('D6 a player joining mid-disaster receives the hazard state', late.s.disaster.phase === 'active' && late.s.disaster.type === 'tornado' && Math.hypot(late.s.disaster.tx - a.s.disaster.tx, late.s.disaster.tz - a.s.disaster.tz) < 3);
  // stand on the avenue (keep sending idle inputs so pushes are simulated) until the funnel passes
  const startPos = { x: a.me.x, z: a.me.z };
  let maxImpulse = 0, minCond = 100, knocked = false;
  await a.hold(12000, () => {
    a.walkInput(0, 0);
    maxImpulse = Math.max(maxImpulse, Math.hypot(a.me.ix, a.me.iz));
    const p = a.s.packages.get(pk.id);
    if (p) minCond = Math.min(minCond, p.condition);
    if (a.messages.some(m => m.type === 'hazard')) knocked = true;
  });
  const moved = Math.hypot(a.me.x - startPos.x, a.me.z - startPos.z);
  check('T1 tornado pushes the player (server impulse, capped)', maxImpulse > 1 && maxImpulse <= DISASTER.tornado.maxImpulse + 0.01 && moved > 1, `impulse ${maxImpulse.toFixed(2)} moved ${moved.toFixed(2)}`);
  const pNow = a.s.packages.get(pk.id), pOther = b.s.packages.get(pk.id);
  check('P7 fragile package lost condition in the tornado', minCond < 100 || !pNow, `min condition ${minCond}`);
  check('P8 condition is synchronized to other clients', !pNow || (pOther && pOther.condition === pNow.condition));
  check('T2 knock-out event fired (core hit)', knocked);
  console.log(`   … waiting for the rush to end (${a.s.phase}, ${a.s.timeLeft}s)`);
  await waitFor(() => a.s.phase === 'results', 120000, 200);
  check('D7 disaster cleaned up when the rush ends', a.s.disaster.phase === 'inactive' && a.s.disaster.type === 'none' && a.s.disaster.floods.size === 0);
  await waitFor(() => a.s.phase === 'intermission', 10000, 200);
  check('D7b no hazards during the intermission break', a.s.disaster.phase === 'inactive');
  await waitFor(() => a.s.phase === 'free_play', 10000, 200);
  check('D8 free play resumes with a fresh, inactive disaster + same group', a.s.disaster.phase === 'inactive' && a.s.players.size === 3 && a.room.roomId === late.room.roomId);
  for (const x of [a, b, late, room2]) await x.leave();
}

/* ---------------- scenario: flood ---------------- */
async function flood() {
  const a = new Bot('A'), b = new Bot('B');
  await a.createPrivate();
  await b.joinCode(a.room.roomId);
  // get into position before the water rises: A holds a water-sensitive package, B sits in truck T1
  const pk = [...a.s.packages.values()].find(p => p.status === 'available');
  await a.walkTo([[a.me.x, 2], [pk.x, pk.z + 1.2]]);
  check('F0 picked up a water-sensitive package', (await a.interact())?.kind === 'pickup');
  await a.walkTo([[0, 10], [0, 16]]);
  await b.walkTo([[b.me.x, 2], [9.2, 6.2]]);
  const enter = await b.interact();
  check('F5 driver entered truck', enter?.ok && enter.kind === 'enterVehicle', JSON.stringify(enter));
  console.log('   … waiting for the flood');
  await waitFor(() => a.s.disaster.phase === 'active' && a.s.disaster.level >= 1, 90000, 100);
  const za = [...a.s.disaster.floods.keys()].sort().join(), zb = [...b.s.disaster.floods.keys()].sort().join();
  check('F1 both clients see the same flood zones', za === zb && za === 'F1', `${za} / ${zb}`);
  check('F2 water reached full depth', a.s.disaster.level >= 1);
  await a.walkTo([[0, 24]]);
  const x0 = a.me.x, t0 = Date.now();
  await a.hold(1500, () => a.walkInput(1, 0, true));
  const speed = (a.me.x - x0) / ((Date.now() - t0) / 1000);
  check('F3 walking in flood water is slower (~55%)', speed > 3 && speed < 9.5 * 0.7, `${speed.toFixed(2)} m/s`);
  a.room.send('drop');
  await sleep(2500);
  const pkg = a.s.packages.get(pk.id);
  check('F4 water-sensitive package dropped in the flood loses condition', !pkg || pkg.condition < 100, String(pkg?.condition));
  check('F4b condition matches on the other client', !pkg || b.s.packages.get(pk.id)?.condition === pkg.condition);
  let maxInWater = 0, enteredAt = 0;
  await b.hold(3500, () => {
    b.driveInput(1);
    const v = b.s.vehicles.get('T1');
    if (v.z > 20 && v.z < 30) { enteredAt ||= Date.now(); if (Date.now() - enteredAt > 400) maxInWater = Math.max(maxInWater, Math.abs(v.speed)); }
  });
  check('F6 truck slowed to ≤70% max speed in shallow flood', maxInWater > 0 && maxInWater <= VEHICLE.maxSpeed * 0.7 + 0.2, maxInWater.toFixed(2));
  for (const x of [a, b]) await x.leave();
}

/* ---------------- scenario: trucks + packages ---------------- */
async function trucks() {
  await new Promise(r => proxy.listen(PROXY_PORT, r));
  const a = new Bot('A'), b = new Bot('B'), c = new Bot('C', `ws://127.0.0.1:${PROXY_PORT}`);
  await a.createPrivate();
  await b.joinCode(a.room.roomId);
  await c.joinCode(a.room.roomId);    // joins now: late joiners would spectate
  check('V0 two trucks parked at the depot', a.s.vehicles.size === 2 && [...a.s.vehicles.values()].every(v => !v.driverId && v.speed === 0));

  // P9: reward reduced by condition, broken cannot be delivered
  const pk = [...a.s.packages.values()].find(p => p.status === 'available');
  await a.walkTo([[a.me.x, 2], [pk.x, pk.z + 1.2]]);
  check('P pickup', (await a.interact())?.kind === 'pickup');
  await a.walkTo([[pk.x, 8]]);
  await a.hold(900, () => a.walkInput(0, 1, true));   // sprint south…
  a.room.send('drop');                                  // …and drop it at speed (DROP_DAMAGE=60)
  await waitFor(() => a.s.packages.get(pk.id)?.condition < 100, 2000);
  check('P9 dropping at speed damages a fragile package (server-side)', a.s.packages.get(pk.id)?.condition === 40, String(a.s.packages.get(pk.id)?.condition));
  check('P10 condition change synchronized to others', b.s.packages.get(pk.id)?.condition === 40);
  await a.walkTo([[a.s.packages.get(pk.id).x, a.s.packages.get(pk.id).z - 1]]);
  check('P re-pickup damaged package', (await a.interact())?.kind === 'pickup');

  // V1/V5: load into truck rear, other client sees cargo, unload again
  await a.walkTo([[8, -1], [11.5, -2.6]]);
  const load = await a.interact();
  check('V5 load carried package into truck cargo', load?.ok && load.kind === 'loadCarried', JSON.stringify(load));
  await waitFor(() => b.s.vehicles.get('T1').cargo.length === 1);
  check('V6 cargo synchronized to the other client', b.s.vehicles.get('T1').cargo[0] === pk.id && b.s.packages.get(pk.id).status === 'loaded');
  const unload = await a.interact();
  check('V7 unload cargo back into hands', unload?.ok && unload.kind === 'unload' && a.me.carrying === pk.id, JSON.stringify(unload));
  // deliver the damaged package by walking: reward must follow the formula
  const dest = a.s.destinations.get(a.s.packages.get(pk.id).destinationId);
  const score0 = a.me.score;
  await a.walkTo(routeTo(dest, a.me), true, 60000);
  const del = await a.interact();
  check('P11 server reward = base × (0.5 + 0.5 × condition/100)', del?.ok && a.me.score - score0 === deliveryReward(PACKAGE_TYPES.groceries.reward, 40), `${JSON.stringify(del)} score +${a.me.score - score0}`);
  await waitFor(() => b.s.players.get(a.room.sessionId).score === a.me.score, 2000);
  check('P12 leaderboard score synced', b.s.players.get(a.room.sessionId).score === a.me.score);

  // broken package disappears and cannot be delivered
  const pk2 = [...b.s.packages.values()].find(p => p.status === 'available' && p.slot >= 0);
  await b.walkTo([[b.me.x, 2], [pk2.x, pk2.z + 1.2]]);
  await b.interact();
  for (let i = 0; i < 2 && b.s.packages.has(pk2.id); i++) {
    await b.walkTo([[b.me.x, 8]]);
    await b.hold(900, () => b.walkInput(0, 1, true));
    b.room.send('drop');
    await sleep(400);
    const p = b.s.packages.get(pk2.id);
    if (p) { await b.walkTo([[p.x, p.z - 1]]); await b.interact(); }
  }
  check('P13 package broken at 0% is removed (cannot be delivered)', !b.s.packages.has(pk2.id) && b.me.carrying === '' && b.messages.some(m => m.type === 'feed' && m.payload.kind === 'broken'));

  // V1-V3: enter, others see driver, second player cannot take the wheel
  await b.walkTo([[4, 4], [9.2, 6.2]]);
  const enter = await b.interact();
  check('V1 player enters the truck with E', enter?.ok && enter.kind === 'enterVehicle' && b.me.driving === 'T1', JSON.stringify(enter));
  await waitFor(() => a.s.vehicles.get('T1').driverId === b.room.sessionId);
  check('V2 other clients see who is driving', a.s.vehicles.get('T1').driverId === b.room.sessionId);
  await a.walkTo([[a.me.x, a.me.z], [4, 4], [8, -1], [14, -1], [13.8, 7]], false, 60000);
  const steal = await a.interact();
  check('V3 a second player cannot enter an occupied truck', steal?.kind !== 'enterVehicle' && a.me.driving === '', JSON.stringify(steal));
  const before = { x: a.s.vehicles.get('T1').x, z: a.s.vehicles.get('T1').z };
  await a.hold(800, () => a.driveInput(1));
  check('V3b non-driver drive inputs do not move the truck', Math.hypot(a.s.vehicles.get('T1').x - before.x, a.s.vehicles.get('T1').z - before.z) < 0.05);
  await a.walkTo([[4, 4]]);

  // V4: drive into the residential block → buildings stop the truck
  let maxSpeed = 0;
  await b.hold(6000, () => { b.driveInput(1); maxSpeed = Math.max(maxSpeed, b.s.vehicles.get('T1').speed); });
  const vz = b.s.vehicles.get('T1').z;
  check('V4 truck accelerates (arcade) and reports speed', maxSpeed > 8, maxSpeed.toFixed(2));
  check('V4b truck cannot drive through buildings', vz < 33.5, `z ${vz.toFixed(2)} (building face at 36.96)`);
  await b.hold(800, () => b.driveInput(0, 0, true));
  const out = await b.interact();
  await waitFor(() => b.me.driving === '', 2000);
  const p = b.me;
  const inside = (() => { const pos = { x: p.x, y: 0.3, z: p.z }, n = { x: 0, z: 0 }; WORLD.resolveCircle(pos, 0.45, n); return Math.hypot(pos.x - p.x, pos.z - p.z) > 0.05; })();
  check('V5b player exits safely beside the truck', out?.ok && out.kind === 'exitVehicle' && p.driving === '' && !inside && Math.hypot(p.x - b.s.vehicles.get('T1').x, p.z - b.s.vehicles.get('T1').z) > 2, JSON.stringify({ out, px: p.x, pz: p.z, driving: p.driving, inside, tx: b.s.vehicles.get('T1').x, tz: b.s.vehicles.get('T1').z }));
  await waitFor(() => a.s.vehicles.get('T1').driverId === '');
  check('V5c truck released for everyone', a.s.vehicles.get('T1').driverId === '');

  // V8: driver disconnects → truck stops, ownership released after the reconnect window
  await c.walkTo([[c.me.x, 2], [-9.2, 6.2]]);
  console.log('   C at', c.me.x.toFixed(2), c.me.z.toFixed(2), 'T2', JSON.stringify({ x: a.s.vehicles.get('T2').x, z: a.s.vehicles.get('T2').z, d: a.s.vehicles.get('T2').driverId }));
  const ce = await c.interact();
  await waitFor(() => c.me.driving === 'T2', 2000);
  check('V8a third player takes truck T2', ce?.kind === 'enterVehicle' && c.me.driving === 'T2', JSON.stringify(ce));
  await c.hold(1200, () => c.driveInput(1));
  await sleep(300);
  c.room.reconnection.enabled = false;   // simulate a player who never comes back
  cutNetwork();
  c.stop();
  await waitFor(() => a.s.players.get(c.room.sessionId)?.connected === false, 4000);
  await sleep(400);
  check('V8b truck stops when its driver drops', Math.abs(a.s.vehicles.get('T2').speed) < 0.01, String(a.s.vehicles.get('T2').speed));
  await waitFor(() => a.s.vehicles.get('T2').driverId === '', 8000);
  check('V8c driver released after the reconnect window', a.s.vehicles.get('T2').driverId === '' && !a.s.players.has(c.room.sessionId));

  for (const x of [a, b]) await x.leave();
  proxy.close();
}

/* Road route from the depot to a building door (same as milestone 2 tests). */
function routeTo(dest, from) {
  const lines = [-75, -25, 25, 75];
  const b = LAYOUT.buildings.find(x => Math.hypot(x.doorX - dest.x, x.doorZ - dest.z) < 0.01);
  const fx = Math.round(Math.sin(b.rotY)), fz = Math.round(Math.cos(b.rotY));
  let rx = b.doorX, rz = b.doorZ;
  if (fx !== 0) rx = fx > 0 ? lines.find(l => l > b.doorX) : [...lines].reverse().find(l => l < b.doorX);
  else rz = fz > 0 ? lines.find(l => l > b.doorZ) : [...lines].reverse().find(l => l < b.doorZ);
  const path = [[from.x, Math.max(from.z, 10)], [0, 25]];
  if (fx !== 0) path.push([rx, 25], [rx, rz]); else path.push([25, 25], [25, rz], [rx, rz]);
  path.push([b.doorX, b.doorZ]);
  return path;
}

async function main() {
  console.log(`Milestone 3 tests — scenario "${SCENARIO}" against ${URL_}\n`);
  const t0 = Date.now();
  unitChecks();
  if (SCENARIO === 'tornado') await tornado();
  else if (SCENARIO === 'flood') await flood();
  else await trucks();
  console.log(`\n${results.join('\n')}\n\n${passed} passed, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failed ? 1 : 0);
}
main().catch(err => { console.error('Test run crashed:', err); process.exit(2); });
