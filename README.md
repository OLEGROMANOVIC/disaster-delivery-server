# Disaster Delivery — Milestone 4 (continuous city + Delivery Rush)

## Files

```text
DisasterDelivery/
├── index.html          browser client (Three.js, Colyseus SDK, CrazyGames SDK v3)
├── shared.js           shared by client AND server: city layout, colliders, movement step, rules
├── server.js           server entry point (local port or Colyseus Cloud socket)
├── game-server.js      Colyseus 0.18 room, schemas, matchmaking, validation
├── ecosystem.config.cjs PM2 process file required by Colyseus Cloud
├── test-multiplayer.js automated multi-client tests against a running server (M2 + lifecycle)
├── test-milestone3.js  disaster / package condition / truck scenarios
├── test-milestone4.js  continuous city, jumping, knockback, props, social, Golden Package, parkour
├── reachability.js     walkability + path helper used by the M4 tests (not needed by the game)
├── package.json / package-lock.json
├── .env.example        server configuration
├── .gitignore
└── *.glb               unchanged, still next to index.html
```

Versions: **colyseus 0.18.12**, **@colyseus/schema 5.0.x**, **@colyseus/sdk 0.18.10** (browser bundle from jsDelivr), **CrazyGames HTML5 SDK v3**, Three.js 0.160, Node.js ≥ 22.

## How it works

- **Rooms.** `city` room, max 6. Public rooms use `joinOrCreate` with `filterBy(['mode'])`. Private rooms use `create` + `setPrivate(true)`, so matchmaking never sees them. The 6-character room code *is* the Colyseus `roomId`, so `joinById(code)` works on any process.
- **Authority.** Clients only send movement inputs (`{seq, direction, sprint}`) at 30 Hz. The server validates and quantizes them, rate-limits them with a per-tick budget (speed hacks can't move faster), and runs the same `stepMovement()` from `shared.js` against the same colliders. It syncs position, velocity, rotation, animation state and the last processed input (`ack`) at 20 Hz.
- **Prediction.** The local player moves instantly. Each server update rewinds to the authoritative state and replays any unacknowledged inputs, with error smoothing. Remote players are interpolated 110 ms in the past.
- **Continuous city (Milestone 4).** The room never ends. It loops free play → rush warning → Delivery Rush → results → intermission → free play, with the same group (details below).
  - Late joiners spectate only when a Delivery Rush has run 45 s and at least 2 couriers are playing; they get a body when the rush ends.
  - A friend joining a host who is alone plays immediately.
- **Deliveries.**
  - 6 packages sit on the depot pads: box 100, groceries 150, VIP 500 (edit `PACKAGE_TYPES` in `shared.js`).
  - **E** picks up or delivers. The server checks distance, ownership and destination, and only the server changes scores.
  - Each package has a destination building, shown with a beam, arrow and ground ring.
- **Disconnects.**
  - A dropped connection keeps its seat for 20 s, and the Colyseus SDK reconnects automatically.
  - A consented leave, or a seat that expires, removes the player and puts any carried package back in rotation.
  - The room disposes itself when empty.
- **Quick chat / emotes.** **T** opens an 8-phrase quick-chat wheel, **G** a 5-gesture emote wheel (Milestone 4). No free text. Quick chat is hidden entirely if CrazyGames' `disableChat` setting is on.

### CrazyGames integration (in `index.html`, class `Platform`)

| Requirement | Implementation |
|---|---|
| SDK init | `await SDK.init()` with an 8 s timeout. If init fails or `environment === 'disabled'`, every call becomes a safe no-op and the game still runs. |
| Usernames | `user.getUser()` shows the name in the menu. A fresh `user.getUserToken()` is sent on every join. The server verifies it as RS256 against `https://sdk.crazygames.com/publicKey.json`, and only then uses the CrazyGames username. Guests get a server-generated `Courier###`. Tokens are never stored or synced. |
| Room reporting | `game.updateRoom({ roomId: "<region>-<code>", isJoinable, inviteParams: { roomId: code, region } })` is called on join and whenever the server's `joinable` flag changes. `leftRoom()` is called on leave or disconnect. |
| Instant multiplayer | When `game.isInstantMultiplayer` is true, the menu is skipped and a private room is created immediately. |
| Invite at startup | Valid `game.inviteParams` → join that exact room by code, skip the menu, use the stored or default character. |
| Invite while playing | One `addJoinRoomListener` is registered. It leaves the current room cleanly and joins the invited one. Overlapping requests are queued (latest wins). |
| Invite link | The INVITE FRIENDS button uses `game.inviteLink(...)`. Without the SDK it copies the room code instead. |
| Gameplay events | `gameplayStart()` while you are an active courier in free play, the rush warning or a Delivery Rush. `gameplayStop()` in menus, results, intermission, spectating and while reconnecting (no tab-visibility gating). `loadingStart/Stop` during asset loading. No ads are requested. |

## Milestone 3 — disasters, package condition, trucks

**Disasters** (`DisasterController` in `game-server.js`, settings in `DISASTER` in `shared.js`):
- *Milestone 4:* a rolling schedule runs through free play and the Delivery Rush (first event 25 s after a room opens or a break ends; then a 30 s gap in free play, 16 s in a rush). Results and intermission stop and clear it. An event never starts if it would run past the end of the rush.
- Phases: `inactive → warning (10 s) → active (tornado 30 s / flood 35 s) → recovery (6 s)`. Types alternate.
- Everything is in synced state (`state.disaster`). Players who join mid-disaster see it straight away.
- **Tornado:** moves along the road grid on a server-chosen path at 6.5 m/s.
  - Players within 13 m get a capped, decaying push (outward plus swirl), with 2.5 s of protection after a direct hit.
  - Carried cargo loses condition inside the 6 m danger radius. A hit in the 3 m core knocks the package out of your hands.
  - Light packages on the ground drift up to 8 m; heavy ones barely move. Cargo in a truck inside the funnel is damaged too.
  - The client draws a layered funnel with orbiting debris and a dust ring.
- **Flood:** the server floods 3 of the 9 predefined road zones (`FLOOD_ZONES`, ids F1–F9). The water rises over 4 s and drains during recovery.
  - Walking speed: 55% in shallow water, 40% in deep water. Trucks: 70% in shallow water; deep water blocks entry.
  - Water-sensitive packages lying in water lose condition. Packages carried above the water are safe.

**Packages:** the table is `PACKAGE_TYPES` in `shared.js`. Points, weight, fragility, water sensitivity and spawn chance are all editable.

| Package | Points | Weight | Fragile | Water-sensitive |
|---|---:|---|---|---|
| Box | 100 | Light | – | – |
| Groceries | 150 | Light | ✓ | ✓ |
| Wooden crate | 250 | Medium (85% speed) | – | – |
| Aquarium | 650 | Medium | ✓ | – |
| Sofa | 500 | Heavy (60% speed, no sprint, 2 truck slots) | – | ✓ |
| Piano | 900 | Very heavy (**truck only**, 3 slots) | ✓ | ✓ |
| VIP box | 1200 | Medium | ✓ | ✓ |

- Condition runs from 100 to 0. Reward = `base × (0.5 + 0.5 × condition/100)`. At 0 the package breaks: it disappears, a fresh one restocks, and nobody scores.
- Damage sources: the tornado, flood water while on the ground, dropping a fragile package (**Q** since M4) while running, and truck crashes above 7 m/s with fragile cargo.
- A package left on the ground for 60 s returns to a free depot pad.

**Trucks** (`T1`, `T2`, parked at the depot): the driving model is `stepVehicle()` in `shared.js`, shared by the client's prediction and the server.
- **E** near a cab door enters; **WASD** drives; **Space** brakes; **E** exits when slow (the server finds a free spot beside the truck). **R** returns an empty truck to the depot (30 s cooldown).
- Max speed is 16 m/s (58 km/h). The HUD shows km/h.
- Cargo holds 3 slots. Standing at the cargo door (back of the truck), **E** loads what you carry, takes cargo out, or, at a destination, unloads and delivers directly.
- Pianos load straight from the ground when a stopped truck's cargo door is within 5 m.
- Only the driver's inputs move a truck. If the driver drops, the truck stops; their seat is released after the reconnect window. Idle empty trucks return to the depot after 90 s.

**Smoothness & minimap (update):**
- The simulation runs at 30 Hz. The client draws in between the last two simulation steps, so motion is even on 60, 120 and 144 Hz screens. Before this, half or more of the displayed frames repeated the previous position.
- The server paces inputs by real time, so a slow tick on a shared cloud CPU can't build up input lag.
- Trucks: stronger launch that tapers near top speed (17 m/s), eased steering, sliding along walls instead of bouncing, body lean and dip, and a field of view that widens with speed.
- Minimap (bottom-right): heading-up and circular. Shows flooded roads, the tornado's danger zone, packages, trucks, couriers, your destinations (with edge arrows when off-map) and north. It zooms out while driving.

**Not done in this milestone:**
- Cooperative two-person carrying. The spec allowed deferring it in favour of trucks.
- Fall-height damage. The city has no drops yet.
- Sound effects.

The truck model's orientation is assumed to be +Z forward. If it drives sideways, set `rotationY` for `cargotruck` in `ASSET_CONFIG` (for example `Math.PI / 2`).

## Milestone 4 — continuous city, Delivery Rush, jumping, knockback, props, social

**Lifecycle** (`setPhase` / `advancePhase` in `game-server.js`; `CYCLE` in `shared.js`; all timestamps are server epoch ms in state):

| Phase | Default | What happens |
|---|---|---|
| `free_play` | 90 s for a new room, then 45 s | Deliveries count for the session score. Hazards on. HUD: "Free play · next rush in". |
| `rush_warning` | 10 s | Banner + countdown. Still free play rules. |
| `delivery_rush` | 240 s | `rushScore`/`rushDeliveries`/`rushBest` reset at the start and count only during the rush. Live rush standings + your position. Golden Package. |
| `results` | 15 s | Podium, all scores, deliveries, best delivery, personal best (session), golden winner. Movement frozen, interactions refused, no hazards or knockback. |
| `intermission` | 20 s | A break without a menu: the city stays explorable, no hazards, no deliveries. |

- The session `score` is kept across rushes; nothing is persisted (no coins, XP, garage).
- `endRush` calls `onRushRewards(results)`, which only computes a preview through `computeRushRewards()` (`granted: false`). Milestones 5/6 can grant and persist rewards there.
- **Ad-ready break hook:** during intermission a client can send `busy {busy:true}` (and `breakReady` / `busy {busy:false}`). Free play waits for busy clients for at most `BREAK_MAX_EXTRA_WAIT_SECONDS` (8 s). The server never pauses. Client side: `game.setBreakBusy(true/false)` (or `DD.setBreakBusy` in the console).

**Jumping (Space):**
- About 1.4 m high, one jump (no double jump), limited air control. Ground detection includes the tops of crates, containers and parkour pieces (`supportHeight()` in `shared.js`).
- Simulated by the shared `stepMovement()`: the client predicts it and the server validates it. Input flag bit 4 = jump.
- Heavy and very heavy cargo can't jump. Stunned couriers can't move or jump.
- **No jump clip exists in the GLBs**, so the airborne pose is procedural: the run stride is nearly frozen, plus a lean and squash/stretch. A clip whose name contains `jump`/`leap`/`fall` is used automatically if you add one.

**Knockback** (server only; `KNOCKBACK` in `shared.js`):
- Sources: a moving truck (≥ 3 m/s) hitting a courier, rolling platform carts / pallet jacks (≥ 3.2 m/s, never their own pusher), and the tornado core (launch + 0.9 s stun).
- Every hit is a capped impulse (≤ 12) plus an upward launch and a short stun, with a 0.9 s cooldown and 1.6 s protection afterwards.
- Never during results or intermission, and never the driver. Couriers don't shove each other (anti-grief). Truck hits don't make you drop cargo.
- The client shows a stumble (lean back + wobble), stars, camera shake and a toast.

**Interactive props** (`state.props`, `stepProp()` in `shared.js`):
- 19 traffic cones, 5 wooden crates, the platform cart and the pallet jack are server-owned dynamic objects. Couriers bump into them like trucks.
- Walking into one pushes it: cones fly, crates slide slowly, carts roll far. Trucks plough through them.
- A prop left more than 3 m from home for 60 s goes back, but never while anyone is within 8 m of it or of its home.

**Social:**
- **T** opens a quick-chat wheel with 8 presets (Hello!, Follow me!, Help me!, Nice!, Thanks!, Watch out!, Let's deliver!, GG!), 1.5 s cooldown.
- **G** opens an emote wheel (Wave, Dance, Cheer, Point, Laugh). The emote id plus its server start time are synced; moving, jumping, a hit or driving interrupts it.
- Pick with 1-8 or the mouse; Esc closes. The mouse is freed while a wheel is open and re-locked after picking.
- **Drop moved to Q.**
- **No emote clips exist in the GLBs** (character1 has `agree`/`run`-style clips only). Gestures are procedural: arm/spine/head bones are rotated when the rig exposes them (Mixamo/Blender/Unity names), and there is whole-body motion either way. Clips named `wave`, `dance`, `cheer`, `point` or `laugh` are used automatically if present.

**Golden Package** (`GOLDEN` in `shared.js`):
- At most one per rush, 45–100 s in, at one of 6 city spots (never the depot). It is announced with a banner and feed message, and marked by a gold light pillar and a gold minimap star.
- The first courier to pick it up owns it. Nobody else can take it, even after a drop.
- It must be carried on foot (it can't be loaded into a truck). The destination is at least 70 m away. Reward is 2000 base, condition-based.
- It disappears after 75 s or when the rush ends. The winner is flagged in the results.

**Parkour shortcuts** (static, `L.parkour` in `buildLayout()`; colliders tagged `parkour`):
1. **Alley hurdles:** the west block's alley crossing is fenced by 0.7 m hurdles. Jump them to cut through the block instead of walking around it.
2. **Construction scaffold:** the east block's alley crossing is a fenced building site. Scaffold steps lead over the 2.2 m fence on both sides.
3. **Depot crate steps:** crate steps climb a crate wall west of the warehouse, a quick hop out toward the north road.

All delivery doors and golden spots stay reachable on foot without jumping (checked by the tests), and the parkour areas are only reachable by jumping. Trucks keep to the streets.

**Effects (client only):** one pooled instanced particle system for landing dust, knockback stars, pickup sparkles, delivery confetti and golden sparkles, plus modest camera shake on hits and hard landings.

## Local testing

```bash
npm install
npm start                      # Colyseus on ws://localhost:2567
npx serve .                    # in a 2nd terminal: static client, e.g. http://localhost:3000
```

Open `http://localhost:3000/?local=1` in **two browser windows**. With `?local=1`, the page connects to `ws://<same host>:2567`; without it, it uses the Colyseus Cloud servers. Add `?server=ws://host:port` to override.

Manual checks:

1. **Movement / skins / animations:** pick Character 1 in window A and Character 2 in window B, then PLAY ONLINE in both. Each window should show the other courier running and idling with the correct skin.
2. **Private rooms:** CREATE PRIVATE ROOM in A, read the code from the HUD, then type it and press JOIN in B.
3. **Room separation:** create a second private room in a third window. Nobody from the first room should appear.
4. **Packages / scoring:** walk to a blue pad and press **E**. B sees the box on A's character. Follow the beam and press **E** at the ring. Both leaderboards update.
5. **Rush loop fast:** stop the server and run `npm run test:server` (4 s free play, 60 s rush). On Windows PowerShell, set the variables first, e.g. `$env:FIRST_FREE_PLAY_SECONDS=10; $env:RUSH_SECONDS=60; npm start`.
6. **Disconnects:** turn Wi-Fi off and back on within 20 s; you reconnect into the same body. Close a tab; the courier disappears for others after the reconnect window.
7. **CrazyGames flows without the platform (localhost only):**
   - `?cgMock=1&cgInstant=1` simulates instant multiplayer.
   - `?cgMock=1&cgInvite=CODE&cgRegion=local` simulates a startup invite.
   - In the console, `DD.simulateInvite('CODE')` fires the join-room listener.
   - `DD.stats()` shows prediction corrections.
8. **Real SDK:** upload to the CrazyGames Developer Portal and use the **Preview / QA tool**. This is the only way to test real friends, invites and token verification.

Milestone 3 scenarios (each needs the server started with the settings at the top of `test-milestone3.js`):

```bash
RUSH_SECONDS=300 DISASTER_TYPES=none PACKAGE_POOL=groceries DROP_DAMAGE=60 RECONNECT_SECONDS=3 npm start    # terminal 1
SCENARIO=trucks npm run test:m3                                                                             # terminal 2
```

Manual checks in two windows: pick up a package and watch the condition bar. Load it into a truck (cargo door at the back), drive, and get out. Wait 40 s for the first disaster warning; both windows should show the same tornado or the same flooded roads.

Automated server tests (real Colyseus clients):

```bash
npm run test:server            # terminal 1 (short timers)
npm test                       # terminal 2

npm run test:m4server          # Milestone 4: terminal 1
npm run test:m4                # terminal 2 (UNIT_ONLY=1 npm run test:m4 runs just the unit checks, no server)
```

## Production deployment — Colyseus Cloud (EU Frankfurt + US Chicago)

The client is already configured for both regions:

| Region key | Endpoint |
|---|---|
| `eu` | `https://de-fra-16001d69.colyseus.cloud` |
| `us` | `https://us-ord-c5ea260f.colyseus.cloud` |

- **New rooms** (PLAY ONLINE / CREATE PRIVATE ROOM / instant multiplayer) go to whichever region answers the latency ping fastest. `?region=eu` or `?region=us` forces one.
- **Invites** carry `{ roomId, region }`, so a friend always lands in the inviter's region, even from the other continent. The CrazyGames room id is `"<region>-<code>"`, which keeps it unique across regions.
- **Typed codes** try the closest region first, then the other one.

### Deploy the server code (both regions)

1. Make the project a git repository: `git init`, then `git add .` and `git commit -m "milestone 2"`.
   - `.gitignore` already excludes `node_modules` and `.env`; a committed `node_modules` breaks Cloud builds.
   - The `.glb` files aren't needed on the server. If deploys are slow, keep the server code in its own repo, or move it to a folder and set "Root Directory" in the Cloud build settings.
2. Run `npx @colyseus/cloud deploy` and pick your application. It creates `.colyseus-cloud.json`, which holds deploy credentials; keep it private.
   - Cloud runs `npm install`, then `npm run build` (a syntax check here), then starts `server.js` through `ecosystem.config.cjs`.
3. In the application's environment variables, set:
   - `ALLOWED_ORIGINS=.crazygames.com,localhost,127.0.0.1`. Drop the localhost entries once you've finished testing from your machine.
   - Optionally `CRAZYGAMES_GAME_ID=<your id>`.
   - `REGION` isn't needed: the client tags the region itself.
4. Check that each region runs the new build: open `https://de-fra-16001d69.colyseus.cloud/health` and `https://us-ord-c5ea260f.colyseus.cloud/health`. Both should return `{"ok":true,...,"protocol":4}` (Milestone 4). Anything else (404, a different page) means an older build is still deployed.

### Test against the live servers from your PC

```bash
npx serve .        # then open http://localhost:3000 in two windows
```

- Add `&region=us` in one window and `&region=eu` in the other to exercise both regions.
- CREATE PRIVATE ROOM in Chicago and join its code from a Frankfurt-default window: the typed-code fallback finds it.
- The browser console logs the measured latency per region.

### Upload to CrazyGames

Upload `index.html`, `shared.js` and the `.glb` files only (not `server.js`, `game-server.js` or `node_modules`). All paths are relative. During the Preview test, check the Colyseus Cloud logs for `rejected origin` lines and add any CrazyGames origin that shows up to `ALLOWED_ORIGINS`.

### Scaling later

Each region runs one process (`instances: 1`), which fits the 1 shared vCPU plans. On Colyseus Cloud the server automatically uses the platform's Redis presence/driver. More instances per region need nothing in the game code beyond raising `instances`.

## Status: implemented vs still needs platform testing

Verified here (Milestone 4 build, all run against a local server):
- Node clients:
  - `test-multiplayer.js`: 52/52, including the new lifecycle checks.
  - `test-milestone3.js`: tornado 24/24, flood 17/17, trucks 31/31.
  - `test-milestone4.js`: 54/54, i.e. 17 unit checks and 37 live checks.
- Headless Chrome against the local server, using a stub that mimics the documented CrazyGames SDK v3 calls (not the real SDK):
  - M4 browser suite: 22/22.
  - M3 browser suite: 20/20.
  - M2 browser suite: 26-27/27. Its "remote animation = run at 500 ms" check is timing-sensitive at the ~3 FPS of software rendering. Measured input→server latency is the same as the Milestone 3 build (~0.9 s in that sandbox).
- The real GLB models were not available in the test sandbox, so the tests ran with placeholder shapes. Procedural emote bone gestures in particular need checking with the real characters.

Still requires CrazyGames-side testing:
- Real friend invites, instant multiplayer from the CrazyGames UI, and token verification with real accounts.
- The actual hosting origins.
- Submitting lobby size 6 with the build.

Not done yet:
- Pure spectating of a *full* room (a full room is refused instead).
- Vendoring the CDN scripts locally.
- Mobile/touch controls (no touch jump / wheel yet).
- Sound effects.
- Permanent economy (coins, XP, garage) — by design, Milestones 5/6.
