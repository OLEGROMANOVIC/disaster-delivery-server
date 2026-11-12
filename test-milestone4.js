/* =====================================================================
   Milestone 4 tests — continuous city, Delivery Rush lifecycle, jumping,
   knockback, props, social, Golden Package, parkour. Unit checks run
   directly on shared.js; live checks use real Colyseus clients.

   Start the server with short timers first:
     npm run test:m4server
   then:
     npm run test:m4
   ===================================================================== */
import { Client } from '@colyseus/sdk';
import {
  NET, GAME, PLAYER, KNOCKBACK, PROP_TYPES, PROPS, PROTOCOL_VERSION, VEHICLE, QUICK_CHAT, EMOTE_LIST, GOLDEN, PACKAGE_TYPES,
  buildLayout, createPhysicsWorld, stepMovement, sanitizeMoveInput, applyKnock, stepProp, deliveryReward,
  computeRushRewards, isBreakPhase, deliveriesAllowed, movementAllowed, resolveInteraction
} from './shared.js';
import { reachability, findPath } from './reachability.js';

const URL_ = process.env.SERVER_URL || 'ws://localhost:2567';
const LAYOUT = buildLayout();
const WORLD = createPhysicsWorld(LAYOUT);
const DT = NET.fixedDt;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const lines = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; lines.push(`  PASS  ${name}`); } else { failed++; lines.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
  console.log(cond ? '✔' : '✘', name, !cond && detail ? detail : '');
}
async function waitFor(fn, timeout = 5000, step = 50) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (fn()) return true; } catch { /* keep waiting */ } await sleep(step); }
  return false;
}
const mk = (x, z) => ({ position: { x, y: WORLD.groundHeight(x, z), z }, velocity: { x: 0, z: 0 }, impulse: { x: 0, z: 0 }, rotationY: 0, moving: false });

/* ---------------- unit checks ---------------- */
function unit() {
  // jumping
  const j = mk(0, 5); let peak = 0;
  stepMovement(j, { mx: 0, mz: 0, sp: false, jp: true }, DT, WORLD);
  for (let i = 0; i < 40; i++) { stepMovement(j, { mx: 0, mz: 0, sp: false, jp: i === 6 }, DT, WORLD); peak = Math.max(peak, j.position.y); }
  const h = peak - WORLD.groundHeight(0, 5);
  check('U jump reaches ~1.4 m and lands again', h > 1.25 && h < 1.6 && !j.air && j.position.y === WORLD.groundHeight(0, 5), `height ${h.toFixed(3)}`);
  const single = mk(0, 5); let p1 = 0;
  stepMovement(single, { mx: 0, mz: 0, sp: false, jp: true }, DT, WORLD);
  for (let i = 0; i < 40; i++) { stepMovement(single, { mx: 0, mz: 0, sp: false, jp: false }, DT, WORLD); p1 = Math.max(p1, single.position.y); }
  check('U no double jump (pressing again in the air does nothing)', Math.abs(p1 - peak) < 1e-9, `${p1} vs ${peak}`);
  const heavy = mk(0, 5);
  stepMovement(heavy, { mx: 0, mz: 0, sp: false, jp: true }, DT, WORLD, { canJump: false });
  check('U heavy cargo cannot jump', !heavy.air && heavy.vy === 0);
  // standable surfaces: a depot crate (static collider) can be jumped onto
  const crate = mk(-13.6, -3.6); let top = 0, jumped = false;
  for (let i = 0; i < 40; i++) { const jp = !jumped && crate.position.z < -4.7; if (jp) jumped = true; stepMovement(crate, { mx: 0, mz: -1, sp: false, jp }, DT, WORLD); top = Math.max(top, crate.position.y); }
  check('U jumping onto a crate lands on its top (ground detection on colliders)', top > 1.44, `max y ${top.toFixed(3)}`);
  // hurdles block walking, jumping clears them
  const walk = mk(-60, 0);
  for (let i = 0; i < 120; i++) stepMovement(walk, { mx: 1, mz: 0, sp: false, jp: false }, DT, WORLD);
  const hop = mk(-60, 0);
  for (let i = 0; i < 150; i++) { const near = [-53.2, -46.8].some(x => x - hop.position.x > 0.6 && x - hop.position.x < 1.4); stepMovement(hop, { mx: 1, mz: 0, sp: false, jp: near && !hop.air }, DT, WORLD); }
  check('U alley hurdles block walking but can be jumped', walk.position.x < -53 && hop.position.x > -40, `walk ${walk.position.x.toFixed(1)} hop ${hop.position.x.toFixed(1)}`);
  // scaffold crossing both ways
  let ok = true;
  for (const dir of [1, -1]) {
    const sc = mk(dir > 0 ? 40 : 60, 0);
    for (let i = 0; i < 500; i++) { const sup = WORLD.supportHeight(sc.position.x + 0.9 * dir, 0, 9); stepMovement(sc, { mx: dir, mz: 0, sp: false, jp: !sc.air && sup - sc.position.y > 0.3 }, DT, WORLD); }
    if (Math.abs(sc.position.x - 50) < 8) ok = false;
  }
  check('U construction scaffold can be climbed over in both directions', ok);
  const r = reachability(LAYOUT);
  check('U every delivery door is reachable on foot without parkour', r.doors.every(d => d.ok), r.doors.filter(d => !d.ok).map(d => d.id).join(','));
  check('U every Golden Package spot is reachable without parkour', r.golden.every(g => g.ok));
  check('U parkour areas are only reachable by jumping', !r.reachable(-50, 0) && !r.reachable(50, 0));
  // knockback
  const k = mk(0, 5);
  applyKnock(k, 1, 0, 50, 5, 0.5);
  check('U knockback impulse is capped', Math.hypot(k.impulse.x, k.impulse.z) <= KNOCKBACK.maxImpulse + 1e-9 && k.air && k.stun === 0.5);
  const st = mk(0, 5); applyKnock(st, 1, 0, 0.1, 0, 0.5);
  for (let i = 0; i < 6; i++) stepMovement(st, { mx: 0, mz: 1, sp: false, jp: true }, DT, WORLD);
  check('U stunned couriers ignore input (no walking, no jumping)', Math.abs(st.position.z - 5) < 0.01 && !st.air, `dz ${(st.position.z - 5).toFixed(3)}`);
  // props
  const cone = { kind: 'trafficcone', x: 0, z: 0, yaw: 0, vx: 0, vz: 0 }, box = { kind: 'woodenbox', x: 0, z: 0, yaw: 0, vx: 0, vz: 0 };
  for (let i = 0; i < 10; i++) {
    stepProp(cone, DT, WORLD, [{ x: cone.x, z: cone.z - 0.7, r: PLAYER.radius, ix: 0, iz: 1, speed: 6 }], []);
    stepProp(box, DT, WORLD, [{ x: box.x, z: box.z - 1.0, r: PLAYER.radius, ix: 0, iz: 1, speed: 6 }], []);
  }
  check('U pushed props move away from the courier; cones fly further than crates', cone.z > box.z && box.z > 0.3, `cone ${cone.z.toFixed(2)} crate ${box.z.toFixed(2)}`);
  const hit = { kind: 'trafficcone', x: 0, z: 0, yaw: 0, vx: 0, vz: 0 };
  stepProp(hit, DT, WORLD, [], [{ x: 0, z: -1.5, r: VEHICLE.radius, vx: 0, vz: 12 }]);
  check('U a truck sends a cone flying', hit.vz > 10);
  // lifecycle helpers + reward hook
  check('U break phases block hazards/deliveries; results also freeze movement',
    isBreakPhase('results') && isBreakPhase('intermission') && !isBreakPhase('delivery_rush') && !deliveriesAllowed('intermission') && deliveriesAllowed('free_play') && !movementAllowed('results') && movementAllowed('intermission'));
  const rw = computeRushRewards([{ sessionId: 'a', score: 900, rank: 1, deliveries: 3, golden: true }]);
  check('U reward hook is a preview only (nothing granted)', rw.length === 1 && rw[0].granted === false && rw[0].points === 900);
  // golden rules
  const pk = new Map([['G1', { id: 'G1', type: 'golden', status: 'available', x: 0, z: 0, ownerId: 'owner', destinationId: 'B01' }]]);
  check('U only the owner can pick up a claimed Golden Package',
    resolveInteraction({ x: 0, z: 0, self: 'thief', packages: pk, vehicles: new Map(), destinations: new Map() }).reason === 'goldenTaken' &&
    resolveInteraction({ x: 0, z: 0, self: 'owner', packages: pk, vehicles: new Map(), destinations: new Map() }).kind === 'pickup');
  check('U Golden Package reward follows the condition formula', deliveryReward(PACKAGE_TYPES.golden.reward, 50) === 1500);
}

/* ---------------- live bot ---------------- */
class Bot {
  constructor(label, skin = 1) { this.label = label; this.skin = skin; this.client = new Client(URL_); this.seq = 0; this.timer = null; }
  opts(extra = {}) { return { skin: this.skin, protocol: PROTOCOL_VERSION, ...extra }; }
  async create() { this.room = await this.client.create('city', this.opts({ mode: 'private' })); return this.wire(); }
  async join(code) { this.room = await this.client.joinById(code, this.opts()); return this.wire(); }
  async wire() {
    this.room.reconnection.minUptime = 1000;
    this.messages = [];
    this.room.onMessage('*', (type, payload) => this.messages.push({ type, payload, at: Date.now() }));
    if (!this.room.state?.players) await new Promise(r => this.room.onStateChange.once(r));
    return this.room;
  }
  get s() { return this.room.state; }
  get me() { return this.room?.state?.players?.get(this.room.sessionId); }
  send(list) { this.room.send('input', { i: list }); }
  walkInput(mx, mz, sprint = false, jump = false) { this.seq++; this.send([[this.seq, mx, mz, (sprint ? 1 : 0) | (jump ? 4 : 0)]]); }
  driveInput(steer, throttle, brake = false) { this.seq++; this.send([[this.seq, steer, throttle, 2 | (brake ? 1 : 0)]]); }
  walkTo(points, sprint = true) {
    this.stop();
    const path = points.slice();
    return new Promise(resolve => {
      const t0 = Date.now();
      this.timer = setInterval(() => {
        const me = this.me; if (!me) return;
        let mx = 0, mz = 0;
        while (path.length) {
          const [tx, tz] = path[0]; const dx = tx - me.x, dz = tz - me.z, d = Math.hypot(dx, dz);
          if (d < 0.9) { path.shift(); continue; }
          mx = dx / d; mz = dz / d; break;
        }
        this.walkInput(mx, mz, sprint && path.length > 0);
        if (!path.length || Date.now() - t0 > 60000) { this.stop(); resolve(!path.length); }
      }, 1000 / NET.tickRate);
    });
  }
  goTo(x, z) { const p = findPath(LAYOUT, { x: this.me.x, z: this.me.z }, { x, z }); return p ? this.walkTo(p) : Promise.resolve(false); }
  hold(ms, fn) { this.stop(); return new Promise(res => { const end = Date.now() + ms; this.timer = setInterval(() => { fn(); if (Date.now() > end) { this.stop(); res(); } }, 1000 / NET.tickRate); }); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async interact() {
    const n = this.messages.length;
    this.room.send('interact');
    await waitFor(() => this.messages.slice(n).some(m => m.type === 'interactResult'), 2000, 20);
    return this.messages.slice(n).find(m => m.type === 'interactResult')?.payload;
  }
  async leave() { this.stop(); try { await this.room?.leave(true); } catch { /* gone */ } }
}

async function live() {
  const a = new Bot('A'), b = new Bot('B', 2), c = new Bot('C');
  await a.create();
  const code = a.room.roomId;
  await b.join(code); await c.join(code);
  await waitFor(() => a.s.players.size === 3);

  /* --- Stage 1: lifecycle basics --- */
  check('L1 a new room opens in free play', a.s.phase === 'free_play' && a.s.rushNumber === 0, a.s.phase);
  check('L1 free play knows when the next rush starts', a.s.nextRushAt > a.s.phaseEndsAt);
  check('L1 the depot is stocked during free play', [...a.s.packages.values()].filter(p => p.type !== 'golden').length === GAME.maxPackages);
  check('L1 props are synced', a.s.props.size === LAYOUT.props.length && b.s.props.size === LAYOUT.props.length, `${a.s.props.size}/${LAYOUT.props.length}`);

  /* --- Stage 2: server-validated jump, prediction matches --- */
  await a.hold(300, () => a.walkInput(0, 0));
  await sleep(200);
  const me = a.me;
  const pred = { position: { x: me.x, y: me.y, z: me.z }, velocity: { x: me.vx, z: me.vz }, impulse: { x: me.ix, z: me.iz }, rotationY: me.rotY, moving: me.moving, vy: me.vy, air: me.air, stun: me.stun };
  let sawAir = false, maxY = me.y;
  for (let i = 0; i < 40; i++) {
    const jp = i === 2 || i === 12;    // second press mid-air must be ignored
    a.walkInput(0.6, 0.8, false, jp);
    stepMovement(pred, sanitizeMoveInput({ mx: 0.6, mz: 0.8, sp: false, jp }), DT, WORLD, { canJump: true, circles: [] });
    await sleep(1000 / NET.tickRate);
    if (b.s.players.get(a.room.sessionId)?.air) sawAir = true;
    maxY = Math.max(maxY, a.me.y);
  }
  await waitFor(() => a.me.ack === a.seq, 2000);
  const err = Math.hypot(a.me.x - pred.position.x, a.me.z - pred.position.z) + Math.abs(a.me.y - pred.position.y);
  check('J1 server runs the jump (other clients see the courier airborne)', sawAir);
  check('J2 jump height stays a single jump (no double jump server-side)', maxY - me.y < 1.6 && maxY - me.y > 1.2, `${(maxY - me.y).toFixed(2)} m`);
  check('J3 client prediction of a jump matches the server (< 1 cm)', err < 0.01, `error ${err.toFixed(5)}`);
  check('J4 courier lands again', !a.me.air);

  /* --- Stage 5: emotes + quick chat --- */
  await a.hold(400, () => a.walkInput(0, 0));
  a.room.send('emote', { id: 'wave' });
  await waitFor(() => b.s.players.get(a.room.sessionId)?.emote === 'wave', 2000);
  check('S1 emote (wave) is synced with a server start time', b.s.players.get(a.room.sessionId)?.emote === 'wave' && b.s.players.get(a.room.sessionId).emoteAt > 0);
  a.room.send('emote', { id: 'dance' });                  // cooldown: ignored
  a.room.send('emote', { id: 'hack' });
  await sleep(200);
  check('S2 emote cooldown + unknown emote ids are rejected', a.me.emote === 'wave');
  await a.hold(500, () => a.walkInput(1, 0));
  await waitFor(() => b.s.players.get(a.room.sessionId)?.emote === '', 2000);
  check('S3 moving interrupts the emote', b.s.players.get(a.room.sessionId)?.emote === '');
  const nb = b.messages.length;
  a.room.send('chat', { id: 6 }); a.room.send('chat', { id: 1 }); a.room.send('chat', { id: 99 });
  await sleep(400);
  const chats = b.messages.slice(nb).filter(m => m.type === 'chat');
  check('S4 quick chat preset reaches others (cooldown drops spam, bad ids ignored)', chats.length === 1 && chats[0].payload.id === 6 && QUICK_CHAT[6] === "Let's deliver!", JSON.stringify(chats.map(m => m.payload)));

  /* --- Stage 4: push the platform cart --- */
  const cart = [...a.s.props.values()].find(p => p.kind === 'platformcart');
  const home = { x: cart.x, z: cart.z };
  await c.goTo(home.x + 2.2, home.z);
  await c.hold(1400, () => c.walkInput(-1, 0, true));
  await waitFor(() => Math.hypot(b.s.props.get(cart.id).x - home.x, b.s.props.get(cart.id).z - home.z) > 1, 3000);
  const moved = Math.hypot(b.s.props.get(cart.id).x - home.x, b.s.props.get(cart.id).z - home.z);
  check('P1 a courier pushes the cart and everyone sees it roll', moved > 1, `moved ${moved.toFixed(2)} m`);

  /* --- Stage 3: truck knockback --- */
  await c.goTo(9.2, 6.2);
  const enter = await c.interact();
  check('K0 driver entered truck T1', enter?.ok && enter.kind === 'enterVehicle', JSON.stringify(enter));
  await b.goTo(11.5, 15);
  await b.hold(300, () => b.walkInput(0, 0));
  let hitB = false, maxImp = 0, stunned = false;
  const nb2 = b.messages.length;
  await c.hold(2200, () => {
    c.driveInput(0, 1);
    b.walkInput(0, 0);
    const p = b.me; maxImp = Math.max(maxImp, Math.hypot(p.ix, p.iz)); if (p.stun > 0) stunned = true;
  });
  hitB = b.messages.slice(nb2).some(m => m.type === 'hazard' && m.payload.by === 'truck');
  check('K1 a moving truck knocks a courier over (server impulse + stun)', hitB && stunned && maxImp > 2, `hazard ${hitB} stun ${stunned} impulse ${maxImp.toFixed(2)}`);
  check('K2 knockback impulse stays within the cap', maxImp <= KNOCKBACK.maxImpulse + 0.01);
  check('K3 the driver is never knocked', !c.messages.some(m => m.type === 'hazard'));
  await c.hold(1500, () => c.driveInput(0, 0, true));
  const exit = await c.interact();
  check('K4 driver gets out again', exit?.ok && exit.kind === 'exitVehicle', JSON.stringify(exit));

  /* --- Stage 1: the rush --- */
  console.log(`   … waiting for the Delivery Rush (${a.s.phase}, ${a.s.timeLeft}s)`);
  await waitFor(() => a.s.phase === 'rush_warning', (a.s.timeLeft + 8) * 1000, 50);
  check('L2 free play is followed by a rush warning', a.s.phase === 'rush_warning');
  await waitFor(() => a.s.phase === 'delivery_rush', 15000, 50);
  check('L3 the Delivery Rush starts (rush #1, rush scores at 0)', a.s.phase === 'delivery_rush' && a.s.rushNumber === 1 && [...a.s.players.values()].every(p => p.rushScore === 0));
  check('L3 phase messages were broadcast', ['rush_warning', 'delivery_rush'].every(ph => b.messages.some(m => m.type === 'phase' && m.payload.phase === ph)));

  /* --- Stage 6: Golden Package --- */
  await waitFor(() => [...a.s.packages.values()].some(p => p.type === 'golden'), 10000, 50);
  const gold = [...a.s.packages.values()].find(p => p.type === 'golden');
  check('G1 one Golden Package spawns during the rush (announced)', !!gold && b.messages.some(m => m.type === 'golden' && m.payload.phase === 'spawn'));
  const spot = GOLDEN.spots[0];
  check('G1 it spawns away from the depot at a city spot', gold && Math.hypot(gold.x - spot.x, gold.z - spot.z) < 0.5);
  await Promise.all([b.goTo(spot.x + 0.8, spot.z), a.goTo(spot.x - 0.8, spot.z)]);
  const claim = await b.interact();
  await waitFor(() => a.s.packages.get(gold.id)?.ownerId === b.room.sessionId, 1500);
  check('G2 first courier claims it', claim?.ok && claim.kind === 'pickup' && a.s.packages.get(gold.id)?.ownerId === b.room.sessionId, JSON.stringify(claim));
  b.room.send('drop');
  await waitFor(() => a.s.packages.get(gold.id)?.status === 'available', 2000);
  const steal = await a.interact();
  check('G3 nobody else can take it, even when dropped (no stealing)', steal && !steal.ok && steal.reason === 'goldenTaken', JSON.stringify(steal));
  await sleep(GAME.interactCooldownMs + 50);     // interact spam protection
  const again = await b.interact();
  await waitFor(() => b.me.carrying === gold.id, 1500);
  check('G4 the owner can pick it up again', again?.ok && b.me.carrying === gold.id, JSON.stringify(again));
  if (!gold) throw new Error('no golden package — cannot continue');
  const dest = a.s.destinations.get(gold.destinationId);
  check('G5 its destination is far away', Math.hypot(dest.x - spot.x, dest.z - spot.z) >= GOLDEN.minDestinationDistance);
  console.log(`   … B carries the Golden Package to ${dest.label}`);
  const arrived = await b.goTo(dest.x, dest.z);
  await b.hold(300, () => b.walkInput(0, 0));
  const cond = a.s.packages.get(gold.id)?.condition ?? 0;
  console.log(`   arrived=${arrived} carrying=${b.me.carrying} dist=${Math.hypot(b.me.x - dest.x, b.me.z - dest.z).toFixed(2)} golden=${JSON.stringify(a.s.packages.get(gold.id)?.toJSON?.())}`);
  const del = await b.interact();
  await waitFor(() => b.me.rushScore > 0, 1500);
  check('G6 delivering it pays the condition-based golden reward to the rush score', del?.ok && del.reward === deliveryReward(PACKAGE_TYPES.golden.reward, cond) && b.me.rushScore >= del.reward, JSON.stringify(del));
  check('G7 at most one Golden Package per rush (not restocked)', ![...a.s.packages.values()].some(p => p.type === 'golden'));

  /* --- results + breaks --- */
  console.log(`   … waiting for results (${a.s.timeLeft}s)`);
  await waitFor(() => a.s.phase === 'results', 90000, 100);
  const res = [...a.s.results];
  const rb = res.find(r => r.sessionId === b.room.sessionId);
  check('R1 results rank everyone with rush stats', res.length === 3 && res[0].rank === 1 && rb && rb.score === b.me.rushScore && rb.deliveries >= 1 && rb.bestDelivery >= del.reward);
  check('R2 the Golden Package winner is flagged in the results', rb?.golden === true);
  check('R3 a personal best is recorded (session only)', rb?.personalBest === true && b.me.bestRush === rb.score);
  const ri = await a.interact();
  check('R4 interactions are frozen during results', ri && !ri.ok && ri.reason === 'resultsBreak', JSON.stringify(ri));
  await waitFor(() => a.s.phase === 'intermission', 10000, 50);
  check('R5 results → intermission break (no menu, room kept)', a.s.phase === 'intermission' && a.s.players.size === 3);
  a.room.send('busy', { busy: true });
  await waitFor(() => a.me.busy === true, 1000);
  const endsAt = a.s.phaseEndsAt;
  await waitFor(() => a.s.phase === 'free_play', 20000, 50);
  const heldFor = Date.now() - endsAt;   // approx: local clock vs server clock on the same machine
  check('R6 a busy client may hold the break briefly, never longer than the cap', heldFor > 1500 && heldFor < 3000 + 1500, `${heldFor} ms`);
  check('R7 busy flags reset when free play resumes', [...a.s.players.values()].every(p => !p.busy));

  /* --- props reset home when left alone --- */
  for (const x of [a, b, c]) x.stop();
  await Promise.all([a.goTo(40, 40), b.goTo(40, 42), c.goTo(42, 40)]);
  const away0 = Math.hypot(a.s.props.get(cart.id).x - home.x, a.s.props.get(cart.id).z - home.z);
  if (away0 > PROPS.resetAwayDistance) {
    await waitFor(() => Math.hypot(a.s.props.get(cart.id).x - home.x, a.s.props.get(cart.id).z - home.z) < 0.05, 20000, 200);
    check('P2 a prop left far from home returns there when nobody is near it', Math.hypot(a.s.props.get(cart.id).x - home.x, a.s.props.get(cart.id).z - home.z) < 0.05, `was ${away0.toFixed(2)} m away`);
  } else {
    await sleep(9000);
    const away1 = Math.hypot(a.s.props.get(cart.id).x - home.x, a.s.props.get(cart.id).z - home.z);
    check('P2 a prop nudged only a little (≤ 3 m) is left where it is', Math.abs(away1 - away0) < 0.01, `${away0.toFixed(2)} → ${away1.toFixed(2)}`);
  }

  for (const x of [a, b, c]) await x.leave();
}

async function main() {
  const t0 = Date.now();
  unit();
  if (process.env.UNIT_ONLY !== '1') await live();
  console.log(`\n${lines.join('\n')}\n\n${passed} passed, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failed ? 1 : 0);
}
main().catch(err => { console.error('Test run crashed:', err); process.exit(2); });
