/* =====================================================================
   DISASTER DELIVERY — server entry point
   `listen()` from @colyseus/tools (re-exported by colyseus) handles both
   environments: a normal port locally (PORT or 2567) and the unix socket +
   PM2 "ready" signal that Colyseus Cloud expects.
   No top-level await, so PM2 can load this file with require() or import().
   ===================================================================== */
import { listen } from 'colyseus';
import { server, CONFIG } from './game-server.js';

listen(server).then(() => {
  console.log(`[server] Disaster Delivery up (region ${CONFIG.region}, ${process.env.COLYSEUS_CLOUD !== undefined ? 'Colyseus Cloud socket' : `port ${process.env.PORT || 2567}`}, ${process.env.REDIS_URI ? 'redis' : 'local'} presence)`);
  console.log(`[server] allowed origins: ${CONFIG.allowedOrigins.join(', ')}${CONFIG.allowEmptyOrigin ? ' (+ empty origin)' : ''}`);
}).catch(err => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
