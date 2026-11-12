/* Walkability check (no jumping): flood-fill a 0.5 m grid from the depot and report
   which delivery doors / golden spots can be reached on foot. Used by test-milestone4.js. */
import { buildLayout, createPhysicsWorld, PLAYER, MAP, GOLDEN } from './shared.js';
export function reachability(layout = buildLayout()) {
  const W = createPhysicsWorld(layout);
  const step = 0.5, half = MAP.playHalf, N = Math.floor((half * 2) / step) + 1;
  const idx = (i, j) => i * N + j, toW = i => -half + i * step;
  const free = new Uint8Array(N * N);
  const r = PLAYER.radius;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = toW(i), z = toW(j), g = W.groundHeight(x, z);
    let ok = true;
    for (const c of layout.colliders) {
      if (c.maxY <= g + 0.4) continue;                 // low enough to walk/step over
      const qx = Math.max(c.minX, Math.min(x, c.maxX)), qz = Math.max(c.minZ, Math.min(z, c.maxZ));
      if ((x - qx) ** 2 + (z - qz) ** 2 < r * r) { ok = false; break; }
    }
    free[idx(i, j)] = ok ? 1 : 0;
  }
  const seen = new Uint8Array(N * N);
  const cell = v => Math.round((v + half) / step);
  const start = [cell(layout.depot.cx), cell(layout.depot.cz + 3)];
  const q = [start]; seen[idx(...start)] = 1;
  while (q.length) {
    const [i, j] = q.pop();
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= N || b >= N) continue;
      const k = idx(a, b);
      if (seen[k] || !free[k]) continue;
      seen[k] = 1; q.push([a, b]);
    }
  }
  const reachable = (x, z) => {
    const ci = cell(x), cj = cell(z);
    for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) { const a = ci + di, b = cj + dj; if (a >= 0 && b >= 0 && a < N && b < N && seen[idx(a, b)]) return true; }
    return false;
  };
  return {
    doors: layout.buildings.map(b => ({ id: b.id, ok: reachable(b.doorX, b.doorZ) })),
    golden: GOLDEN.spots.map(s => ({ ...s, ok: reachable(s.x, s.z) })),
    reachable
  };
}

/* Grid path (no jumping) for test bots: returns waypoints from `from` to `to`, or null. */
export function findPath(layout, from, to, clearance = 0.75) {
  const W = createPhysicsWorld(layout);
  const step = 0.5, half = MAP.playHalf - 0.5, N = Math.floor((half * 2) / step) + 1;
  const idx = (i, j) => i * N + j, toW = i => -half + i * step, cell = v => Math.max(0, Math.min(N - 1, Math.round((v + half) / step)));
  const free = new Uint8Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = toW(i), z = toW(j), g = W.groundHeight(x, z);
    let ok = true;
    for (const c of layout.colliders) {
      if (c.maxY <= g + 0.4) continue;
      const qx = Math.max(c.minX, Math.min(x, c.maxX)), qz = Math.max(c.minZ, Math.min(z, c.maxZ));
      if ((x - qx) ** 2 + (z - qz) ** 2 < clearance * clearance) { ok = false; break; }
    }
    free[idx(i, j)] = ok ? 1 : 0;
  }
  const s = [cell(from.x), cell(from.z)], t = [cell(to.x), cell(to.z)];
  free[idx(...s)] = 1; free[idx(...t)] = 1;
  const prev = new Int32Array(N * N).fill(-1);
  const q = new Int32Array(N * N); let qh = 0, qt = 0;
  q[qt++] = idx(...s); prev[idx(...s)] = idx(...s);
  const goal = idx(...t);
  while (qh < qt) {
    const k = q[qh++]; if (k === goal) break;
    const i = (k / N) | 0, j = k % N;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= N || b >= N) continue;
      const n = idx(a, b);
      if (prev[n] !== -1 || !free[n]) continue;
      if (di && dj && (!free[idx(i + di, j)] || !free[idx(i, j + dj)])) continue;   // no corner cutting
      prev[n] = k; q[qt++] = n;
    }
  }
  if (prev[goal] === -1) return null;
  const cells = [];
  for (let k = goal; ; k = prev[k]) { cells.push(k); if (prev[k] === k) break; }
  cells.reverse();
  // keep every 6th cell + turns → waypoints
  const pts = [];
  for (let n = 0; n < cells.length; n += 6) pts.push([toW((cells[n] / N) | 0), toW(cells[n] % N)]);
  pts.push([to.x, to.z]);
  return pts;
}
