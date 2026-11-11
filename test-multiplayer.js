/* =====================================================================
   Automated multiplayer tests — real Colyseus clients against a running
   server. Start the server with short timers first, e.g.:

     MATCH_SECONDS=45 INTERMISSION_SECONDS=4 LATE_JOIN_SECONDS=5 \
     RECONNECT_SECONDS=6 npm start

   then:  npm test        (or SERVER_URL=ws://host:port npm test)
   ===================================================================== */
import { Client } from '@colyseus/sdk';
import {
  NET, GAME, ROADS, buildLayout, createPhysicsWorld, stepMovement, sanitizeMoveInput
} from './shared.js';
import { isOriginAllowed } from './game-server.js';
import net from 'node:net';

const URL_ = process.env.SERVER_URL || 'ws://localhost:2567';
const LAYOUT = buildLayout();
const WORLD = createPhysicsWorld(LAYOUT);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
  console.log(cond ? '✔' : '✘', name, detail && !cond ? detail : '');
}
async function waitFor(fn, timeout = 5000, step = 50) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (fn()) return true; } catch { /* keep waiting */ } await sleep(step); }
  return false;
}

/* ---------- a scripted player ---------- */
/* TCP proxy so a test can cut the network abruptly (WebSocket close code 1006). */
const PROXY_PORT = 2599;
const proxySockets = new Set();
const upstream = new globalThis.URL(URL_.replace(/^ws/, 'http'));
const proxy = net.createServer(sock => {
  const up = net.connect(Number(upstream.port || 80), upstream.hostname);
  sock.pipe(up); up.pipe(sock);
  for (const s of [sock, up]) { proxySockets.add(s); s.on('error', () => {}); s.on('close', () => proxySockets.delete(s)); }
});
function cutNetwork() { for (const s of proxySockets) s.destroy(); }

class Bot {
  constructor(label, skin = 1, url = URL_) { this.label = label; this.skin = skin; this.client = new Client(url); this.seq = 0; this.timer = null; }
  opts(extra = {}) { return { skin: this.skin, protocol: 1, ...extra }; }
  async playOnline() { this.room = await this.client.joinOrCreate('city', this.opts({ mode: 'public' })); return this.wire(); }
  async createPrivate() { this.room = await this.client.create('city', this.opts({ mode: 'private' })); return this.wire(); }
  async joinCode(code) { this.room = await this.client.joinById(code, this.opts()); return this.wire(); }
  async wire() {
    this.room.reconnection.minUptime = 1000;
    this.messages = [];
    this.room.onMessage('*', (type, payload) => this.messages.push({ type, payload }));
    if (!this.room.state?.players) await new Promise(r => this.room.onStateChange.once(r));
    return this.room;
  }
  get me() { return this.room?.state?.players?.get(this.room.sessionId); }
  sendInputs(list) { this.room.send('input', { i: list }); }
  /* Drive toward waypoints at 30 Hz like the real client. */
  drive(waypoints, sprint = true) {
    this.stop();
    this.path = waypoints.slice();
    return new Promise(resolve => {
      this.timer = setInterval(() => {
        const me = this.me;
        if (!me) return;
        let mx = 0, mz = 0;
        while (this.path.length) {
          const [tx, tz] = this.path[0];
          const dx = tx - me.x, dz = tz - me.z, d = Math.hypot(dx, dz);
          if (d < 0.9) { this.path.shift(); continue; }
          mx = dx / d; mz = dz / d; break;
        }
        this.seq++;
        this.sendInputs([[this.seq, mx, mz, sprint && this.path.length > 0]]);
        if (!this.path.length) { this.stop(); resolve(true); }
      }, 1000 / NET.tickRate);
    });
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async leave() { this.stop(); try { await this.room?.leave(true); } catch { /* already gone */ } }
}

/* Road-following route from the depot to a building's delivery point. */
function routeTo(dest, from) {
  const lines = ROADS.lines;
  const b = LAYOUT.buildings.find(x => x.id === dest.id);
  const fx = Math.round(Math.sin(b.rotY)), fz = Math.round(Math.cos(b.rotY));
  let rx = b.doorX, rz = b.doorZ;
  if (fx !== 0) rx = fx > 0 ? lines.find(l => l > b.doorX) : [...lines].reverse().find(l => l < b.doorX);
  else rz = fz > 0 ? lines.find(l => l > b.doorZ) : [...lines].reverse().find(l => l < b.doorZ);
  const path = [[from.x, 0], [0, 25]];
  if (fx !== 0) path.push([rx, 25], [rx, rz]);
  else path.push([25, 25], [25, rz], [rx, rz]);
  path.push([b.doorX, b.doorZ]);
  return path;
}

async function main() {
  console.log(`Testing against ${URL_}\n`);
  const t0 = Date.now();

  /* ---------- Origin rules (unit) ---------- */
  check('origin: localhost allowed', isOriginAllowed('http://localhost:8000'));
  check('origin: crazygames subdomain allowed', isOriginAllowed('https://games.crazygames.com'));
  check('origin: lookalike domain rejected', !isOriginAllowed('https://evilcrazygames.com'));
  check('origin: other site rejected', !isOriginAllowed('https://example.org'));

  /* ---------- Test 1 + 2: two players, movement sync, prediction determinism ---------- */
  const a = new Bot('A', 1), b = new Bot('B', 2);
  await a.playOnline();
  await b.playOnline();
  check('T1 two public players land in the same room', a.room.roomId === b.room.roomId, `${a.room.roomId} vs ${b.room.roomId}`);
  await waitFor(() => a.room.state.players.size === 2 && b.room.state.players.size === 2);
  check('T1 both clients see 2 players', a.room.state.players.size === 2 && b.room.state.players.size === 2);
  const bSeesA = () => b.room.state.players.get(a.room.sessionId);
  check('T1 skins synchronized (A=1, B=2)', bSeesA()?.skin === 1 && a.room.state.players.get(b.room.sessionId)?.skin === 2);

  // Predict locally with the shared step, then compare to authority.
  const meA = a.me;
  const pred = { position: { x: meA.x, y: meA.y, z: meA.z }, velocity: { x: meA.vx, z: meA.vz }, rotationY: meA.rotY, moving: meA.moving };
  const startZ = bSeesA().z;
  const sent = [];
  for (let i = 0; i < 45; i++) {
    a.seq++;
    const inp = sanitizeMoveInput({ mx: 0.6, mz: 0.8, sp: false });
    stepMovement(pred, inp, NET.fixedDt, WORLD);
    sent.push(a.seq);
    a.sendInputs([[a.seq, 0.6, 0.8, false]]);
    await sleep(1000 / NET.tickRate);
  }
  await waitFor(() => a.me.ack === a.seq, 3000);
  const err = Math.hypot(a.me.x - pred.position.x, a.me.z - pred.position.z);
  check('T2 server processed every input (ack == last seq)', a.me.ack === a.seq, `ack ${a.me.ack} seq ${a.seq}`);
  check('T2 client prediction matches server (< 1 cm)', err < 0.01, `error ${err.toFixed(5)}`);
  await waitFor(() => Math.abs(bSeesA().z - startZ) > 3, 2000);
  check('T2 other client sees A move', Math.abs(bSeesA().z - startZ) > 3, `dz ${(bSeesA().z - startZ).toFixed(2)}`);
  check('T2 animation state synced as run while moving', bSeesA().anim === 'run', bSeesA().anim);
  for (let i = 0; i < 20; i++) { a.seq++; a.sendInputs([[a.seq, 0, 0, false]]); await sleep(33); }
  await waitFor(() => bSeesA().anim === 'idle', 2000);
  check('T2 animation returns to idle when stopped', bSeesA().anim === 'idle', bSeesA().anim);

  /* ---------- Security: speed hack, malformed messages ---------- */
  const before = { x: a.me.x, z: a.me.z };
  const tStart = Date.now();
  for (let i = 0; i < 30; i++) {          // 6 inputs every 33 ms = 6x the legal rate
    const batch = [];
    for (let k = 0; k < 6; k++) { a.seq++; batch.push([a.seq, -1, 0, true]); }
    a.sendInputs(batch);
    await sleep(33);
  }
  await sleep(300);
  const elapsed = (Date.now() - tStart) / 1000;
  const moved = Math.hypot(a.me.x - before.x, a.me.z - before.z);
  check('SEC flooding inputs cannot exceed sprint speed', moved <= 9.5 * (elapsed + 0.4), `moved ${moved.toFixed(2)} in ${elapsed.toFixed(2)}s`);
  a.room.send('input', { i: 'garbage' });
  a.room.send('input', { i: [[NaN, 'x', {}, null]] });
  a.room.send('input', { i: new Array(200).fill([1, 1, 1, 1]) });
  a.room.send('interact', 'lol');
  a.room.send('emote', { id: 999 });
  a.room.send('teleport', { x: 0, z: 0 });
  a.room.send('score', { amount: 99999 });
  await sleep(300);
  check('SEC malformed/unknown messages do not crash the room', a.room.connection.isOpen && a.room.state.players.size === 2);
  check('SEC client cannot award itself score', a.me.score === 0, `score ${a.me.score}`);

  /* ---------- Test 5: package pickup race ---------- */
  // bring both bots back to the depot, next to the same package
  const pk = [...a.room.state.packages.values()].find(p => p.status === 'available');
  check('T5 packages spawned at the depot', !!pk && a.room.state.packages.size >= 1);
  await Promise.all([a.drive([[a.me.x, 2], [pk.x, pk.z + 1.2]]), b.drive([[b.me.x, 2], [pk.x + 0.6, pk.z + 1.2]])]);
  await sleep(250);
  a.room.send('interact'); b.room.send('interact');
  await waitFor(() => a.room.state.packages.get(pk.id)?.status === 'carried', 2000);
  const carrierId = a.room.state.packages.get(pk.id)?.carrierId;
  const carriers = [a, b].filter(x => x.me.carrying === pk.id);
  check('T5 exactly one player owns the package', carriers.length === 1, `carriers ${carriers.length}`);
  await waitFor(() => b.room.state.packages.get(pk.id)?.carrierId === carrierId, 2000);
  check('T5 other client sees the carrier', b.room.state.packages.get(pk.id)?.carrierId === carrierId && a.room.state.packages.get(pk.id)?.carrierId === carrierId);

  /* ---------- Test 6: delivery + scoring ---------- */
  const carrier = carriers[0], watcher = carrier === a ? b : a;
  const pkg = carrier.room.state.packages.get(pk.id);
  const dest = carrier.room.state.destinations.get(pkg.destinationId);
  carrier.room.send('interact');   // not at destination yet
  await sleep(350);
  check('T6 delivery refused away from destination', carrier.me.score === 0 && carrier.me.carrying === pk.id);
  console.log(`   … carrier walking to ${dest.label}`);
  await carrier.drive(routeTo(dest, carrier.me));
  await sleep(300);
  const reached = Math.hypot(carrier.me.x - dest.x, carrier.me.z - dest.z);
  carrier.room.send('interact');
  await waitFor(() => carrier.me.score > 0, 3000);
  check('T6 delivery accepted at destination', carrier.me.score === pkg.reward, `score ${carrier.me.score}, dist ${reached.toFixed(2)}`);
  await waitFor(() => watcher.room.state.players.get(carrier.room.sessionId)?.score === pkg.reward, 2000);
  check('T6 every client sees the server score', watcher.room.state.players.get(carrier.room.sessionId)?.score === pkg.reward);
  check('T6 delivered package removed', !carrier.room.state.packages.has(pk.id) && carrier.me.carrying === '');
  await waitFor(() => carrier.room.state.packages.size === GAME.maxPackages, (GAME.packageRespawnSeconds + 2) * 1000);
  check('T6 a replacement package spawns (depot back to full stock)', carrier.room.state.packages.size === GAME.maxPackages, `size ${carrier.room.state.packages.size}`);

  /* ---------- Test 3 + 4: private rooms, separation ---------- */
  await new Promise(r => proxy.listen(PROXY_PORT, r));
  const p1 = new Bot('P1'), p2 = new Bot('P2', 2, `ws://127.0.0.1:${PROXY_PORT}`), q1 = new Bot('Q1'), pub = new Bot('PUB');
  await p1.createPrivate();
  const code = p1.room.roomId;
  check('T3 private room code is 6 chars', /^[A-Z2-9]{6}$/.test(code), code);
  check('T3 room state exposes code + mode', p1.room.state.roomCode === code && p1.room.state.mode === 'private');
  await p2.joinCode(code.toLowerCase().toUpperCase());
  check('T3 friend joins the private room by code', p2.room.roomId === code);
  await waitFor(() => p1.room.state.players.size === 2);
  check('T3 both see each other', p1.room.state.players.size === 2 && p2.room.state.players.size === 2);
  await pub.playOnline();
  check('T3 public matchmaking never lands in a private room', pub.room.roomId !== code, pub.room.roomId);
  await q1.createPrivate();
  check('T4 second private room is different', q1.room.roomId !== code);
  const pIds = new Set(p1.room.state.players.keys());
  check('T4 rooms are isolated', ![...q1.room.state.players.keys()].some(k => pIds.has(k)) && q1.room.state.players.size === 1);
  let badErr = null;
  try { await new Bot('X').joinCode('ZZZZZZ'); } catch (e) { badErr = e; }
  check('T3 unknown room code gives a clear error', !!badErr, badErr?.message);

  /* ---------- Test 11: capacity ---------- */
  const fill = [];
  for (let i = 0; i < 4; i++) { const f = new Bot('F' + i); await f.joinCode(code); fill.push(f); }
  await waitFor(() => p1.room.state.players.size === 6);
  check('T11 room reaches 6 players', p1.room.state.players.size === 6);
  await waitFor(() => p1.room.state.joinable === false);
  check('T11 joinable=false when full', p1.room.state.joinable === false);
  let fullErr = null;
  try { await new Bot('SEVENTH').joinCode(code); } catch (e) { fullErr = e; }
  check('T11 seventh player is refused', !!fullErr, fullErr ? '' : 'joined!');
  console.log('   seventh player error:', fullErr?.code, fullErr?.message);
  await fill[0].leave();
  await waitFor(() => p1.room.state.joinable === true);
  check('T11 joinable=true again after someone leaves', p1.room.state.joinable === true);

  /* ---------- Test 8: disconnect + reconnection ---------- */
  const dropId = p2.room.sessionId;
  let reconnected = false;
  p2.room.onReconnect(() => { reconnected = true; });
  await sleep(1500);
  console.log('   uptime before cut', Date.now() - p2.room.joinedAtTime, 'ms, sockets', proxySockets.size);
  cutNetwork();   // abrupt network loss, like Wi-Fi dropping
  await waitFor(() => p1.room.state.players.get(dropId)?.connected === false, 3000);
  check('T8 others see the player as disconnected (seat held)', p1.room.state.players.get(dropId)?.connected === false);
  await waitFor(() => reconnected, 8000);
  await waitFor(() => p1.room.state.players.get(dropId)?.connected === true, 3000);
  check('T8 automatic reconnection restores the same player', reconnected && p1.room.state.players.get(dropId)?.connected === true);
  await fill[1].leave();
  await waitFor(() => !p1.room.state.players.has(fill[1].room.sessionId), 2000);
  check('T8 consented leave removes the player for everyone', !p1.room.state.players.has(fill[1].room.sessionId));

  /* ---------- Test 7 + late join: match transition keeps the group ---------- */
  const roomBefore = a.room.roomId;
  const matchBefore = a.room.state.matchNumber;
  const late = new Bot('LATE');
  await late.joinCode(roomBefore);
  await waitFor(() => late.me);
  check('LJ late joiner becomes spectator mid-match', late.me?.role === 'spectator', late.me?.role);
  const solo = new Bot('SOLO');
  await solo.joinCode(q1.room.roomId);
  await waitFor(() => solo.me);
  check('LJ friend joining a host who is alone plays immediately', solo.me?.role === 'active', solo.me?.role);
  console.log(`   … waiting for the match timer (${a.room.state.timeLeft}s left)`);
  await waitFor(() => a.room.state.phase === 'results', (a.room.state.timeLeft + 5) * 1000, 200);
  check('T7 match ends into results phase', a.room.state.phase === 'results');
  check('T7 results list ranks players', a.room.state.results.length >= 2 && a.room.state.results[0].score >= a.room.state.results[a.room.state.results.length - 1].score);
  const scoreAtEnd = carrier.me.score;
  carrier.room.send('interact');
  await sleep(300);
  check('T7 scoring frozen during results', carrier.me.score === scoreAtEnd);
  await waitFor(() => a.room.state.phase === 'playing' && a.room.state.matchNumber === matchBefore + 1, 20000, 200);
  check('T7 next match starts in the same room', a.room.state.phase === 'playing' && a.room.roomId === roomBefore && a.room.state.matchNumber === matchBefore + 1);
  check('T7 same group still present', [a, b, late, pub].every(x => a.room.state.players.has(x.room.sessionId)));
  check('T7 scores reset for the new match', [...a.room.state.players.values()].every(p => p.score === 0));
  check('LJ spectator promoted to active at next round', late.me?.role === 'active');
  check('T7 packages restocked', a.room.state.packages.size === GAME.maxPackages);

  for (const x of [a, b, p1, p2, q1, pub, late, solo, ...fill.slice(2)]) await x.leave();
  await sleep(500);

  console.log(`\n${results.join('\n')}\n\n${passed} passed, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  proxy.close();
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('Test run crashed:', err); process.exit(2); });
