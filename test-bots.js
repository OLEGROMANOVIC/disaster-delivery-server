/* =====================================================================
   Bot tests — rooms with few real players are topped up with bot
   couriers that play like people and give their seat to real players.
     npm run test:botserver     (terminal 1)
     npm run test:bots          (terminal 2)
   ===================================================================== */
import { Client } from '@colyseus/sdk';
import { NET, GAME, PROTOCOL_VERSION } from './shared.js';

const URL_ = process.env.SERVER_URL || 'ws://localhost:2567';
const FILL = Number(process.env.BOT_FILL || 4);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0; const lines = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; lines.push(`  PASS  ${name}`); } else { failed++; lines.push(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
  console.log(cond ? '✔' : '✘', name, !cond && detail ? detail : '');
}
async function waitFor(fn, timeout = 5000, step = 100) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (fn()) return true; } catch { /* retry */ } await sleep(step); }
  return false;
}
class Real {
  constructor(label) { this.label = label; this.client = new Client(URL_); this.seq = 0; }
  async online() { this.room = await this.client.joinOrCreate('city', { protocol: PROTOCOL_VERSION, mode: 'public' }); return this.wire(); }
  async create() { this.room = await this.client.create('city', { protocol: PROTOCOL_VERSION, mode: 'private' }); return this.wire(); }
  async join(code) { this.room = await this.client.joinById(code, { protocol: PROTOCOL_VERSION }); return this.wire(); }
  async wire() {
    this.messages = [];
    this.room.onMessage('*', (type, payload) => this.messages.push({ type, payload }));
    if (!this.room.state?.players) await new Promise(r => this.room.onStateChange.once(r));
    return this.room;
  }
  get s() { return this.room.state; }
  idle() { this.seq++; this.room.send('input', { i: [[this.seq, 0, 0, 0]] }); }
  async leave() { try { await this.room.leave(true); } catch { /* gone */ } }
}

async function main() {
  const t0 = Date.now();
  const reals = new Set();
  const A = new Real('A');
  await A.online(); reals.add(A.room.sessionId);
  const botIds = () => [...A.s.players.keys()].filter(id => !reals.has(id));
  const bots = () => botIds().map(id => A.s.players.get(id));

  /* fill */
  await waitFor(() => A.s.players.size === FILL, 15000);
  check(`B1 a lone real player gets company: room filled to ${FILL} couriers`, A.s.players.size === FILL, `size ${A.s.players.size}`);
  check('B1 bots never block real players (still joinable)', A.s.joinable === true);
  const names = bots().map(p => p.name);
  check('B2 bots have ordinary-looking, unique names', names.length === FILL - 1 && new Set(names).size === names.length && names.every(n => n.length >= 4 && !/bot/i.test(n)), names.join(', '));
  check('B2 bots are active couriers with a normal skin', bots().every(p => p.role === 'active' && (p.skin === 1 || p.skin === 2) && p.connected));

  /* movement + deliveries, watched over time */
  const start = new Map(bots().map(p => [p.sessionId, { x: p.x, z: p.z }]));
  const lastMove = new Map(), stuckFor = new Map();
  let sawCarry = false, sawJump = false, sawRun = false, sawEmote = false;
  const watch = setInterval(() => {
    A.idle();
    const now = Date.now();
    for (const p of bots()) {
      if (p.carrying) sawCarry = true;
      if (p.air) sawJump = true;
      if (p.anim === 'run') sawRun = true;
      if (p.emote) sawEmote = true;
      const lm = lastMove.get(p.sessionId);
      if (!lm || Math.hypot(p.x - lm.x, p.z - lm.z) > 1) lastMove.set(p.sessionId, { x: p.x, z: p.z, t: now });
      else if (A.s.phase !== 'results') stuckFor.set(p.sessionId, Math.max(stuckFor.get(p.sessionId) || 0, now - lm.t));
    }
  }, 1000 / NET.tickRate);
  await sleep(8000);
  const moved = bots().filter(p => start.has(p.sessionId) && Math.hypot(p.x - start.get(p.sessionId).x, p.z - start.get(p.sessionId).z) > 3).length;
  check('B3 bots walk around the city (server-simulated inputs)', moved >= 2 && sawRun, `${moved} moved`);
  await waitFor(() => sawCarry, 30000);
  check('B4 bots pick up packages', sawCarry);
  console.log('   … watching bots deliver');
  await waitFor(() => bots().some(p => p.deliveries > 0), 90000, 250);
  check('B5 bots deliver packages and score like players', bots().some(p => p.deliveries > 0 && p.score > 0), bots().map(p => `${p.name}:${p.deliveries}`).join(' '));

  /* real players take bot seats */
  const B = new Real('B');
  await B.join(A.room.roomId); reals.add(B.room.sessionId);
  await waitFor(() => A.s.players.size === FILL && botIds().length === FILL - 2, 3000);
  check('B7 a second real player replaces a bot (total stays the same)', A.s.players.size === FILL && botIds().length === FILL - 2, `size ${A.s.players.size}, bots ${botIds().length}`);
  check('B7 the newcomer plays right away', B.s.players.get(B.room.sessionId)?.role === 'active');
  const more = [];
  for (let i = 0; i < GAME.maxPlayers - 2; i++) { const r = new Real('R' + i); await r.join(A.room.roomId); reals.add(r.room.sessionId); more.push(r); }
  await waitFor(() => botIds().length === 0 && A.s.players.size === GAME.maxPlayers, 3000);
  check('B8 a full room of real players has no bots', botIds().length === 0 && A.s.players.size === GAME.maxPlayers);
  check('B8 joinable=false only when 6 REAL players are in', A.s.joinable === false);
  let refused = null;
  try { await new Real('X').join(A.room.roomId); } catch (e) { refused = e; }
  check('B8 a 7th real player is refused', !!refused);

  /* reals leave → bots come back */
  for (const r of more) { reals.delete(r.room.sessionId); await r.leave(); }
  reals.delete(B.room.sessionId); await B.leave();
  await waitFor(() => A.s.players.size === FILL && botIds().length === FILL - 1, 20000);
  check('B9 when real players leave, bots come back (one at a time, like new players)', A.s.players.size === FILL && botIds().length === FILL - 1, `size ${A.s.players.size}`);

  /* the rush: bots compete, results include them, they react like people */
  console.log(`   … waiting for the Delivery Rush (${A.s.phase})`);
  await waitFor(() => A.s.phase === 'delivery_rush', 90000, 200);
  await waitFor(() => [...A.s.packages.values()].some(p => p.type === 'golden' && p.ownerId), 45000, 200);
  const gold = [...A.s.packages.values()].find(p => p.type === 'golden');
  check('B10 bots race for the Golden Package', !!gold && !!gold.ownerId && !reals.has(gold.ownerId), gold ? `owner ${gold.ownerId}` : 'no golden');
  await waitFor(() => A.s.phase === 'results', 120000, 200);
  const res = [...A.s.results];
  check('B11 bots appear in the rush results like everyone else', res.length === FILL && res.some(r => !reals.has(r.sessionId) && r.score > 0), res.map(r => `${r.name}:${r.score}`).join(' '));
  await sleep(4500);
  const social = A.messages.filter(m => m.type === 'chat' && !reals.has(m.payload.sid)).length + (sawEmote ? 1 : 0);
  const ems = A.messages.filter(m => m.type === 'chat').map(m => m.payload.id);
  check('B12 bots use quick chat / emotes at moments (GG, hello, …)', social > 0 || ems.length > 0, `chat ids ${ems.join(',')}`);
  clearInterval(watch);
  check('B6 bots jump now and then', sawJump);
  const worst = Math.max(0, ...stuckFor.values());
  check('B13 no bot stood stuck for long (> 15 s without moving 1 m)', worst < 15000, `worst ${Math.round(worst / 1000)} s`);

  /* private rooms get bots too, and the last real leaving clears them */
  const P = new Real('P');
  await P.create();
  await waitFor(() => P.s.players.size === FILL, 15000);
  check('B14 a private room (e.g. instant multiplayer) also gets bots until friends arrive', P.s.players.size === FILL);
  const code = A.room.roomId;
  await A.leave(); await P.leave();
  await sleep(1500);
  let gone = null;
  try { await new Real('Z').join(code); } catch (e) { gone = e; }
  check('B15 the room closes when the last real player leaves (bots don\'t keep it alive)', !!gone);

  console.log(`\n${lines.join('\n')}\n\n${passed} passed, ${failed} failed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(failed ? 1 : 0);
}
main().catch(err => { console.error('Test run crashed:', err); process.exit(2); });
