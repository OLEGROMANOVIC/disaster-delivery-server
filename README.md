# Disaster Delivery — Milestone 2 (Colyseus multiplayer + CrazyGames SDK v3)

## Files

```text
DisasterDelivery/
├── index.html          browser client (Three.js, Colyseus SDK, CrazyGames SDK v3)
├── shared.js           shared by client AND server: city layout, colliders, movement step, rules
├── server.js           server entry point (local port or Colyseus Cloud socket)
├── game-server.js      Colyseus 0.18 room, schemas, matchmaking, validation
├── ecosystem.config.cjs PM2 process file required by Colyseus Cloud
├── test-multiplayer.js automated multi-client tests against a running server
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
- **Matches.** 4 minutes of play, then 12 seconds of results, then the next match in the *same room* with the same group. Scores, packages and spawn positions reset each match.
  - Late joiners spectate until the next round once the match has run 45 s and at least 2 couriers are playing.
  - A friend joining a host who is alone plays immediately.
- **Deliveries.**
  - 6 packages sit on the depot pads: box 100, groceries 150, VIP 500 (edit `PACKAGE_TYPES` in `shared.js`).
  - **E** picks up or delivers. The server checks distance, ownership and destination, and only the server changes scores.
  - Each package has a destination building, shown with a beam, arrow and ground ring.
- **Disconnects.**
  - A dropped connection keeps its seat for 20 s, and the Colyseus SDK reconnects automatically.
  - A consented leave, or a seat that expires, removes the player and puts any carried package back in rotation.
  - The room disposes itself when empty.
- **Quick chat.** **Q** opens it, **1–5** send one of five predefined phrases. No free text. Other players' phrases are hidden if CrazyGames' `disableChat` setting is on.

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
| Gameplay events | `gameplayStart()` only while you are an active courier in a running round. `gameplayStop()` in menus, results, spectating and while reconnecting. `loadingStart/Stop` during asset loading. No ads are requested. |

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
5. **Match loop fast:** stop the server and run `npm run test:server` (45 s matches). On Windows PowerShell, set the variables first: `$env:MATCH_SECONDS=45; npm start`.
6. **Disconnects:** turn Wi-Fi off and back on within 20 s; you reconnect into the same body. Close a tab; the courier disappears for others after the reconnect window.
7. **CrazyGames flows without the platform (localhost only):**
   - `?cgMock=1&cgInstant=1` simulates instant multiplayer.
   - `?cgMock=1&cgInvite=CODE&cgRegion=local` simulates a startup invite.
   - In the console, `DD.simulateInvite('CODE')` fires the join-room listener.
   - `DD.stats()` shows prediction corrections.
8. **Real SDK:** upload to the CrazyGames Developer Portal and use the **Preview / QA tool**. This is the only way to test real friends, invites and token verification.

Automated server tests (real Colyseus clients):

```bash
npm run test:server            # terminal 1 (short timers)
npm test                       # terminal 2
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
4. Check that each region runs the new build: open `https://de-fra-16001d69.colyseus.cloud/health` and `https://us-ord-c5ea260f.colyseus.cloud/health`. Both should return `{"ok":true,...,"protocol":1}`. Anything else (404, a different page) means an older build is still deployed.

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

Verified here:
- 48 automated server checks (node clients).
- 27 checks in two to four real headless Chrome windows against a local server. These used a stub that mimics the documented SDK v3 calls, not the real SDK.

Still requires CrazyGames-side testing:
- Real friend invites, instant multiplayer from the CrazyGames UI, and token verification with real accounts.
- The actual hosting origins.
- Submitting lobby size 6 with the build.

Not done yet:
- Pure spectating of a *full* room (a full room is refused instead).
- Vendoring the CDN scripts locally.
- Mobile/touch controls.
