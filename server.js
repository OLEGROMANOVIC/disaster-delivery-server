/* =====================================================================
   DISASTER DELIVERY — server entry point
   `listen()` from @colyseus/tools (re-exported by colyseus) handles both
   environments: a normal port locally (PORT or 2567) and the unix socket +
   PM2 "ready" signal that Colyseus Cloud expects.
   ===================================================================== */
import { listen } from 'colyseus';
import { server, CONFIG } from './game-server.js';

await listen(server);
console.log(`[server] Disaster Delivery up (region ${CONFIG.region}, ${process.env.COLYSEUS_CLOUD !== undefined ? 'Colyseus Cloud' : `port ${process.env.PORT || 2567}`})`);
console.log(`[server] allowed origins: ${CONFIG.allowedOrigins.join(', ')}${CONFIG.allowEmptyOrigin ? ' (+ empty origin)' : ''}`);
